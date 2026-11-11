const { Pool } = require('pg');
const Redis = require('ioredis');
const logger = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000
});

const redis = new Redis(process.env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false
});

redis.on('error', (error) => logger.warn('Redis connection error', { error: error.message }));

const db = {
  query: (text, params) => pool.query(text, params),
  one: async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows[0] || null;
  },
  all: async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows;
  },
  close: () => pool.end(),
  tx: async (callback) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback({
        query: (text, params) => client.query(text, params),
        one: async (text, params) => {
          const r = await client.query(text, params);
          return r.rows[0] || null;
        },
        all: async (text, params) => {
          const r = await client.query(text, params);
          return r.rows;
        }
      });
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

async function connectRedis() {
  if (redis.status === 'wait') {
    await redis.connect();
  }
}

async function closeRedis() {
  if (redis.status !== 'end') {
    await redis.quit().catch(() => redis.disconnect());
  }
}

module.exports = { db, redis, connectRedis, closeRedis };
