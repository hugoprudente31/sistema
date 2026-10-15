"use strict";

const { pool } = require("./db");
const { runMonitoredJob } = require("./jobMonitor");
const whatsapp = require("./whatsappCloud");

const normalize = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function recipients() {
  let parsed;
  try { parsed = JSON.parse(process.env.WHATSAPP_OPERATIONAL_RECIPIENTS || "[]"); }
  catch { throw new Error("WHATSAPP_OPERATIONAL_RECIPIENTS deve ser um JSON válido"); }
  if (!Array.isArray(parsed)) throw new Error("WHATSAPP_OPERATIONAL_RECIPIENTS deve ser uma lista");
  return parsed.map((item) => ({
    nome: String(item?.nome || "Responsável").trim(),
    whatsapp: whatsapp.digits(item?.whatsapp),
    perfil: String(item?.perfil || "").trim(),
    loja: String(item?.loja || "").trim(),
    todasLojas: item?.todasLojas === true,
  })).filter((item) => item.whatsapp.length >= 12);
}

function recipientsForStore(store, { reports = false } = {}) {
  const key = normalize(store);
  return recipients().filter((person) => {
    if (person.todasLojas) return reports;
    return person.loja && normalize(person.loja) === key;
  });
}

async function reserveNotification({ type, key, appointmentId = null, store, recipient, payload }) {
  const result = await pool.query(`
    INSERT INTO whatsapp_notificacoes_operacionais
      (tipo, chave, agendamento_id, loja, destinatario_nome, destinatario_whatsapp, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (tipo, chave, destinatario_whatsapp) DO UPDATE
      SET status='pendente', erro=NULL, payload=EXCLUDED.payload, atualizado_em=NOW()
      WHERE whatsapp_notificacoes_operacionais.status='erro'
        AND whatsapp_notificacoes_operacionais.tentativas < 3
        AND whatsapp_notificacoes_operacionais.atualizado_em <= NOW() - INTERVAL '10 minutes'
    RETURNING id`,
    [type, key, appointmentId, store || null, recipient.nome, recipient.whatsapp, payload]
  );
  return result.rows[0]?.id || null;
}

async function completeNotification(id, result) {
  await pool.query(`UPDATE whatsapp_notificacoes_operacionais
    SET status='enviado', tentativas=tentativas+1, provider_message_id=$2,
        enviado_em=NOW(), atualizado_em=NOW(), erro=NULL WHERE id=$1`,
    [id, result.id || null]);
}

async function failNotification(id, error) {
  await pool.query(`UPDATE whatsapp_notificacoes_operacionais
    SET status='erro', tentativas=tentativas+1, erro=$2, atualizado_em=NOW() WHERE id=$1`,
    [id, String(error.message || error).slice(0, 1000)]);
}

async function dispatch({ type, key, appointmentId, store, recipient, template, parameters, payload }) {
  const id = await reserveNotification({ type, key, appointmentId, store, recipient, payload });
  if (!id) return { skipped: true };
  try {
    const result = await whatsapp.sendTemplate(recipient.whatsapp, template, parameters);
    await completeNotification(id, result);
    return { sent: true };
  } catch (error) {
    await failNotification(id, error);
    throw error;
  }
}

async function getPendingAttendance(toleranceMinutes) {
  const { rows } = await pool.query(`SELECT id,nome,loja,TO_CHAR(data_agendamento,'DD/MM/YYYY') data_agendamento,horario
    FROM agendamentos a
    WHERE a.excluido_em IS NULL
      AND COALESCE(a.compareceu,'Pendente') ILIKE 'Pendente'
      AND a.data_agendamento IS NOT NULL AND COALESCE(a.horario,'') ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
      AND ((a.data_agendamento::text || ' ' || a.horario)::timestamp AT TIME ZONE 'America/Sao_Paulo')
          <= NOW() - ($1 * INTERVAL '1 minute')
      AND a.data_agendamento >= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY a.data_agendamento,a.horario,a.id`, [toleranceMinutes]);
  return rows;
}

async function getPendingSales(delayMinutes) {
  const { rows } = await pool.query(`SELECT id,nome,loja,TO_CHAR(data_agendamento,'DD/MM/YYYY') data_agendamento,horario
    FROM agendamentos a
    WHERE a.excluido_em IS NULL
      AND (LOWER(COALESCE(a.compareceu,'')) IN ('sim','compareceu','true','1')
        OR LOWER(COALESCE(a.status,'')) IN ('compareceu','concluído','concluido'))
      AND COALESCE(a.valor_venda,0)=0 AND NULLIF(TRIM(COALESCE(a.numero_os,'')),'') IS NULL
      AND LOWER(COALESCE(a.venda_gerada,'')) NOT IN ('sim','nao','não','true','false','1','0')
      AND a.atualizado_em <= NOW() - ($1 * INTERVAL '1 minute')
      AND a.data_agendamento >= CURRENT_DATE - INTERVAL '1 day'
    ORDER BY a.atualizado_em,a.id`, [delayMinutes]);
  return rows;
}

async function runPendingAlerts() {
  if (process.env.WHATSAPP_OPERATIONAL_ENABLED !== "true") return { desativado: true, enviados: 0, erros: 0 };
  if (!whatsapp.isConfigured()) throw new Error("WhatsApp Cloud API não configurada para alertas operacionais");
  const attendance = await getPendingAttendance(Number(process.env.ATTENDANCE_PENDING_TOLERANCE_MINUTES || 20));
  const sales = await getPendingSales(Number(process.env.SALE_RESULT_PENDING_MINUTES || 30));
  let enviados = 0; let erros = 0;
  for (const item of attendance) {
    for (const recipient of recipientsForStore(item.loja)) {
      try {
        const result = await dispatch({ type: "comparecimento_pendente", key: String(item.id), appointmentId: item.id,
          store: item.loja, recipient, template: process.env.WHATSAPP_PENDING_TEMPLATE || "tgt_pendencia_operacional",
          parameters: [recipient.nome, "Comparecimento pendente", item.nome, item.loja, `${item.data_agendamento} ${item.horario}`], payload: item });
        if (result.sent) enviados++;
      } catch (error) { erros++; console.error(`[WhatsAppOperacional] ${item.id}:`, error.message); }
    }
  }
  for (const item of sales) {
    for (const recipient of recipientsForStore(item.loja)) {
      try {
        const result = await dispatch({ type: "resultado_venda_pendente", key: String(item.id), appointmentId: item.id,
          store: item.loja, recipient, template: process.env.WHATSAPP_PENDING_TEMPLATE || "tgt_pendencia_operacional",
          parameters: [recipient.nome, "Resultado comercial pendente", item.nome, item.loja, `${item.data_agendamento} ${item.horario}`], payload: item });
        if (result.sent) enviados++;
      } catch (error) { erros++; console.error(`[WhatsAppOperacional] ${item.id}:`, error.message); }
    }
  }
  return { processados: attendance.length + sales.length, enviados, erros };
}

async function dailyMetrics(date) {
  const { rows } = await pool.query(`SELECT COALESCE(NULLIF(loja,''),'Sem loja') loja,
    COUNT(*)::int agendados,
    COUNT(*) FILTER (WHERE LOWER(COALESCE(compareceu,'')) IN ('sim','compareceu','true','1')
      OR LOWER(COALESCE(status,'')) IN ('compareceu','concluído','concluido'))::int compareceram,
    COUNT(*) FILTER (WHERE LOWER(COALESCE(venda_gerada,'')) IN ('sim','true','1') OR COALESCE(valor_venda,0)>0)::int venderam,
    COUNT(*) FILTER (WHERE COALESCE(valor_venda,0)>0 OR NULLIF(TRIM(COALESCE(numero_os,'')),'') IS NOT NULL)::int vendas_registradas
    FROM agendamentos WHERE excluido_em IS NULL AND data_agendamento=$1::date
    GROUP BY COALESCE(NULLIF(loja,''),'Sem loja') ORDER BY loja`, [date]);
  return rows;
}

function reportText(date, row) {
  const conversion = Number(row.compareceram) ? Math.round(Number(row.venderam) * 100 / Number(row.compareceram)) : 0;
  const pending = Math.max(0, Number(row.venderam) - Number(row.vendas_registradas));
  return `${date} | ${row.loja}\nAgendados: ${row.agendados}\nCompareceram: ${row.compareceram}\nVenderam: ${row.venderam}\nVendas registradas: ${row.vendas_registradas}\nConversão: ${conversion}%\nPendências: ${pending}`;
}

async function runDailyReports(date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date())) {
  if (process.env.WHATSAPP_OPERATIONAL_ENABLED !== "true") return { desativado: true, enviados: 0, erros: 0 };
  if (!whatsapp.isConfigured()) throw new Error("WhatsApp Cloud API não configurada para relatórios");
  const metrics = await dailyMetrics(date);
  let enviados = 0; let erros = 0;
  for (const row of metrics) {
    for (const recipient of recipientsForStore(row.loja, { reports: true })) {
      try {
        const result = await dispatch({ type: "relatorio_diario", key: `${date}:${normalize(row.loja)}`, store: row.loja,
          recipient, template: process.env.WHATSAPP_DAILY_REPORT_TEMPLATE || "tgt_relatorio_diario",
          parameters: [recipient.nome, reportText(date, row)], payload: row });
        if (result.sent) enviados++;
      } catch (error) { erros++; console.error(`[WhatsAppRelatorio] ${row.loja}:`, error.message); }
    }
  }
  return { processados: metrics.length, enviados, erros };
}

function scheduleEveryMinutes(label, minutes, job) {
  const interval = Math.max(1, Number(minutes) || 5) * 60000;
  const execute = () => job().catch((error) => console.error(`[${label}]`, error.message));
  execute();
  const timer = setInterval(execute, interval); timer.unref?.();
}

function startOperationalWhatsappCron() {
  if (process.env.WHATSAPP_OPERATIONAL_ENABLED !== "true") return;
  scheduleEveryMinutes("WhatsAppPendencias", process.env.WHATSAPP_OPERATIONAL_INTERVAL_MINUTES || 5,
    () => runMonitoredJob("whatsapp_pendencias", runPendingAlerts));
  scheduleEveryMinutes("WhatsAppRelatorioDiario", 15, async () => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
    if (hour >= Number(process.env.WHATSAPP_DAILY_REPORT_HOUR || 19)) {
      await runMonitoredJob("whatsapp_relatorio_diario", runDailyReports);
    }
  });
}

module.exports = { recipients, recipientsForStore, reportText, runPendingAlerts, runDailyReports, startOperationalWhatsappCron };
