require('dotenv').config();

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('./middleware/compression');
const prom = require('prom-client');
const { db, redis, connectRedis, closeRedis } = require('./db');
const { startWorker, stopWorker } = require('./services/queue');
const logger = require('./logger');
const requestLogger = require('./middleware/requestLogger');
const clientRoutes = require('./routes/client');
const authRoutes  = require('./routes/authentication');
const adminRoutes = require('./routes/admin');
const { implementedFunctions } = require('./services/cloudscript');
const { ensureAdminSeed, verifyAccessToken, parseCookies, getAdminByEmail } = require('./services/adminSecurity');
const { getOverview } = require('./services/adminOps');
const { runMigrations } = require('./services/migrations');
const { seedIfEmpty, refreshAppLocals } = require('./services/economy');

const titleId = String(process.env.TITLE_ID || '').trim();
const appName = process.env.APP_NAME || 'Game Backend';

const app = express();
prom.collectDefaultMetrics();
const register = prom.register;

app.disable('x-powered-by');
app.set('trust proxy', 1);
// Catalog / Stores / Title Data are seeded into Postgres on first boot
// (from src/data/*.json) and loaded live below in start(); they are no
// longer static requires, so admin edits take effect immediately without
// a restart. See src/services/economy.js.
app.locals.catalog = [];
app.locals.stores = {};
app.locals.titleData = {};
app.locals.titleId = titleId;
app.locals.appName = appName;
app.locals.wsClients = new Set();

function encodeWsText(message) {
  const payload = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseWsAuth(req) {
  const cookies = parseCookies(req);
  const token = cookies.admin_access || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    const decoded = verifyAccessToken(token);
    return decoded && decoded.email ? decoded : null;
  } catch {
    return null;
  }
}

function attachWebSocket(server) {
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/Admin/ws') return socket.destroy();
    const auth = parseWsAuth(req);
    if (!auth) return socket.destroy();
    const admin = await getAdminByEmail(auth.email).catch(() => null);
    if (!admin || !admin.enabled) return socket.destroy();

    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    // WebSocket handshake requires actual CRLF (\r\n) - not escaped strings
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      ''
    ].join('\r\n'));
    socket.setNoDelay(true);
    socket.isAdminWs = true;
    socket.adminEmail = admin.email;
    app.locals.wsClients.add(socket);

    socket.write(encodeWsText({
      type: 'hello',
      admin: admin.email,
      role: admin.role || 'superadmin',
      timestamp: new Date().toISOString(),
    }));

    const sendSnapshot = async () => {
      try {
        const overview = await getOverview();
        overview.websocketClients = app.locals.wsClients.size;
        socket.write(encodeWsText({ type: 'overview', data: overview, timestamp: new Date().toISOString() }));
      } catch (error) {
        socket.write(encodeWsText({ type: 'error', error: error.message, timestamp: new Date().toISOString() }));
      }
    };
    await sendSnapshot();

    socket.on('data', (buffer) => {
      // Minimal frame handling: close/ping/pong ignored; client messages are optional.
      if (!buffer || buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      if (opcode === 0x8) socket.end();
    });
    socket.on('close', () => app.locals.wsClients.delete(socket));
    socket.on('error', () => app.locals.wsClients.delete(socket));
  });
}

async function broadcastOverview() {
  const clients = [...app.locals.wsClients];
  if (!clients.length) return;
  try {
    const overview = await getOverview();
    overview.websocketClients = clients.length;
    const payload = encodeWsText({ type: 'overview', data: overview, timestamp: new Date().toISOString() });
    for (const socket of clients) {
      if (socket.destroyed) continue;
      try { socket.write(payload); } catch {}
    }
  } catch (error) {
    const payload = encodeWsText({ type: 'error', error: error.message, timestamp: new Date().toISOString() });
    for (const socket of clients) {
      if (socket.destroyed) continue;
      try { socket.write(payload); } catch {}
    }
  }
}

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '5mb' }));
app.use(requestLogger);

app.get('/health', async (req, res) => {
  const dbOk = await db.query('SELECT 1').then(() => true).catch(() => false);
  const redisOk = await redis.ping().then(() => true).catch(() => false);
  return res.status(dbOk && redisOk ? 200 : 503).json({
    status: dbOk && redisOk ? 'ok' : 'degraded',
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use('/Client', clientRoutes);
app.use('/Authentication', authRoutes);
app.use('/Admin', adminRoutes);
const discordBotRouter = require('./routes/discordBot');
app.use('/discord', discordBotRouter);

// Intentionally minimal - never expose Photon keys, CloudScript map, or title config.
app.get('/', (_req, res) => res.json({ status: 'ok' }));

app.use((req, res) => res.status(404).json({
  code: 404,
  status: 'NotFound',
  error: 'PathNotFound',
  errorMessage: `${req.path} not found.`,
  errorDetails: {}
}));

app.use((error, req, res, next) => {
  logger.error('unhandled request error', { error: error.message, path: req.path });
  return res.status(500).json({
    code: 500,
    status: 'InternalServerError',
    error: 'InternalServerError',
    errorMessage: 'An unexpected server error occurred.',
    errorDetails: {}
  });
});

async function start() {
  if (!process.env.DATABASE_URL || !process.env.REDIS_URL || !process.env.SESSION_SECRET || !process.env.TITLE_ID) {
    throw new Error('DATABASE_URL, REDIS_URL, SESSION_SECRET, and TITLE_ID are required.');
  }
  await db.query('SELECT 1');
  await runMigrations();
  await seedIfEmpty();
  await refreshAppLocals(app);
  await connectRedis();
  await redis.ping();
  await ensureAdminSeed();
  startWorker();
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(app);
  attachWebSocket(server);
  server.listen(port, () => logger.info('server listening', { port }));
  const wsTimer = setInterval(() => broadcastOverview().catch(() => {}), 10_000);
  // Clean up expired sessions every 6 hours so the table doesn't grow forever.
  const sessionCleanupTimer = setInterval(() => {
    db.query("DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '1 day'").catch(() => {});
  }, 6 * 60 * 60 * 1000);

  const shutdown = async (signal) => {
    logger.info('shutting down', { signal });
    clearInterval(wsTimer);
    clearInterval(sessionCleanupTimer);
    server.close(async () => {
      stopWorker();
      await closeRedis();
      await db.close();
      process.exit(0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  logger.error('startup failed', { error: error.message });
  process.exit(1);
});
