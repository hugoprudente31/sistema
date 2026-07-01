// Bot State Manager — Sistema Óticas Target
// Persiste estado de conversa no PostgreSQL (primário) e Kommo notas (fallback).

const { Pool } = require("pg");
const kommo = require("../client");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

const STATE_NOTE_PREFIX = "[BOT_STATE_V1]";

// Garante que a tabela existe com schema correto
async function ensureTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kommo_bot_states (
        lead_id     TEXT PRIMARY KEY,
        state       JSONB NOT NULL DEFAULT '{}',
        etapa       TEXT,
        loja_prefix TEXT,
        bot_active  BOOLEAN DEFAULT false,
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Migra coluna 'loja' → 'loja_prefix' se a tabela foi criada com nome antigo
    await pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='kommo_bot_states' AND column_name='loja'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='kommo_bot_states' AND column_name='loja_prefix'
        ) THEN
          ALTER TABLE kommo_bot_states RENAME COLUMN loja TO loja_prefix;
        END IF;
      END $$
    `);
    console.log("[State] ✅ Tabela kommo_bot_states verificada.");
  } catch (e) {
    console.error("[State] Erro ao garantir tabela kommo_bot_states:", e.message);
  }
}
ensureTable();

// Estado em memória: Map<leadId(string), stateObject>
const states = new Map();

// ── Estado padrão ────────────────────────────────────────────────

function defaultState(leadId) {
  return {
    lead_id:           String(leadId),
    nome:              null,
    loja:              null,
    loja_prefix:       null,
    talk_id:           null,
    chat_id:           null,
    etapa:             "boas_vindas",
    sub_etapa:         null,
    aguardando:        null,
    invalid_count:     0,
    dados_agendamento: {
      loja:    null,
      data:    null,
      horario: null,
    },
    last_human_at:  null,
    last_client_at: null,
    bot_active:     false,
    updated_at:     Date.now(),
  };
}

// ── Persistência no PostgreSQL ───────────────────────────────────

async function persistToDb(leadId, state) {
  try {
    await pool.query(
      `INSERT INTO kommo_bot_states (lead_id, state, etapa, loja_prefix, bot_active, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, NOW())
       ON CONFLICT (lead_id) DO UPDATE SET
         state        = EXCLUDED.state,
         etapa        = EXCLUDED.etapa,
         loja_prefix  = EXCLUDED.loja_prefix,
         bot_active   = EXCLUDED.bot_active,
         updated_at   = NOW()`,
      [
        String(leadId),
        JSON.stringify(state),
        state.etapa       || null,
        state.loja_prefix || state.loja || null,
        Boolean(state.bot_active),
      ]
    );
    console.log(`[State] ✅ Estado persistido — lead ${leadId} etapa=${state.etapa}`);
  } catch (e) {
    console.error(`[State] ❌ Erro ao persistir no DB — lead ${leadId}:`, e.message);
  }
}

async function loadFromDb(leadId) {
  try {
    const r = await pool.query(
      `SELECT state FROM kommo_bot_states WHERE lead_id = $1 LIMIT 1`,
      [String(leadId)]
    );
    if (!r.rows.length) return null;
    const saved = r.rows[0].state;
    return { ...defaultState(leadId), ...saved };
  } catch (e) {
    console.error(`[State] Erro ao carregar do DB — lead ${leadId}:`, e.message);
    return null;
  }
}

// ── Persistência no Kommo (fallback / redundância) ───────────────

async function persistToKommo(leadId, state) {
  const toSave = {
    lead_id:           state.lead_id,
    nome:              state.nome,
    loja:              state.loja,
    loja_prefix:       state.loja_prefix,
    talk_id:           state.talk_id,
    etapa:             state.etapa,
    sub_etapa:         state.sub_etapa,
    aguardando:        state.aguardando,
    dados_agendamento: state.dados_agendamento,
    bot_active:        state.bot_active,
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
    const json   = stateNote.params.text.replace(STATE_NOTE_PREFIX, "").trim();
    const saved  = JSON.parse(json);
    return { ...defaultState(leadId), ...saved };
  } catch {
    return null;
  }
}

// ── Leitura / escrita de estado ──────────────────────────────────

async function getState(leadId) {
  const key = String(leadId);

  // 1. Memória RAM
  if (states.has(key)) return states.get(key);

  // 2. PostgreSQL (primário)
  const fromDb = await loadFromDb(leadId);
  if (fromDb) {
    states.set(key, fromDb);
    console.log(`[State] 🗄️  Estado recuperado do DB — lead ${leadId}, etapa: ${fromDb.etapa}`);
    return fromDb;
  }

  // 3. Kommo notas (fallback para leads anteriores à migração)
  const fromKommo = await loadFromKommo(leadId);
  if (fromKommo) {
    states.set(key, fromKommo);
    // Migra para o banco imediatamente
    await persistToDb(leadId, fromKommo);
    console.log(`[State] 🔄 Estado migrado do Kommo → DB — lead ${leadId}, etapa: ${fromKommo.etapa}`);
    return fromKommo;
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

  const etapaChanged = updates.etapa && updates.etapa !== current.etapa;
  if (persist || etapaChanged) {
    // PostgreSQL (primário, assíncrono)
    persistToDb(leadId, next).catch(() => {});
    // Kommo nota (fallback, só em mudanças de etapa para não sobrecarregar)
    if (etapaChanged) {
      persistToKommo(leadId, next).catch(e =>
        console.error(`[State] Erro ao persistir nota Kommo — lead ${leadId}:`, e.message)
      );
    }
  }

  return next;
}

// ── Controle humano × bot ────────────────────────────────────────

function markHumanActivity(leadId) {
  const key     = String(leadId);
  const current = states.get(key) || defaultState(leadId);
  const next    = { ...current, last_human_at: Date.now(), bot_active: false, updated_at: Date.now() };
  states.set(key, next);
  persistToDb(leadId, next).catch(() => {});
  console.log(`[State] 👤 Atividade humana registrada — lead ${leadId}`);
}

function markClientActivity(leadId) {
  const key     = String(leadId);
  const current = states.get(key) || defaultState(leadId);
  states.set(key, { ...current, last_client_at: Date.now(), updated_at: Date.now() });
}

// Deve o bot ativar agora?
// Bot permanece bloqueado enquanto lead estiver em atendimento humano (etapa "transferido").
// Só reativa quando cliente abrir uma nova conversa — evento add_talk → processNewLead().
function shouldBotActivate(state) {
  if (!state) return false;
  return state.etapa !== "transferido";
}

function isDuringBusinessHours() {
  return true;
}

function isDuringHumanHours(loja = "") {
  const now      = new Date();
  const day      = now.getDay();
  const timeMin  = now.getHours() * 60 + now.getMinutes();
  const isGonzaga = /gonzaga|santos/i.test(loja);

  if (day === 0) return false;

  if (day === 6) {
    if (isGonzaga) return timeMin >= 10 * 60 && timeMin < 18 * 60;
    return timeMin >= 9 * 60 && timeMin < 15 * 60;
  }

  return timeMin >= 9 * 60 && timeMin < 19 * 60;
}

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
  isDuringBusinessHours,
  isDuringHumanHours,
  getChatId,
  incrementInvalidCount,
  resetInvalidCount,
};
