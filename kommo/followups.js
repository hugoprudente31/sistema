"use strict";

const { pool } = require("../lib/db");
const { runMonitoredJob } = require("../lib/jobMonitor");
const kommo = require("./client");
const MSG = require("./bot/messages");

let followupRunning = false;

async function getDueNoShows() {
  const { rows } = await pool.query(`
    SELECT id, nome, loja, kommo_lead_id
    FROM agendamentos
    WHERE nao_compareceu_em IS NOT NULL
      AND nao_compareceu_em <= NOW() - INTERVAL '45 minutes'
      AND nao_compareceu_lembrete_em IS NULL
      AND nao_compareceu_falha_em IS NULL
      AND COALESCE(nao_compareceu_tentativas, 0) < 5
      AND (nao_compareceu_proxima_tentativa_em IS NULL OR nao_compareceu_proxima_tentativa_em <= NOW())
      AND kommo_lead_id IS NOT NULL
      AND kommo_lead_id <> ''
      AND excluido_em IS NULL
      AND (
        TRANSLATE(LOWER(TRIM(COALESCE(compareceu, ''))),
          'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')
          IN ('nao', 'nao compareceu')
        OR TRANSLATE(LOWER(TRIM(COALESCE(status, ''))),
          'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')
          = 'nao compareceu'
      )
    ORDER BY nao_compareceu_em, id
    LIMIT 50
  `);
  return rows;
}

async function getDueProposals() {
  const { rows } = await pool.query(`
    SELECT n.id AS negociacao_id, a.id AS agendamento_id,
           a.nome, a.loja, a.kommo_lead_id
    FROM agendamento_negociacao n
    JOIN agendamentos a ON a.id = n.agendamento_id
    WHERE n.proposta_agendada_em IS NOT NULL
      AND n.proposta_agendada_em <= NOW()
      AND n.proposta_enviada_em IS NULL
      AND n.proposta_falha_em IS NULL
      AND COALESCE(n.proposta_tentativas, 0) < 5
      AND (n.proposta_proxima_tentativa_em IS NULL OR n.proposta_proxima_tentativa_em <= NOW())
      AND a.excluido_em IS NULL
      AND a.kommo_lead_id IS NOT NULL
      AND a.kommo_lead_id <> ''
      AND COALESCE(a.valor_venda, 0) = 0
      AND COALESCE(a.numero_os, '') = ''
      AND TRANSLATE(LOWER(TRIM(COALESCE(a.compareceu, ''))),
        'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc') = 'sim'
    ORDER BY n.proposta_agendada_em, n.id
    LIMIT 50
  `);
  return rows;
}

async function runFollowups() {
  if (process.env.BOT_ENABLED === "false" || process.env.FOLLOWUP_AUTOMATION_ENABLED === "false") {
    return { nao_compareceu: 0, propostas: 0, erros: 0, desativado: true };
  }
  if (followupRunning) return { nao_compareceu: 0, propostas: 0, erros: 0, em_execucao: true };
  followupRunning = true;

  let noShowsSent = 0;
  let proposalsSent = 0;
  let errors = 0;
  try {
    const noShows = await getDueNoShows();
    for (const row of noShows) {
      try {
        await kommo.sendProactiveMessage(
          String(row.kommo_lead_id),
          MSG.naoCompareceu45(row.nome, row.loja)
        );
        await pool.query(
          `UPDATE agendamentos
           SET nao_compareceu_lembrete_em = NOW(), nao_compareceu_erro = NULL,
               nao_compareceu_proxima_tentativa_em = NULL
           WHERE id = $1 AND nao_compareceu_lembrete_em IS NULL`,
          [row.id]
        );
        noShowsSent++;
      } catch (error) {
        errors++;
        const failure = await pool.query(
          `UPDATE agendamentos
              SET nao_compareceu_tentativas = COALESCE(nao_compareceu_tentativas, 0) + 1,
                  nao_compareceu_erro = $2,
                  nao_compareceu_proxima_tentativa_em = CASE
                    WHEN COALESCE(nao_compareceu_tentativas, 0) + 1 >= 5 THEN NULL
                    ELSE NOW() + INTERVAL '5 minutes' * POWER(2, COALESCE(nao_compareceu_tentativas, 0))
                  END,
                  nao_compareceu_falha_em = CASE
                    WHEN COALESCE(nao_compareceu_tentativas, 0) + 1 >= 5 THEN NOW()
                    ELSE nao_compareceu_falha_em
                  END
            WHERE id = $1
            RETURNING nao_compareceu_tentativas, nao_compareceu_falha_em`,
          [row.id, String(error.message || error).slice(0, 500)]
        );
        if (failure.rows[0]?.nao_compareceu_falha_em) {
          await pool.query(
            `INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios)
             SELECT 'followup_falhou', 'Acompanhamento não enviado',
                    'O acompanhamento automático atingiu o limite de 5 tentativas. Revise o lead no Kommo.',
                    $1, $2
              WHERE NOT EXISTS (SELECT 1 FROM notificacoes WHERE tipo = 'followup_falhou' AND agendamento_id = $1)`,
            [row.id, ["admin", "atendimento central"]]
          );
        }
        console.error(`[Followup45m] Erro no agendamento ${row.id}:`, error.message);
      }
    }

    const proposals = await getDueProposals();
    for (const row of proposals) {
      try {
        await kommo.sendProactiveMessage(
          String(row.kommo_lead_id),
          MSG.propostaSemCompra(row.nome, row.loja)
        );
        await pool.query(
          `UPDATE agendamento_negociacao
           SET proposta_enviada_em = NOW(), proposta_erro = NULL,
               proposta_ultima_tentativa_em = NOW(), proposta_proxima_tentativa_em = NULL
           WHERE id = $1 AND proposta_enviada_em IS NULL`,
          [row.negociacao_id]
        );
        await pool.query(
          `INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            "proposta_enviada",
            "📩 Proposta enviada — acompanhe " + (row.nome || "lead"),
            "Proposta enviada via WhatsApp para " + (row.nome || "lead") +
              " (" + (row.loja || "") + "). Aguardando retorno do cliente.",
            row.agendamento_id,
            ["admin", "atendimento central"],
          ]
        );
        proposalsSent++;
      } catch (error) {
        errors++;
        const failure = await pool.query(
          `UPDATE agendamento_negociacao
           SET proposta_erro = $2, proposta_ultima_tentativa_em = NOW(),
               proposta_tentativas = COALESCE(proposta_tentativas, 0) + 1,
               proposta_proxima_tentativa_em = CASE
                 WHEN COALESCE(proposta_tentativas, 0) + 1 >= 5 THEN NULL
                 ELSE NOW() + INTERVAL '5 minutes' * POWER(2, COALESCE(proposta_tentativas, 0))
               END,
               proposta_falha_em = CASE
                 WHEN COALESCE(proposta_tentativas, 0) + 1 >= 5 THEN NOW()
                 ELSE proposta_falha_em
               END
           WHERE id = $1
           RETURNING proposta_tentativas, proposta_falha_em`,
          [row.negociacao_id, String(error.message || error).slice(0, 500)]
        );
        if (failure.rows[0]?.proposta_falha_em) {
          await pool.query(
            `INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios)
             SELECT 'proposta_falhou', 'Proposta não enviada',
                    'O envio automático da proposta atingiu o limite de 5 tentativas. Revise o lead no Kommo.',
                    $1, $2
              WHERE NOT EXISTS (SELECT 1 FROM notificacoes WHERE tipo = 'proposta_falhou' AND agendamento_id = $1)`,
            [row.agendamento_id, ["admin", "atendimento central"]]
          );
        }
        console.error(`[Followup25m] Erro na negociacao ${row.negociacao_id}:`, error.message);
      }
    }

    if (noShows.length || proposals.length) {
      console.log(
        `[Followups] Concluido: ${noShowsSent} nao compareceu, ` +
        `${proposalsSent} propostas, ${errors} erros.`
      );
    }
    return { nao_compareceu: noShowsSent, propostas: proposalsSent, erros: errors };
  } catch (error) {
    console.error("[Followups] Erro geral:", error.message);
    return { nao_compareceu: noShowsSent, propostas: proposalsSent, erros: errors + 1 };
  } finally {
    followupRunning = false;
  }
}

function startFollowupCron() {
  if (process.env.FOLLOWUP_AUTOMATION_ENABLED === "false") {
    console.log("    Followups: desativados para validacao");
    return;
  }
  const intervalMinutes = Math.max(
    1,
    Number.parseInt(process.env.FOLLOWUP_INTERVAL_MINUTES || "1", 10) || 1
  );
  const execute = async () => {
    try { await runMonitoredJob("followups", runFollowups); }
    catch (error) { console.error("[Followups] Erro no job:", error.message); }
  };
  execute();
  const timer = setInterval(execute, intervalMinutes * 60 * 1000);
  timer.unref?.();
  console.log(`    Followups: verificacao ativa a cada ${intervalMinutes} minuto(s)`);
}

module.exports = {
  runFollowups,
  startFollowupCron,
  getDueNoShows,
  getDueProposals,
};
