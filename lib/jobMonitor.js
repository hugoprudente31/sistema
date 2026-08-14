"use strict";

const { pool } = require("./db");

function resultCounts(result) {
  const value = result || {};
  const sent = Number(value.enviados || 0) +
    Number(value.propostas || 0) +
    Number(value.nao_compareceu || 0);
  const errors = Number(value.erros || 0);
  const processed = Number(value.processados || 0) || sent + errors;
  return { sent, errors, processed };
}

async function runMonitoredJob(name, job) {
  const lockClient = await pool.connect();
  let locked = false;
  let executionId = null;
  try {
    const lock = await lockClient.query(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [`tgt-job:${name}`]
    );
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { ignorado: true, motivo: "outra_instancia_em_execucao" };

    const started = await lockClient.query(
      `INSERT INTO automacao_execucoes (automacao)
       VALUES ($1) RETURNING id`,
      [name]
    );
    executionId = started.rows[0]?.id || null;

    const result = await job();
    const counts = resultCounts(result);
    const ignored = !!(result?.desativado || result?.em_execucao || result?.ignorado);
    const status = ignored ? "ignorado" : counts.errors > 0 ? "erro" : "sucesso";
    await lockClient.query(
      `UPDATE automacao_execucoes
          SET finalizado_em = NOW(), status = $2, processados = $3,
              enviados = $4, erros = $5, detalhes = $6
        WHERE id = $1`,
      [executionId, status, counts.processed, counts.sent, counts.errors, result || {}]
    );
    return result;
  } catch (error) {
    if (executionId) {
      await lockClient.query(
        `UPDATE automacao_execucoes
            SET finalizado_em = NOW(), status = 'erro', erros = 1, erro = $2
          WHERE id = $1`,
        [executionId, String(error.message || error).slice(0, 1000)]
      ).catch(() => null);
    }
    throw error;
  } finally {
    if (locked) {
      await lockClient.query(
        "SELECT pg_advisory_unlock(hashtext($1))",
        [`tgt-job:${name}`]
      ).catch(() => null);
    }
    lockClient.release();
  }
}

module.exports = { runMonitoredJob, resultCounts };
