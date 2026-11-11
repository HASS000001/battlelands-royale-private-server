'use strict';

/**
 * Lightweight async job queue backed by Redis lists + job_log table.
 * Uses RPUSH to enqueue and a single worker loop (BLPOP) to process.
 * No BullMQ dependency - works with ioredis already in the project.
 *
 * Job types and their handlers are registered at the bottom of this file.
 */

const { randomUUID } = require('crypto');
const { db, redis } = require('../db');

const QUEUE_KEY = 'blr:jobs';
const WORKER_TIMEOUT = 5; // BLPOP seconds

// Public API

async function enqueue({ jobType, payload, queuedBy }) {
  const jobId = randomUUID();
  await db.query(
    `INSERT INTO job_log (job_id, job_type, status, queued_by, payload)
     VALUES ($1, $2, 'queued', $3, $4)`,
    [jobId, jobType, queuedBy || null, JSON.stringify(payload || {})]
  );
  await redis.rpush(QUEUE_KEY, JSON.stringify({ jobId, jobType }));
  return jobId;
}

async function getJob(jobId) {
  return db.one('SELECT * FROM job_log WHERE job_id = $1', [jobId]);
}

async function listJobs({ limit = 50, status = null } = {}) {
  const where = status ? `WHERE status = $2` : '';
  const params = status ? [limit, status] : [limit];
  const statusParam = status ? `AND status = $2` : '';
  return db.all(
    `SELECT id, job_id, job_type, status, queued_by, error, started_at, finished_at, created_at
     FROM job_log
     ${status ? `WHERE status = $2` : ''}
     ORDER BY created_at DESC LIMIT $1`,
    params
  );
}

async function _markRunning(jobId) {
  await db.query(
    `UPDATE job_log SET status='running', started_at=NOW() WHERE job_id=$1`,
    [jobId]
  );
}

async function _markDone(jobId, result) {
  await db.query(
    `UPDATE job_log SET status='done', finished_at=NOW(), result=$2 WHERE job_id=$1`,
    [jobId, JSON.stringify(result || {})]
  );
}

async function _markFailed(jobId, err) {
  await db.query(
    `UPDATE job_log SET status='failed', finished_at=NOW(), error=$2 WHERE job_id=$1`,
    [jobId, String(err?.message || err)]
  );
}

// Handlers

async function handleBulkCurrency({ payload }) {
  const { playFabIds, currency, amount, reason } = payload;
  const cols = { GE: 'vc_ge', BB: 'vc_bb', DT: 'vc_dt', BP: 'vc_bp' };
  const col = cols[currency];
  if (!col) throw new Error(`Unknown currency: ${currency}`);
  let updated = 0;
  const errors = [];
  for (const id of playFabIds) {
    try {
      await db.query(
        `UPDATE players SET ${col} = GREATEST(0, ${col} + $1) WHERE playfab_id = $2`,
        [amount, id]
      );
      updated++;
    } catch (e) {
      errors.push({ id, error: e.message });
    }
  }
  return { processed: playFabIds.length, updated, failed: errors.length, errors };
}

async function handleBulkItem({ payload }) {
  const { playFabIds, itemId, itemClass, displayName, remainingUses } = payload;
  let created = 0;
  const errors = [];
  for (const id of playFabIds) {
    try {
      const { randomUUID: uuid } = require('crypto');
      await db.query(
        `INSERT INTO inventory (instance_id, playfab_id, item_id, item_class, display_name,
                                remaining_uses, purchase_date)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [uuid(), id, itemId, itemClass || null, displayName || itemId, remainingUses || null]
      );
      created++;
    } catch (e) {
      errors.push({ id, error: e.message });
    }
  }
  return { processed: playFabIds.length, created, failed: errors.length, errors };
}

const HANDLERS = {
  bulk_currency: handleBulkCurrency,
  bulk_item:     handleBulkItem,
};

// Worker loop

let _workerRunning = false;

async function startWorker() {
  if (_workerRunning) return;
  _workerRunning = true;
  console.log('[queue] worker started');

  // Use a separate ioredis connection so BLPOP doesn't block the main client
  const Redis = require('ioredis');
  const workerRedis = new Redis(process.env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });

  const loop = async () => {
    while (_workerRunning) {
      try {
        const res = await workerRedis.blpop(QUEUE_KEY, WORKER_TIMEOUT);
        if (!res) continue; // timeout - loop again
        const { jobId, jobType } = JSON.parse(res[1]);
        const row = await db.one('SELECT * FROM job_log WHERE job_id=$1', [jobId]);
        if (!row || row.status !== 'queued') continue;

        await _markRunning(jobId);
        const handler = HANDLERS[jobType];
        if (!handler) {
          await _markFailed(jobId, new Error(`No handler for job type: ${jobType}`));
          continue;
        }
        try {
          const result = await handler({ payload: row.payload || {} });
          await _markDone(jobId, result);
        } catch (err) {
          await _markFailed(jobId, err);
        }
      } catch (err) {
        // Connection error etc. - wait briefly then retry
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await workerRedis.quit();
    console.log('[queue] worker stopped');
  };

  loop().catch((err) => {
    console.error('[queue] worker fatal:', err.message);
    _workerRunning = false;
  });
}

function stopWorker() {
  _workerRunning = false;
}

module.exports = { enqueue, getJob, listJobs, startWorker, stopWorker };
