// Histórico de mensagens do CRM próprio — Sistema Óticas Target
// Espelha (não substitui) a conversa do Kommo em Postgres para o painel CRM.
// Nunca deve lançar/bloquear o fluxo do bot: toda falha é só logada.

const { pool } = require("../lib/db");

async function registrarMensagem({ leadId, talkId, chatId, direcao, autorTipo, autorNome = null, texto }) {
  if (!leadId || !texto) return;
  try {
    await pool.query(
      `INSERT INTO crm_mensagens (kommo_lead_id, talk_id, chat_id, direcao, autor_tipo, autor_nome, texto)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [String(leadId), talkId ? String(talkId) : null, chatId ? String(chatId) : null, direcao, autorTipo, autorNome, texto]
    );
  } catch (e) {
    console.error(`[CRM/Log] Erro ao registrar mensagem — lead ${leadId}:`, e.message);
  }
}

module.exports = { registrarMensagem };
