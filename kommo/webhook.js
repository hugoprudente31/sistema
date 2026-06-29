// Kommo Webhook Router — Sistema Óticas Target

const crypto      = require("crypto");
const express     = require("express");
const router      = express.Router();
const kommo       = require("./client");
const scheduling  = require("./scheduling");
const SM          = require("./bot/stateManager");
const { processMessage, processNewLead } = require("./bot/flowEngine");

function safeEqual(value, expected) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(String(expected || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function webhookSecret(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(
    req.headers["x-kommo-webhook-secret"] ||
    req.query.secret ||
    req.body.secret ||
    ""
  ).trim();
}

function requireWebhookSecret(req, res, next) {
  const expected = process.env.KOMMO_WEBHOOK_SECRET || "";
  if (!expected) return res.status(503).json({ ok: false, message: "KOMMO_WEBHOOK_SECRET nao configurado." });
  if (!safeEqual(webhookSecret(req), expected)) {
    return res.status(401).json({ ok: false, message: "Webhook Kommo nao autorizado." });
  }
  return next();
}

function normalizeLoja(loja = "") {
  if (/santos/i.test(loja) || /gonzaga/i.test(loja)) return "Gonzaga & Santos";
  return loja.trim();
}

function getCampo(campos = [], code) {
  const f = campos.find((c) => c.field_code === code);
  return f?.values?.[0]?.value || "";
}

// ── Extrai entrada de mensagem do payload do Kommo ───────────────
// O Kommo pode enviar o evento em formatos ligeiramente diferentes
function extractMessageEntry(payload) {
  // Formato 1: payload.message.add[0]
  const msg = payload?.message?.add?.[0] || payload?.message?.[0];
  if (!msg) return null;

  // Tenta múltiplos caminhos para campos críticos
  // element_type "2" = lead no Kommo
  const leadId =
    msg.lead_id ||
    msg.conversation?.lead_id ||
    (msg.element_type === "2" || msg.element_type === 2 ? msg.element_id : null) ||
    msg.entity_id ||
    null;

  const talkId     = msg.talk_id  || msg.conversation?.id || null;
  const chatId     = msg.chat_id  || null;
  const text       = msg.text     || msg.content?.text    || "";
  const authorType = msg.author?.type || msg.author_type  || "contact";

  return { leadId, talkId, chatId, text, authorType };
}

// ── POST /webhook/kommo ──────────────────────────────────────────
router.post("/webhook/kommo", requireWebhookSecret, async (req, res) => {
  // Sempre responde 200 — Kommo para de reenviar se receber erro
  res.status(200).json({ received: true });

  const payload = req.body;
  console.log("[Webhook/Kommo] Evento:", JSON.stringify(payload).slice(0, 400));

  try {

    // ── Evento: nova mensagem no inbox ─────────────────────────
    if (payload?.message?.add) {
      const entry = extractMessageEntry(payload);

      // No modo Salesbot, o Kommo chama /api/salesbot para mensagens do cliente.
      // Mas ainda precisamos rastrear mensagens de ATENDENTES para o handoff bot↔humano.
      if (process.env.KOMMO_USE_SALESBOT === "true") {
        if (entry?.leadId && entry.authorType === "user") {
          SM.markHumanActivity(String(entry.leadId));
          console.log(`[Webhook/Kommo] 👤 Atendente registrado — lead ${entry.leadId}`);
        } else {
          console.log("[Webhook/Kommo] Modo Salesbot — message.add do cliente ignorado (Salesbot processa)");
        }
        return;
      }

      if (!entry?.leadId) {
        console.log("[Webhook/Kommo] message.add sem lead_id — ignorando");
        return;
      }

      console.log(`[Webhook/Kommo] 💬 Mensagem no lead ${entry.leadId} — autor: ${entry.authorType}`);
      await processMessage({
        leadId:     String(entry.leadId),
        talkId:     entry.talkId ? String(entry.talkId) : null,
        chatId:     entry.chatId  ? String(entry.chatId)  : null,
        text:       entry.text,
        authorType: entry.authorType,
      });
      return;
    }

    // ── Evento: novo lead adicionado ao pipeline ───────────────
    if (payload?.leads?.add) {
      const leadEntry = payload.leads.add[0];
      if (!leadEntry?.id) return;

      console.log(`[Webhook/Kommo] 🆕 Novo lead ${leadEntry.id}`);
      await processNewLead(String(leadEntry.id));
      return;
    }

    // ── Evento: mudança de estágio / atualização de lead ───────
    const leadEntry =
      payload?.leads?.status?.[0] ||
      payload?.leads?.update?.[0] || null;

    if (!leadEntry) {
      console.log("[Webhook/Kommo] Payload sem evento mapeado — ignorando");
      return;
    }

    // Verifica se está no estágio de agendamento manual (via atendente)
    const stageAgendar = process.env.KOMMO_STAGE_AGENDAR;
    if (stageAgendar && String(leadEntry.status_id) !== String(stageAgendar)) {
      console.log(`[Webhook/Kommo] Estágio ${leadEntry.status_id} — sem ação de agendamento`);
      return;
    }

    // Se chegou aqui, é um agendamento criado manualmente pelo atendente
    const leadId = leadEntry.id;
    console.log(`[Webhook/Kommo] 📅 Agendamento manual — lead ${leadId}`);

    const lead   = await kommo.getLead(leadId);
    const campos = lead?.custom_fields_values || [];
    const contato = lead?._embedded?.contacts?.[0] || {};

    const loja            = normalizeLoja(getCampo(campos, "LOJA"));
    const dataAgendamento = getCampo(campos, "DATA_AGENDAMENTO");
    const horario         = getCampo(campos, "HORARIO");
    const optometrista    = getCampo(campos, "OPTOMETRISTA");

    if (!dataAgendamento || !horario) {
      console.log("[Webhook/Kommo] DATA_AGENDAMENTO ou HORARIO não preenchidos — ignorando");
      await kommo.addNote(leadId, "⚠️ Para agendar, preencha os campos: DATA_AGENDAMENTO e HORARIO no lead.");
      return;
    }

    const dbResult = await scheduling.criarAgendamento({
      nome: contato.name || lead.name || "Sem nome",
      whatsapp: getCampo(campos, "PHONE") || "",
      email: getCampo(campos, "EMAIL") || "",
      loja,
      optometrista,
      data: dataAgendamento,
      horario,
      leadId,
    });
    console.log("[Webhook/Kommo] PostgreSQL:", JSON.stringify(dbResult).slice(0, 200));

    if (dbResult?.ok) {
      await kommo.addNote(leadId,
        `✅ Agendamento criado no sistema\n📅 ${dataAgendamento} às ${horario}\n🏪 ${loja}\n👁 ${optometrista || "A definir"}`
      );
    } else {
      await kommo.addNote(leadId, `⚠️ Erro ao criar agendamento: ${dbResult?.error || "desconhecido"}`);
    }

  } catch (err) {
    console.error("[ERRO][Webhook/Kommo]", err.message);
  }
});

// ── POST /api/kommo/message ──────────────────────────────────────
// Webhook criado via /api/v4/webhooks para eventos add_message.
// Kommo não envia secret neste endpoint — verifica pelo subdomain no payload.
router.post("/api/kommo/message", async (req, res) => {
  // Responde 200 imediatamente para o Kommo não reenviar
  res.status(200).json({ received: true });

  const payload = req.body;

  // Rejeita payloads que claramente não são do nosso Kommo
  const incomingSubdomain = payload?.account?.subdomain || "";
  const expectedSubdomain = process.env.KOMMO_SUBDOMAIN || "";
  if (expectedSubdomain && incomingSubdomain && incomingSubdomain !== expectedSubdomain) {
    console.log(`[Kommo/Message] Subdomínio inesperado: ${incomingSubdomain} — ignorando`);
    return;
  }

  console.log("[Kommo/Message] Payload:", JSON.stringify(payload).slice(0, 400));

  try {
    if (!payload?.message?.add) {
      console.log("[Kommo/Message] Payload sem message.add — ignorando");
      return;
    }

    const entry = extractMessageEntry(payload);
    if (!entry?.leadId) {
      console.log("[Kommo/Message] message.add sem lead_id — ignorando");
      return;
    }

    // Registra atividade humana e para — o bot não responde enquanto atendente está ativo
    if (entry.authorType === "user") {
      SM.markHumanActivity(String(entry.leadId));
      console.log(`[Kommo/Message] 👤 Atendente — lead ${entry.leadId}`);
      return;
    }

    console.log(`[Kommo/Message] 💬 Contato — lead ${entry.leadId} — "${entry.text.slice(0, 60)}"`);

    await processMessage({
      leadId:     String(entry.leadId),
      talkId:     entry.talkId ? String(entry.talkId) : null,
      chatId:     entry.chatId ? String(entry.chatId) : null,
      text:       entry.text,
      authorType: entry.authorType || "contact",
    });

  } catch (err) {
    console.error("[ERRO][Kommo/Message]", err.message);
  }
});

// ── GET /kommo/health ────────────────────────────────────────────
router.get("/kommo/health", (req, res) => {
  res.json({
    ok:          true,
    bot_enabled: process.env.BOT_ENABLED !== "false",
    kommo:       !!process.env.KOMMO_ACCESS_TOKEN,
    salesbot:    process.env.KOMMO_USE_SALESBOT === "true",
    webhook_secret_configured: !!process.env.KOMMO_WEBHOOK_SECRET,
    subdomain:   process.env.KOMMO_SUBDOMAIN || "não configurado",
    database:    !!process.env.DATABASE_URL,
    timestamp:   new Date().toISOString(),
  });
});

module.exports = router;
