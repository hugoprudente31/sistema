"use strict";

const { pool, integerEnv } = require("./db");
const { runMonitoredJob } = require("./jobMonitor");

async function deleteOldRows(table, dateColumn, days) {
  const allowed = new Set(["logs_sistema", "automacao_execucoes", "crm_mensagens"]);
  if (!allowed.has(table)) throw new Error("Tabela de retenção não autorizada");
  const result = await pool.query(
    `WITH antigos AS (
       SELECT id FROM ${table}
        WHERE ${dateColumn} < NOW() - ($1 * INTERVAL '1 day')
        ORDER BY id
        LIMIT 10000
     )
     DELETE FROM ${table} alvo
      USING antigos
      WHERE alvo.id = antigos.id`,
    [days]
  );
  return result.rowCount || 0;
}

async function retentionPreview() {
  const logDays = integerEnv("DATABASE_LOG_RETENTION_DAYS", 180, 30, 3650);
  const jobDays = integerEnv("DATABASE_JOB_RETENTION_DAYS", 90, 30, 3650);
  const crmDays = integerEnv("DATABASE_CRM_RETENTION_DAYS", 730, 90, 3650);
  const result = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM logs_sistema
         WHERE criado_em < NOW() - ($1 * INTERVAL '1 day')) AS logs_expirados,
       (SELECT COUNT(*)::int FROM automacao_execucoes
         WHERE iniciado_em < NOW() - ($2 * INTERVAL '1 day')) AS jobs_expirados,
       (SELECT COUNT(*)::int FROM crm_mensagens
         WHERE criado_em < NOW() - ($3 * INTERVAL '1 day')) AS mensagens_crm_expiradas`,
    [logDays, jobDays, crmDays]
  );
  return { logDays, jobDays, crmDays, ...(result.rows[0] || {}) };
}

async function runDatabaseMaintenance() {
  if (process.env.DATABASE_RETENTION_ENABLED !== "true") {
    return { ignorado: true, motivo: "retencao_desativada" };
  }

  const preview = await retentionPreview();
  const logs = await deleteOldRows("logs_sistema", "criado_em", preview.logDays);
  const jobs = await deleteOldRows("automacao_execucoes", "iniciado_em", preview.jobDays);
  const crm = process.env.DATABASE_CRM_RETENTION_ENABLED === "true"
    ? await deleteOldRows("crm_mensagens", "criado_em", preview.crmDays)
    : 0;

  if (process.env.DATABASE_MAINTENANCE_ANALYZE === "true") {
    await pool.query("ANALYZE agendamentos");
    await pool.query("ANALYZE agendamento_negociacao");
    await pool.query("ANALYZE notificacoes");
  }

  return {
    processados: logs + jobs + crm,
    removidos: { logs, jobs, crm },
    crmRetentionEnabled: process.env.DATABASE_CRM_RETENTION_ENABLED === "true",
  };
}

function startDatabaseMaintenanceCron() {
  const targetHour = integerEnv("DATABASE_MAINTENANCE_HOUR", 3, 0, 23);
  const schedule = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(targetHour, 15, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const timer = setTimeout(async () => {
      try {
        await runMonitoredJob("database_maintenance", runDatabaseMaintenance);
      } catch (error) {
        console.error("[database] Falha na manutenção:", error.message);
      }
      schedule();
    }, next.getTime() - now.getTime());
    timer.unref?.();
    console.log(`[database] Próxima manutenção: ${next.toString()}`);
  };
  schedule();
}

module.exports = {
  runDatabaseMaintenance,
  startDatabaseMaintenanceCron,
  retentionPreview,
  deleteOldRows,
};
