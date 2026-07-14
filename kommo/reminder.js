// Kommo appointment reminders - native Salesbot launcher

const { Pool } = require("pg");
const kommo = require("./client");
const SM = require("./bot/stateManager");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function tomorrowForDatabase() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function getAppointments(date) {
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
    [date]
  );
  return rows;
}

async function sendReminder(appointment) {
  const leadId = appointment.kommo_lead_id;
  const botId = process.env.KOMMO_REMINDER_SALESBOT_ID;
  if (!leadId) throw new Error("Agendamento sem lead vinculado");
  if (!botId) throw new Error("KOMMO_REMINDER_SALESBOT_ID nao configurado");

  const fieldId = Number(process.env.KOMMO_APPOINTMENT_DETAILS_FIELD_ID || 773261);
  const details = [
    `Data: ${appointment.data_agendamento}`,
    `Horario: ${appointment.horario || "a confirmar"}`,
    `Loja: ${appointment.loja || "Oticas TGT"}`,
  ].join(" | ");

  console.log(`[Reminder] Iniciando Salesbot ${botId} no lead ${leadId}`);
  await kommo.updateLead(leadId, {
    custom_fields_values: [{ field_id: fieldId, values: [{ value: details }] }],
  });
  await kommo.launchSalesbot(botId, leadId);

  SM.setState(leadId, { etapa: "lembrete_resposta" }, { persist: true });
  await kommo.addNote(
    leadId,
    `Lembrete 24h iniciado - ${appointment.data_agendamento} as ${appointment.horario}`
  );

  await pool.query(
    "UPDATE agendamentos SET lembrete_24h_em = NOW() WHERE id = $1",
    [appointment.id]
  );
}

async function runReminders() {
  if (process.env.BOT_ENABLED === "false" || process.env.REMINDER_AUTOMATION_ENABLED === "false") {
    return { enviados: 0, erros: 0, desativado: true };
  }

  const date = tomorrowForDatabase();
  console.log(`[Reminder] Buscando agendamentos para ${date}`);

  let appointments;
  try {
    appointments = await getAppointments(date);
  } catch (error) {
    console.error("[Reminder] Erro ao consultar banco:", error.message);
    return { enviados: 0, erros: 1 };
  }

  let enviados = 0;
  let erros = 0;
  for (const appointment of appointments) {
    try {
      await sendReminder(appointment);
      enviados++;
    } catch (error) {
      erros++;
      console.error(`[Reminder] Erro no lead ${appointment.kommo_lead_id}:`, error.message);
    }
    await sleep(2000);
  }

  console.log(`[Reminder] Concluido: ${enviados} enviados, ${erros} erros.`);
  return { enviados, erros };
}

function scheduleDaily(label, targetHour, job) {
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const timer = setTimeout(async () => {
      try { await job(); }
      catch (error) { console.error(`[${label}] Erro no job:`, error.message); }
      scheduleNext();
    }, next.getTime() - now.getTime());
    timer.unref?.();
    console.log(`[${label}] Proxima execucao: ${next.toString()}`);
  };
  scheduleNext();
}

function startReminderCron() {
  if (process.env.REMINDER_AUTOMATION_ENABLED === "false") {
    console.log("    Reminder: desativado para validacao");
    return;
  }
  const targetHour = Number.parseInt(process.env.REMINDER_HOUR || "8", 10);
  scheduleDaily("Reminder", targetHour, runReminders);
  console.log(`    Reminder: cron ativo (${targetHour}h)`);
}

module.exports = { startReminderCron, runReminders, scheduleDaily };
