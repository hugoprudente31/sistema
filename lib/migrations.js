"use strict";

const migrations = [
  require("../database/migrations/001_operational_hardening"),
];

const LOCK_ID = 724031991;

async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        description TEXT,
        aplicado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const applied = await client.query("SELECT id FROM schema_migrations");
    const ids = new Set(applied.rows.map((row) => row.id));

    for (const migration of migrations) {
      if (ids.has(migration.id)) continue;
      await client.query("BEGIN");
      try {
        await migration.up(client);
        await client.query(
          "INSERT INTO schema_migrations (id, description) VALUES ($1, $2)",
          [migration.id, migration.description || null]
        );
        await client.query("COMMIT");
        console.log(`[database] Migração aplicada: ${migration.id}`);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => null);
        throw new Error(`Falha na migração ${migration.id}: ${error.message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]).catch(() => null);
    client.release();
  }
}

module.exports = { runMigrations, migrations };
