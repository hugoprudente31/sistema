// Kommo Reminder — Sistema Óticas Target
// Cron diário: envia lembrete 24h antes do agendamento

const { Pool } = require("pg");
const kommo = require("./client");
const MSG   = require("./bot/messages");
const SM    = require("./bot/stateManager");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Amanhã no formato YYYY-MM-DD (PostgreSQL)
function dataAmanhaPG() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const dd   = String(d.getDate()).padStart(2, "0");
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${yyyy}-${mm}-${dd}`;
}

// ── Busca agendamentos de amanhã direto do banco ──────────────────
async function getAgendamentosDB(dataPg) {
  const { rows } = await pool.query(
    `SELECT id, kommo_lead_id, nome, horario, loja,
            TO_CHAR(data_agendamento, 'DD/MM/YYYY') AS data_agendamento,
            status
     FROM agendamentos
     WHERE data_agendamento = $1
       AND status IN ('Agendado', 'Confirmado')
       AND kommo_lead_id IS NOT NULL
       AND excluido_em IS NULL
       AND lembrete_24h_em IS NULL
     ORDER BY horario ASC`,
    [dataPg]
  );
  return rows;
}

// ── Envia lembrete para um agendamento ───────────────────────────
async function enviarLembrete(ag) {
  const leadId = ag.kommo_lead_id;
  if (!leadId) return;

  const state = await SM.getState(leadId);

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

  const nome    = ag.nome    || state.nome || "cliente";
  const data    = ag.data_agendamento;
  const horario = ag.horario;
  const loja    = ag.loja;

  const chatId = state.chat_id || null;
  console.log(`[Reminder] Enviando lembrete — ${nome} / lead ${leadId} / ${data} ${horario}`);

  await kommo.sendMessage(talkId, MSG.lembrete24h(nome, data, horario, loja), chatId);
  SM.setState(leadId, { etapa: "lembrete_resposta" }, { persist: true });
  await kommo.addNote(leadId, `⏰ Lembrete 24h enviado — ${data} às ${horario}`);

  // Marca no DB para evitar reenvio se Railway reiniciar
  if (ag.id) {
    await pool.query(
      `UPDATE agendamentos SET lembrete_24h_em = NOW() WHERE id = $1`,
      [ag.id]
    ).catch(e => console.error("[Reminder] Erro ao marcar lembrete_24h_em:", e.message));
  }
}

// ── Job principal ─────────────────────────────────────────────────
async function runReminders() {
  if (process.env.BOT_ENABLED === "false") return;

  const dataPg = dataAmanhaPG();
  console.log(`[Reminder] Buscando agendamentos para amanhã: ${dataPg}`);

  let agendamentos;
  try {
    agendamentos = await getAgendamentosDB(dataPg);
  } catch (e) {
    console.error("[Reminder] Erro ao consultar banco:", e.message);
    return;
  }

  console.log(`[Reminder] ${agendamentos.length} agendamento(s) encontrado(s)`);

  for (const ag of agendamentos) {
    await enviarLembrete(ag).catch(e =>
      console.error(`[Reminder] Erro no lead ${ag.kommo_lead_id}:`, e.message)
    );
    await sleep(2000);
  }

  console.log("[Reminder] Concluído.");
}

// ── Inicializa o cron (setInterval a cada 5 minutos) ──────────────
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

  setInterval(tick, 5 * 60 * 1000);
  tick();

  console.log(`    Reminder: ✅ cron ativo (roda às ${targetHour}h todos os dias)`);
}

module.exports = { startReminderCron, runReminders };
