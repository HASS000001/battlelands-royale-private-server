const { db } = require('../db');
const logger = require('../logger');
const prom = require('prom-client');

const requestCounter = new prom.Counter({
  name: 'admin_http_requests_total',
  help: 'Total HTTP requests served by the backend.',
  labelNames: ['method', 'path', 'status_code'],
  registers: [prom.register],
});

module.exports = function requestLogger(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - started;
    logger.info('request completed', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs,
      playFabId: req.playFabId || null
    });
    try { requestCounter.inc({ method: req.method, path: req.path, status_code: String(res.statusCode) }); } catch {}
    db.query(
      `INSERT INTO requests_log
        (method, path, playfab_id, duration_ms, status_code, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6::inet)`,
      [req.method, req.path, req.playFabId || null, durationMs, res.statusCode, req.ip]
    ).catch(() => {});
  });
  next();
};
