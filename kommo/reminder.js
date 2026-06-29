// Kommo Reminder — Sistema Óticas Target
// Cron diário: envia lembrete 24h antes do agendamento

const { Pool } = require("pg");
const kommo   = require("./client");
const MSG     = require("./bot/messages");
const SM      = require("./bot/stateManager");

const GAS_URL     = () => process.env.GAS_DEPLOY_URL || "";
const GAS_API_KEY = () => process.env.GAS_API_KEY    || "";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Amanhã em dois formatos: DD/MM/YYYY (GAS) e YYYY-MM-DD (PostgreSQL)
function datasAmanha() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const dd   = String(d.getDate()).padStart(2, "0");
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return {
    br: `${dd}/${mm}/${yyyy}`,   // formato GAS
    pg: `${yyyy}-${mm}-${dd}`,   // formato PostgreSQL
  };
}

// ── Fonte 1: Google Apps Script (agendamentos via site/formulário) ──
async function getAgendamentosGAS() {
  if (!GAS_URL()) return [];
  try {
    const params = new URLSearchParams({
      format: "api", fn: "getAgendamentos",
      key: GAS_API_KEY(), args: "[]",
    });
    const res  = await fetch(`${GAS_URL()}?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.data) ? data.data : [];
  } catch (e) {
    console.error("[Reminder] Erro ao buscar GAS:", e.message);
    return [];
  }
}

// ── Fonte 2: PostgreSQL (agendamentos via Kommo bot/atendente) ──
async function getAgendamentosDB(dataPg) {
  try {
    const { rows } = await pool.query(
      `SELECT kommo_lead_id, nome, horario, loja,
              TO_CHAR(data_agendamento, 'DD/MM/YYYY') AS data_agendamento,
              status
       FROM agendamentos
       WHERE data_agendamento = $1
         AND status IN ('Agendado', 'Confirmado')
         AND kommo_lead_id IS NOT NULL
         AND excluido_em IS NULL`,
      [dataPg]
    );
    console.log(`[Reminder] PostgreSQL: ${rows.length} agendamento(s) encontrado(s)`);
    return rows;
  } catch (e) {
    console.error("[Reminder] Erro ao buscar PostgreSQL:", e.message);
    return [];
  }
}

// ── Mescla GAS + DB sem duplicatas (chave: kommo_lead_id) ──
function mesclarAgendamentos(gasLista, dbLista) {
  const mapa = new Map();

  // DB tem prioridade — dados mais recentes e confiáveis
  for (const ag of dbLista) {
    mapa.set(String(ag.kommo_lead_id), ag);
  }

  // GAS complementa apenas o que não está no banco
  for (const ag of gasLista) {
    const id = String(ag.kommo_lead_id);
    if (!mapa.has(id)) mapa.set(id, ag);
  }

  return [...mapa.values()];
}

// ── Envia lembrete para um agendamento ──────────────────────────

async function enviarLembrete(ag) {
  const leadId = ag.kommo_lead_id;
  if (!leadId) return;

  const state = await SM.getState(leadId);

  // Tenta obter talkId do estado ou do Kommo
  let talkId = state.talk_id;
  if (!talkId) {
    const talks = await kommo.getLeadTalks(leadId).catch(() => []);
    if (!talks.length) {
      console.log(`[Reminder] Lead ${leadId} sem conversa ativa — pulando`);
      return;
    }
    talkId = String(talks[0].id);
    SM.setState(leadId, { talk_id: talkId });
  }

  const nome    = ag.nome    || state.nome    || "cliente";
  const data    = ag.data_agendamento;
  const horario = ag.horario;
  const loja    = ag.loja;

  console.log(`[Reminder] Enviando lembrete — ${nome} / lead ${leadId} / ${data} ${horario}`);

  await kommo.sendMessage(talkId, MSG.lembrete24h(nome, data, horario, loja));
  SM.setState(leadId, { etapa: "lembrete_resposta" }, { persist: true });
  await kommo.addNote(leadId, `⏰ Lembrete 24h enviado — ${data} às ${horario}`);
}

// ── Job principal ────────────────────────────────────────────────

async function runReminders() {
  if (process.env.BOT_ENABLED === "false") return;

  const { br: alvoBR, pg: alvoPG } = datasAmanha();
  console.log(`[Reminder] Buscando agendamentos para amanhã: ${alvoBR}`);

  // Consulta as duas fontes em paralelo
  const [gasLista, dbLista] = await Promise.all([
    getAgendamentosGAS(),
    getAgendamentosDB(alvoPG),
  ]);

  // Filtra GAS pela data e status (banco já vem filtrado pela query)
  const gasFiltrados = gasLista.filter(a =>
    a.data_agendamento === alvoBR &&
    ["Agendado", "Confirmado"].includes(a.status) &&
    a.kommo_lead_id
  );

  const paraLembrar = mesclarAgendamentos(gasFiltrados, dbLista);

  console.log(`[Reminder] GAS: ${gasFiltrados.length} | Banco: ${dbLista.length} | Total único: ${paraLembrar.length}`);

  for (const ag of paraLembrar) {
    await enviarLembrete(ag).catch(e =>
      console.error(`[Reminder] Erro no lead ${ag.kommo_lead_id}:`, e.message)
    );
    await sleep(2000); // evita flood de mensagens
  }

  console.log("[Reminder] Concluído.");
}

// ── Inicializa o cron (setInterval a cada 5 minutos) ─────────────

let reminderLastRunDate = null;

function startReminderCron() {
  const targetHour = parseInt(process.env.REMINDER_HOUR || "8");

  const tick = () => {
    const now   = new Date();
    const today = now.toDateString();
    const hora  = now.getHours();

    if (hora >= targetHour && reminderLastRunDate !== today) {
      reminderLastRunDate = today;
      runReminders().catch(e => console.error("[Reminder] Erro no job:", e.message));
    }
  };

  setInterval(tick, 5 * 60 * 1000); // verifica a cada 5 minutos
  tick(); // verifica imediatamente ao subir (caso já seja hora)

  console.log(`    Reminder: ✅ cron ativo (roda às ${targetHour}h todos os dias)`);
}

module.exports = { startReminderCron, runReminders };
