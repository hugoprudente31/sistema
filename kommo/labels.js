// Kommo Labels (Etiquetas) — Sistema Óticas Target

const kommo = require("./client");

// Catálogo completo de etiquetas
const LABELS = {
  // Origem / controle
  BOT_ATIVO:               "bot-ativo",
  ATENDIMENTO_HUMANO:      "atendimento-humano",
  AGENDAMENTO_SOLICITADO:  "agendamento-solicitado",
  ORCAMENTO_SOLICITADO:    "orcamento-solicitado",
  INFORMACOES_SOLICITADAS: "informacoes-solicitadas",

  // Semáforo de agendamento
  AGENDADO_CONFIRMADO: "🟢 agendado-confirmado",
  AGENDADO_PENDENTE:   "🟡 agendado-pendente",
  NAO_COMPARECEU:      "🔴 nao-compareceu",
  CANCELADO:           "🔴 cancelado",

  // Temperatura do lead
  LEAD_QUENTE:    "lead-quente",
  LEAD_MORNO:     "lead-morno",
  LEAD_FRIO:      "lead-frio",

  // Funil comercial
  ORCAMENTO_ENVIADO: "orcamento-enviado",
  FECHADO_GANHO:     "fechado-ganho",
  FECHADO_PERDIDO:   "fechado-perdido",
  EM_RECUPERACAO:    "em-recuperacao",
};

// Labels do semáforo — apenas 1 pode estar ativo por vez
const SEMAPHORE_LABELS = [
  LABELS.AGENDADO_CONFIRMADO,
  LABELS.AGENDADO_PENDENTE,
  LABELS.NAO_COMPARECEU,
  LABELS.CANCELADO,
];

// Labels de temperatura — apenas 1 pode estar ativo por vez
const TEMPERATURE_LABELS = [
  LABELS.LEAD_QUENTE,
  LABELS.LEAD_MORNO,
  LABELS.LEAD_FRIO,
];

// ── Funções principais ───────────────────────────────────────────

async function applyLabel(leadId, labelName) {
  try {
    const current = await kommo.getLeadTags(leadId);
    const names   = current.map(t => t.name);
    if (names.includes(labelName)) return; // já tem, ignora
    await kommo.setLeadTags(leadId, [...names, labelName]);
    console.log(`[Labels] ✅ "${labelName}" → lead ${leadId}`);
  } catch (e) {
    console.error(`[Labels] Erro ao aplicar "${labelName}" ao lead ${leadId}:`, e.message);
  }
}

async function removeLabel(leadId, labelName) {
  try {
    const current = await kommo.getLeadTags(leadId);
    const names   = current.map(t => t.name).filter(n => n !== labelName);
    await kommo.setLeadTags(leadId, names);
    console.log(`[Labels] ❌ Removeu "${labelName}" do lead ${leadId}`);
  } catch (e) {
    console.error(`[Labels] Erro ao remover "${labelName}" do lead ${leadId}:`, e.message);
  }
}

// Remove um grupo de labels e aplica uma nova
async function swapLabel(leadId, removeGroup, applyName) {
  try {
    const current = await kommo.getLeadTags(leadId);
    const names   = current.map(t => t.name).filter(n => !removeGroup.includes(n));
    if (applyName) names.push(applyName);
    await kommo.setLeadTags(leadId, names);
    console.log(`[Labels] 🔄 Swap → lead ${leadId}: aplicou "${applyName}"`);
  } catch (e) {
    console.error(`[Labels] Erro ao trocar label no lead ${leadId}:`, e.message);
  }
}

// Atualiza o semáforo de agendamento baseado no status do GAS
// gasStatus: "Confirmado" | "Agendado" | "Não Compareceu" | "Cancelado"
async function applyTrafficLight(leadId, gasStatus) {
  const map = {
    "Confirmado":      LABELS.AGENDADO_CONFIRMADO,
    "Agendado":        LABELS.AGENDADO_PENDENTE,
    "Não Compareceu":  LABELS.NAO_COMPARECEU,
    "Cancelado":       LABELS.CANCELADO,
  };
  const semaphore = map[gasStatus];
  if (!semaphore) {
    console.log(`[Labels] Status "${gasStatus}" sem mapeamento de semáforo`);
    return;
  }
  await swapLabel(leadId, SEMAPHORE_LABELS, semaphore);
  console.log(`[Labels] 🚦 Semáforo "${semaphore}" → lead ${leadId}`);
}

// Atualiza temperatura do lead
async function applyTemperature(leadId, temperature) {
  const map = {
    quente: LABELS.LEAD_QUENTE,
    morno:  LABELS.LEAD_MORNO,
    frio:   LABELS.LEAD_FRIO,
  };
  const label = map[temperature];
  if (!label) return;
  await swapLabel(leadId, TEMPERATURE_LABELS, label);
}

// Troca bot-ativo ↔ atendimento-humano
async function setHumanControl(leadId) {
  await swapLabel(leadId, [LABELS.BOT_ATIVO], LABELS.ATENDIMENTO_HUMANO);
}

async function setBotControl(leadId) {
  await swapLabel(leadId, [LABELS.ATENDIMENTO_HUMANO], LABELS.BOT_ATIVO);
}

module.exports = {
  LABELS,
  SEMAPHORE_LABELS,
  TEMPERATURE_LABELS,
  applyLabel,
  removeLabel,
  swapLabel,
  applyTrafficLight,
  applyTemperature,
  setHumanControl,
  setBotControl,
};
