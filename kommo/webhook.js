// Kommo Webhook Router — Sistema Óticas Target

const express     = require("express");
const router      = express.Router();
const kommo       = require("./client");
const { processMessage, processNewLead } = require("./bot/flowEngine");

const GAS_URL     = () => process.env.GAS_DEPLOY_URL || "";
const GAS_API_KEY = () => process.env.GAS_API_KEY    || "";

function normalizeLoja(loja = "") {
  if (/santos/i.test(loja) || /gonzaga/i.test(loja)) return "Gonzaga & Santos";
  return loja.trim();
}

function getCampo(campos = [], code) {
  const f = campos.find((c) => c.field_code === code);
  return f?.values?.[0]?.value || "";
}

async function criarAgendamentoNoGAS(dados) {
  const params = new URLSearchParams({
    format: "api",
    fn:     "salvarAgendamento",
    key:    GAS_API_KEY(),
    args:   JSON.stringify([dados]),
  });
  const res = await fetch(`${GAS_URL()}?${params}`, {
    method: "GET",
    signal: AbortSignal.timeout(55000),
  });
  return res.json();
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
  const text       = msg.text     || msg.content?.text    || "";
  const authorType = msg.author?.type || msg.author_type  || "contact";

  return { leadId, talkId, text, authorType };
}

// ── POST /webhook/kommo ──────────────────────────────────────────
router.post("/webhook/kommo", async (req, res) => {
  // Sempre responde 200 — Kommo para de reenviar se receber erro
  res.status(200).json({ received: true });

  const payload = req.body;
  console.log("[Webhook/Kommo] Evento:", JSON.stringify(payload).slice(0, 400));

  try {

    // ── Evento: nova mensagem no inbox ─────────────────────────
    if (payload?.message?.add) {
      const entry = extractMessageEntry(payload);
      if (!entry?.leadId) {
        console.log("[Webhook/Kommo] message.add sem lead_id — ignorando");
        return;
      }

      console.log(`[Webhook/Kommo] 💬 Mensagem no lead ${entry.leadId} — autor: ${entry.authorType}`);
      await processMessage({
        leadId:     String(entry.leadId),
        talkId:     entry.talkId ? String(entry.talkId) : null,
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

    const agendamento = {
      nome:             contato.name || lead.name || "Sem nome",
      whatsapp:         getCampo(campos, "PHONE") || "",
      email:            getCampo(campos, "EMAIL") || "",
      loja,
      optometrista,
      data_agendamento: dataAgendamento,
      horario,
      origem:           "Kommo",
      observacao:       `Lead Kommo #${leadId}`,
      status:           "Agendado",
      kommo_lead_id:    String(leadId),
    };

    const gasResult = await criarAgendamentoNoGAS(agendamento);
    console.log("[Webhook/Kommo] GAS:", JSON.stringify(gasResult).slice(0, 200));

    if (gasResult?.ok) {
      await kommo.addNote(leadId,
        `✅ Agendamento criado no sistema\n📅 ${dataAgendamento} às ${horario}\n🏪 ${loja}\n👁 ${optometrista || "A definir"}`
      );
    } else {
      await kommo.addNote(leadId, `⚠️ Erro ao criar agendamento: ${gasResult?.error || "desconhecido"}`);
    }

  } catch (err) {
    console.error("[ERRO][Webhook/Kommo]", err.message);
  }
});

// ── GET /kommo/health ────────────────────────────────────────────
router.get("/kommo/health", (req, res) => {
  res.json({
    ok:          true,
    bot_enabled: process.env.BOT_ENABLED !== "false",
    kommo:       !!process.env.KOMMO_ACCESS_TOKEN,
    subdomain:   process.env.KOMMO_SUBDOMAIN || "não configurado",
    gas:         !!process.env.GAS_DEPLOY_URL,
    timestamp:   new Date().toISOString(),
  });
});

module.exports = router;
