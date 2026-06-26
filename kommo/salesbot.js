// Kommo Salesbot Endpoint — Sistema Óticas Target
//
// O Salesbot do Kommo chama POST /api/salesbot com os dados da mensagem.
// Este endpoint processa a mensagem pelo motor do bot e retorna o texto
// de resposta. O Salesbot então envia a mensagem nativamente via Kommo.
//
// Variável de ambiente necessária: KOMMO_USE_SALESBOT=true
//
// Configuração no Kommo (Configurações → Salesbot → Novo Salesbot):
//   Gatilho : "Nova mensagem recebida de contato"
//   Passo 1 : Requisição HTTP
//     Método : POST
//     URL    : https://SEU-DOMINIO.railway.app/api/salesbot
//     Corpo  : {
//       "lead_id":      "{{lead_id}}",
//       "talk_id":      "{{talk_id}}",
//       "chat_id":      "{{chat_id}}",
//       "message":      "{{last_message_text}}",
//       "contact_name": "{{contact_name}}",
//       "secret":       "MESMO_VALOR_DE_SALESBOT_SECRET"
//     }
//   Passo 2 : Condição
//     Se {{response.text}} NÃO está vazio → Passo 3
//     Caso contrário → Fim
//   Passo 3 : Enviar mensagem
//     Texto : {{response.text}}

const crypto                           = require("crypto");
const express                          = require("express");
const router                           = express.Router();
const { processMessage, flushResponses } = require("./bot/flowEngine");
const SM                               = require("./bot/stateManager");

function safeEqual(value, expected) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(String(expected || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function salesbotSecret(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(
    req.headers["x-salesbot-secret"] ||
    req.query.secret ||
    req.body.secret ||
    ""
  ).trim();
}

function requireSalesbotSecret(req, res, next) {
  const expected = process.env.SALESBOT_SECRET || process.env.KOMMO_SALESBOT_SECRET || "";
  if (!expected) return res.status(503).json({ text: "", ok: false, message: "SALESBOT_SECRET nao configurado." });
  if (!safeEqual(salesbotSecret(req), expected)) {
    return res.status(401).json({ text: "", ok: false, message: "Salesbot nao autorizado." });
  }
  return next();
}

router.post("/api/salesbot", requireSalesbotSecret, async (req, res) => {

  const leadId  = String(req.body.lead_id  || "").trim();
  const talkId  = String(req.body.talk_id  || "").trim() || null;
  const chatId  = String(req.body.chat_id  || "").trim() || null;
  const message = String(req.body.message  || "").trim();

  console.log(`[Salesbot] lead=${leadId} talk=${talkId} chat=${chatId} msg="${message.slice(0, 60)}"`);

  if (!leadId) {
    return res.json({ text: "" });
  }

  // Drena mensagens pendentes anteriores (limpa estado de envio)
  flushResponses(leadId);

  try {
    await processMessage({
      leadId,
      talkId,
      chatId,
      text:       message,
      authorType: "contact",
    });
  } catch (e) {
    console.error(`[Salesbot] Erro ao processar lead ${leadId}:`, e.message);
    return res.json({ text: "" });
  }

  // Coleta todas as mensagens que o bot gerou e une em um único texto
  const parts = flushResponses(leadId);
  const text  = parts.join("\n\n");

  console.log(`[Salesbot] lead=${leadId} → ${parts.length} msg(s) — "${text.slice(0, 100)}"`);
  return res.json({ text });
});

// ── Health para testar o endpoint no browser ─────────────────────
router.get("/api/salesbot/health", (_req, res) => {
  res.json({
    ok:            true,
    salesbot_mode: process.env.KOMMO_USE_SALESBOT === "true",
    secret_configured: !!(process.env.SALESBOT_SECRET || process.env.KOMMO_SALESBOT_SECRET),
    timestamp:     new Date().toISOString(),
  });
});

module.exports = router;
