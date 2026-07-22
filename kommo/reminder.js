// Kommo appointment reminders - native Salesbot launcher

const { Pool } = require("pg");
const kommo = require("./client");
const SM = require("./bot/stateManager");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function firstName(name) {
  return String(name || "cliente").trim().split(/\s+/)[0] || "cliente";
}

function buildTwoHourMessage(appointment) {
  const name = firstName(appointment.nome);
  return [
    `Olá, *${name}*! 😊`,
    "",
    "Passando para lembrar que faltam cerca de *2 horas* para a sua *Avaliação Visual*. 👓✨",
    "",
    `⏰ *Horário:* ${appointment.horario || "a confirmar"}`,
    `📍 *Loja:* ${appointment.loja || "Óticas TGT"}`,
    "",
    "Estamos preparando tudo para receber você com carinho. Se precisar falar conosco, responda por aqui.",
    "",
    "Até já! 😊",
    "_Equipe Óticas TGT_",
  ].join("\n");
}

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

async function getTwoHourAppointments() {
  const { rows } = await pool.query(`
    SELECT id, kommo_lead_id, nome, horario, loja, data_agendamento, status
      FROM agendamentos
     WHERE status IN ('Agendado', 'Confirmado')
       AND kommo_lead_id IS NOT NULL
       AND excluido_em IS NULL
       AND lembrete_2h_em IS NULL
       AND horario ~ '^\\d{2}:\\d{2}$'
       AND ((data_agendamento::text || ' ' || horario)::timestamp AT TIME ZONE 'America/Sao_Paulo')
           > NOW() + INTERVAL '105 minutes'
       AND ((data_agendamento::text || ' ' || horario)::timestamp AT TIME ZONE 'America/Sao_Paulo')
           <= NOW() + INTERVAL '125 minutes'
     ORDER BY data_agendamento, horario, id
  `);
  return rows;
}

async function sendTwoHourReminder(appointment) {
  if (!appointment.kommo_lead_id) throw new Error("Agendamento sem lead vinculado");
  const message = buildTwoHourMessage(appointment);
  await kommo.sendMessageToLead(String(appointment.kommo_lead_id), message);
  await kommo.addNote(
    String(appointment.kommo_lead_id),
    `Lembrete 2h enviado - ${appointment.data_agendamento} as ${appointment.horario}`
  ).catch(() => null);
  await pool.query(
    "UPDATE agendamentos SET lembrete_2h_em = NOW() WHERE id = $1 AND lembrete_2h_em IS NULL",
    [appointment.id]
  );
}

async function runTwoHourReminders() {
  if (process.env.BOT_ENABLED === "false" || process.env.REMINDER_2H_AUTOMATION_ENABLED === "false") {
    return { enviados: 0, erros: 0, desativado: true };
  }

  let appointments;
  try {
    appointments = await getTwoHourAppointments();
  } catch (error) {
    console.error("[Reminder2h] Erro ao consultar banco:", error.message);
    return { enviados: 0, erros: 1 };
  }

  let enviados = 0;
  let erros = 0;
  for (const appointment of appointments) {
    try {
      await sendTwoHourReminder(appointment);
      enviados++;
    } catch (error) {
      erros++;
      console.error(`[Reminder2h] Erro no agendamento ${appointment.id}:`, error.message);
    }
    await sleep(800);
  }
  if (appointments.length) console.log(`[Reminder2h] Concluido: ${enviados} enviados, ${erros} erros.`);
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

function scheduleEveryMinutes(label, minutes, job) {
  const intervalMs = Math.max(1, Number(minutes) || 5) * 60 * 1000;
  const execute = async () => {
    try { await job(); }
    catch (error) { console.error(`[${label}] Erro no job:`, error.message); }
  };
  execute();
  const timer = setInterval(execute, intervalMs);
  timer.unref?.();
  console.log(`[${label}] Verificacao ativa a cada ${Math.round(intervalMs / 60000)} minuto(s)`);
}

function startReminderCron() {
  if (process.env.REMINDER_AUTOMATION_ENABLED === "false") {
    console.log("    Reminder: desativado para validacao");
  } else {
    const targetHour = Number.parseInt(process.env.REMINDER_HOUR || "8", 10);
    scheduleDaily("Reminder", targetHour, runReminders);
    console.log(`    Reminder: cron ativo (${targetHour}h)`);
  }
  if (process.env.REMINDER_2H_AUTOMATION_ENABLED !== "false") {
    const intervalMinutes = Number.parseInt(process.env.REMINDER_2H_INTERVAL_MINUTES || "5", 10);
    scheduleEveryMinutes("Reminder2h", intervalMinutes, runTwoHourReminders);
  }
}

module.exports = {
  startReminderCron,
  runReminders,
  runTwoHourReminders,
  buildTwoHourMessage,
  scheduleDaily,
  scheduleEveryMinutes,
};
