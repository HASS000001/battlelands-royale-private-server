'use strict';

const fs = require('fs/promises');
const path = require('path');
const { db } = require('../db');

const MIGRATIONS_DIR = path.join(process.cwd(), 'scripts', 'migrations');

async function ensureMigrationsTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function runMigrations() {
  await ensureMigrationsTable();
  const files = (await fs.readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();
  for (const filename of files) {
    const applied = await db.one('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename]);
    if (applied) continue;
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
    await db.tx(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
    });
  }
}

module.exports = { runMigrations };
