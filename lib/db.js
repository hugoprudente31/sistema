"use strict";

const { Pool } = require("pg");

function integerEnv(name, fallback, minimum, maximum) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function sslConfig() {
  if (process.env.DATABASE_SSL === "false") return false;
  if (process.env.DATABASE_SSL === "true") return { rejectUnauthorized: false };

  const url = String(process.env.DATABASE_URL || "");
  if (/localhost|127\.0\.0\.1|railway\.internal/i.test(url)) return false;
  return url ? { rejectUnauthorized: false } : false;
}

const max = integerEnv("DATABASE_POOL_MAX", 12, 2, 30);
const statementTimeout = integerEnv("DATABASE_STATEMENT_TIMEOUT_MS", 30000, 1000, 120000);
const queryTimeout = integerEnv("DATABASE_QUERY_TIMEOUT_MS", 35000, 1000, 180000);
const idleTransactionTimeout = integerEnv(
  "DATABASE_IDLE_TRANSACTION_TIMEOUT_MS",
  60000,
  1000,
  120000
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
  max,
  idleTimeoutMillis: integerEnv("DATABASE_IDLE_TIMEOUT_MS", 30000, 1000, 300000),
  connectionTimeoutMillis: integerEnv("DATABASE_CONNECT_TIMEOUT_MS", 10000, 1000, 60000),
  statement_timeout: statementTimeout,
  query_timeout: queryTimeout,
  idle_in_transaction_session_timeout: idleTransactionTimeout,
  options: "-c timezone=America/Sao_Paulo",
});

pool.on("error", (error) => {
  console.error("[database] Erro em conexão ociosa do PostgreSQL:", error.message);
});

function databaseConfigSummary() {
  return {
    maxConnections: max,
    statementTimeoutMs: statementTimeout,
    queryTimeoutMs: queryTimeout,
    idleTransactionTimeoutMs: idleTransactionTimeout,
  };
}

module.exports = { pool, databaseConfigSummary, integerEnv, sslConfig };
