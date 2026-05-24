// Integração: Kommo Webhook — Sistema Óticas Target

const express = require("express");
const router  = express.Router();
const kommo   = require("./client");

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

// ── Chama o GAS para salvar agendamento ──────────────────────
async function criarAgendamentoNoGAS(dados) {
  const params = new URLSearchParams({
    format: "api",
    fn:     "salvarAgendamento",
    key:    GAS_API_KEY(),
    args:   JSON.stringify([dados]),
  });

  const res  = await fetch(`${GAS_URL()}?${params}`, {
    method: "GET",
    signal: AbortSignal.timeout(55000),
  });
  return res.json();
}

// ── POST /webhook/kommo ───────────────────────────────────────
// Kommo envia aqui quando lead muda de estágio ou é atualizado
router.post("/webhook/kommo", async (req, res) => {
  // Sempre responde 200 — Kommo para de reenviar se receber erro
  res.status(200).json({ received: true });

  const payload = req.body;
  console.log("[Kommo→GAS] Webhook recebido:", JSON.stringify(payload).slice(0, 300));

  try {
    // Kommo envia evento de lead (status ou atualização)
    const leadEntry =
      payload?.leads?.status?.[0] ||
      payload?.leads?.update?.[0] ||
      payload?.leads?.add?.[0]    || null;

    if (!leadEntry) {
      console.log("[Kommo→GAS] Sem dados de lead no payload, ignorando");
      return;
    }

    // Verifica se está no estágio de agendamento (se configurado)
    const stageAgendar = process.env.KOMMO_STAGE_AGENDAR;
    if (stageAgendar && String(leadEntry.status_id) !== String(stageAgendar)) {
      console.log(`[Kommo→GAS] Estágio ${leadEntry.status_id} ignorado`);
      return;
    }

    const leadId = leadEntry.id;
    console.log(`[Kommo→GAS] Processando lead ${leadId}`);

    // Busca dados completos do lead
    const lead   = await kommo.getLead(leadId);
    const campos = lead?.custom_fields_values || [];
    const contato = lead?._embedded?.contacts?.[0] || {};

    const loja           = normalizeLoja(getCampo(campos, "LOJA"));
    const dataAgendamento = getCampo(campos, "DATA_AGENDAMENTO");
    const horario        = getCampo(campos, "HORARIO");
    const optometrista   = getCampo(campos, "OPTOMETRISTA");

    if (!dataAgendamento || !horario) {
      console.log("[Kommo→GAS] DATA_AGENDAMENTO ou HORARIO não preenchidos no lead, ignorando");
      await kommo.addNote(leadId, "⚠️ Para agendar, preencha os campos: DATA_AGENDAMENTO e HORARIO no lead.");
      return;
    }

    const agendamento = {
      nome:            contato.name || lead.name || "Sem nome",
      whatsapp:        getCampo(campos, "PHONE") || "",
      email:           getCampo(campos, "EMAIL") || "",
      loja,
      optometrista,
      data_agendamento: dataAgendamento,
      horario,
      origem:          "Kommo",
      observacao:      `Lead Kommo #${leadId}`,
      status:          "Agendado",
      kommo_lead_id:   String(leadId),
    };

    console.log(`[Kommo→GAS] Criando agendamento: ${agendamento.nome} — ${loja} — ${dataAgendamento} ${horario}`);

    const gasResult = await criarAgendamentoNoGAS(agendamento);
    console.log("[Kommo→GAS] GAS respondeu:", JSON.stringify(gasResult).slice(0, 200));

    if (gasResult?.ok) {
      await kommo.addNote(leadId,
        `✅ Agendamento criado no sistema\n📅 ${dataAgendamento} às ${horario}\n🏪 ${loja}\n👁 ${optometrista || "A definir"}`
      );
    } else {
      await kommo.addNote(leadId, `⚠️ Erro ao criar agendamento: ${gasResult?.error || "desconhecido"}`);
    }

  } catch (err) {
    console.error("[ERRO][Kommo→GAS]", err.message);
  }
});

// ── GET /kommo/health ─────────────────────────────────────────
router.get("/kommo/health", (req, res) => {
  res.json({
    ok:        true,
    kommo:     !!process.env.KOMMO_ACCESS_TOKEN,
    subdomain: process.env.KOMMO_SUBDOMAIN || "não configurado",
    gas:       !!process.env.GAS_DEPLOY_URL,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
