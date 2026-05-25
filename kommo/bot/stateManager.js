// Bot State Manager — Sistema Óticas Target
// Mantém o estado da conversa de cada lead em memória
// e persiste no Kommo como nota para sobreviver a restarts

const kommo = require("../client");

const STATE_NOTE_PREFIX = "[BOT_STATE_V1]";

// Estado em memória: Map<leadId(string), stateObject>
const states = new Map();

// ── Estado padrão ────────────────────────────────────────────────

function defaultState(leadId) {
  return {
    lead_id:           String(leadId),
    nome:              null,
    loja:              null,
    talk_id:           null,   // ID numérico da conversa Kommo
    chat_id:           null,   // UUID do canal de chat (para envio de mensagens)
    etapa:             "boas_vindas",
    sub_etapa:         null,
    aguardando:        null,   // campo que o bot está esperando o lead responder
    invalid_count:     0,      // respostas fora do menu esperado
    dados_agendamento: {
      loja:    null,
      data:    null,
      horario: null,
    },
    last_human_at:  null,      // timestamp da última mensagem de humano (atendente)
    last_client_at: null,      // timestamp da última mensagem do cliente
    bot_active:     false,
    updated_at:     Date.now(),
  };
}

// ── Leitura / escrita de estado ──────────────────────────────────

async function getState(leadId) {
  const key = String(leadId);

  if (states.has(key)) return states.get(key);

  // Tenta recuperar do Kommo após restart
  const recovered = await loadFromKommo(leadId);
  if (recovered) {
    states.set(key, recovered);
    console.log(`[State] 🔄 Estado recuperado do Kommo — lead ${leadId}, etapa: ${recovered.etapa}`);
    return recovered;
  }

  const fresh = defaultState(leadId);
  states.set(key, fresh);
  return fresh;
}

function setState(leadId, updates, { persist = false } = {}) {
  const key     = String(leadId);
  const current = states.get(key) || defaultState(leadId);
  const next    = { ...current, ...updates, updated_at: Date.now() };
  states.set(key, next);

  // Persiste quando a etapa muda ou quando explicitamente solicitado
  const etapaChanged = updates.etapa && updates.etapa !== current.etapa;
  if (persist || etapaChanged) {
    persistToKommo(leadId, next).catch(e =>
      console.error(`[State] Erro ao persistir lead ${leadId}:`, e.message)
    );
  }

  return next;
}

// ── Persistência no Kommo ────────────────────────────────────────

async function persistToKommo(leadId, state) {
  // Salva apenas campos essenciais para recuperação (não timestamps voláteis)
  const toSave = {
    lead_id:           state.lead_id,
    nome:              state.nome,
    loja:              state.loja,
    talk_id:           state.talk_id,
    etapa:             state.etapa,
    sub_etapa:         state.sub_etapa,
    aguardando:        state.aguardando,
    dados_agendamento: state.dados_agendamento,
    updated_at:        state.updated_at,
  };
  const text = `${STATE_NOTE_PREFIX} ${JSON.stringify(toSave)}`;
  await kommo.addServiceNote(leadId, text);
}

async function loadFromKommo(leadId) {
  const notes = await kommo.getLeadNotes(leadId);

  const stateNote = notes.find(n => n.params?.text?.startsWith(STATE_NOTE_PREFIX));
  if (!stateNote) return null;

  try {
    const json = stateNote.params.text.replace(STATE_NOTE_PREFIX, "").trim();
    const saved = JSON.parse(json);
    // Mescla com defaultState para garantir campos novos que possam ter sido adicionados
    return { ...defaultState(leadId), ...saved };
  } catch {
    return null;
  }
}

// ── Controle humano × bot ────────────────────────────────────────

// Registra que um atendente humano enviou uma mensagem neste lead
function markHumanActivity(leadId) {
  const key = String(leadId);
  const current = states.get(key) || defaultState(leadId);
  states.set(key, {
    ...current,
    last_human_at: Date.now(),
    bot_active:    false,
    updated_at:    Date.now(),
  });
  console.log(`[State] 👤 Atividade humana registrada — lead ${leadId}`);
}

// Registra mensagem do cliente
function markClientActivity(leadId) {
  const key = String(leadId);
  const current = states.get(key) || defaultState(leadId);
  states.set(key, { ...current, last_client_at: Date.now(), updated_at: Date.now() });
}

// Deve o bot ativar agora?
// Regra 1: nenhum humano respondeu ainda
// Regra 2: último humano foi há mais de BOT_HUMAN_TIMEOUT_MIN minutos
function shouldBotActivate(state) {
  if (!state) return false;
  const timeoutMs = (parseInt(process.env.BOT_HUMAN_TIMEOUT_MIN) || 5) * 60 * 1000;
  if (!state.last_human_at) return true;
  return Date.now() - state.last_human_at > timeoutMs;
}

// Deve o bot retomar de onde o humano parou?
// Regra: humano estava ativo mas ficou sem responder por BOT_HUMAN_RESUME_MIN minutos
function shouldBotResume(state) {
  if (!state) return false;
  const resumeMs = (parseInt(process.env.BOT_HUMAN_RESUME_MIN) || 15) * 60 * 1000;
  if (!state.last_human_at) return true;
  return Date.now() - state.last_human_at > resumeMs;
}

// Sempre disponível — bot funciona 24h
function isDuringBusinessHours() {
  return true;
}

// Horário de atendimento humano por loja
// Gonzaga & Santos: Seg-Sex 9h-19h | Sáb 10h-18h | Dom fechado
// Demais lojas:     Seg-Sex 9h-19h | Sáb 9h-15h  | Dom fechado
function isDuringHumanHours(loja = "") {
  const now      = new Date();
  const day      = now.getDay(); // 0=Dom, 6=Sáb
  const timeMin  = now.getHours() * 60 + now.getMinutes();
  const isGonzaga = /gonzaga|santos/i.test(loja);

  if (day === 0) return false; // Domingo fechado

  if (day === 6) { // Sábado
    if (isGonzaga) return timeMin >= 10 * 60 && timeMin < 18 * 60;
    return timeMin >= 9 * 60 && timeMin < 15 * 60;
  }

  // Seg–Sex: 9h–19h
  return timeMin >= 9 * 60 && timeMin < 19 * 60;
}

// Incrementa contador de respostas inválidas e retorna o novo valor
function incrementInvalidCount(leadId) {
  const key     = String(leadId);
  const current = states.get(key) || defaultState(leadId);
  const count   = (current.invalid_count || 0) + 1;
  states.set(key, { ...current, invalid_count: count, updated_at: Date.now() });
  return count;
}

function resetInvalidCount(leadId) {
  setState(leadId, { invalid_count: 0 });
}

function getChatId(leadId) {
  return states.get(String(leadId))?.chat_id || null;
}

module.exports = {
  getState,
  setState,
  markHumanActivity,
  markClientActivity,
  shouldBotActivate,
  shouldBotResume,
  isDuringBusinessHours,
  isDuringHumanHours,
  getChatId,
  incrementInvalidCount,
  resetInvalidCount,
};
