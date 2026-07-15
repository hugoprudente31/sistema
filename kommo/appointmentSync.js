const kommo = require("./client");
const scheduling = require("./scheduling");

const DEFAULT_STAGES_MAP = {
  "9511355": { agendamento: 103341012 },
  "9907903": { agendamento: 103341100 },
  "12931092": { agendamento: 103341140 },
  "12931096": { agendamento: 103340708 },
};

const STORE_BY_PIPELINE = {
  "9511355": "óticas Target - Ademar de Barros",
  "9907903": "óticas TGT - Gonzaga",
  "12931092": "óticas TGT Enseada",
  "12931096": "óticas TGT Pitangueiras",
};

function clean(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function normalizeKey(value) {
  return clean(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

function stagesMap() {
  try {
    const configured = process.env.KOMMO_STAGES_MAP
      ? JSON.parse(process.env.KOMMO_STAGES_MAP)
      : null;
    return configured && Object.keys(configured).length ? configured : DEFAULT_STAGES_MAP;
  } catch {
    return DEFAULT_STAGES_MAP;
  }
}

function appointmentStageForPipeline(pipelineId) {
  const stage = stagesMap()[String(pipelineId)] || {};
  return clean(stage.agendamento || stage.agendado || process.env.KOMMO_STAGE_AGENDAR);
}

function isAppointmentStage(pipelineId, statusId) {
  const expected = appointmentStageForPipeline(pipelineId);
  return !!expected && expected === clean(statusId);
}

function readCustomField(fields, aliases, configuredId) {
  const aliasKeys = new Set(aliases.map(normalizeKey));
  const wantedId = clean(configuredId);
  const field = (Array.isArray(fields) ? fields : []).find((item) => {
    if (wantedId && clean(item.field_id) === wantedId) return true;
    return aliasKeys.has(normalizeKey(item.field_code)) || aliasKeys.has(normalizeKey(item.field_name));
  });
  return field?.values?.[0]?.value ?? "";
}

function normalizeDate(value) {
  if (typeof value === "number" || /^\d{10}$/.test(clean(value))) {
    const date = new Date(Number(value) * 1000);
    if (!Number.isNaN(date.getTime())) return date.toISOString().slice(0, 10);
  }
  return clean(value);
}

function normalizeTime(value) {
  const raw = clean(value).toLowerCase();
  const match = raw.match(/^(\d{1,2})(?::|h)(\d{2})$/) || raw.match(/^(\d{1,2})$/);
  if (!match) return raw;
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2] || "00"}`;
}

function contactField(contact, fieldCode) {
  const field = (contact?.custom_fields_values || []).find(
    (item) => normalizeKey(item.field_code) === normalizeKey(fieldCode)
  );
  return field?.values?.[0]?.value || "";
}

async function syncLeadAppointment(leadId, event = {}, deps = {}) {
  const kommoClient = deps.kommo || kommo;
  const schedulingService = deps.scheduling || scheduling;
  const lead = await kommoClient.getLead(leadId);
  const pipelineId = clean(lead?.pipeline_id || event.pipeline_id);
  const statusId = clean(lead?.status_id || event.status_id);

  if (!isAppointmentStage(pipelineId, statusId)) {
    return { ok: true, skipped: true, reason: "stage_not_appointment", pipelineId, statusId };
  }

  const fields = lead?.custom_fields_values || [];
  const loja = clean(readCustomField(fields, ["LOJA", "UNIDADE"], process.env.KOMMO_STORE_FIELD_ID))
    || STORE_BY_PIPELINE[pipelineId]
    || "";
  const data = normalizeDate(readCustomField(
    fields,
    ["DATA_AGENDAMENTO", "DATA AGENDAMENTO", "DATA DO AGENDAMENTO"],
    process.env.KOMMO_APPOINTMENT_DATE_FIELD_ID
  ));
  const horario = normalizeTime(readCustomField(
    fields,
    ["HORARIO", "HORÁRIO", "HORA AGENDAMENTO", "HORARIO AGENDAMENTO"],
    process.env.KOMMO_APPOINTMENT_TIME_FIELD_ID
  ));
  const optometrista = clean(readCustomField(
    fields,
    ["OPTOMETRISTA"],
    process.env.KOMMO_OPTOMETRIST_FIELD_ID
  ));

  if (!data || !horario) {
    const error = "Preencha DATA_AGENDAMENTO e HORARIO no lead antes de confirmar o agendamento.";
    await kommoClient.addNote(leadId, `⚠️ ${error}`).catch(() => {});
    return { ok: false, error, missingFields: true };
  }

  const contactId = lead?._embedded?.contacts?.[0]?.id;
  const contact = contactId && kommoClient.getContact
    ? await kommoClient.getContact(contactId).catch(() => null)
    : null;

  const result = await schedulingService.criarAgendamento({
    nome: clean(contact?.name || lead?.name || "Sem nome"),
    whatsapp: contactField(contact, "PHONE"),
    email: contactField(contact, "EMAIL"),
    loja,
    data,
    horario,
    leadId: String(leadId),
    optometrista,
  });

  if (!result?.ok) {
    await kommoClient.addNote(leadId, `⚠️ Agendamento não gravado no sistema: ${result?.error || "erro desconhecido"}`).catch(() => {});
    return result || { ok: false, error: "Falha ao gravar agendamento." };
  }

  if (!result.unchanged) {
    const details = `Data: ${result.data_agendamento} | Horário: ${result.horario} | Loja: ${result.loja}`;
    const detailsFieldId = Number(process.env.KOMMO_APPOINTMENT_DETAILS_FIELD_ID || 773261);
    await kommoClient.updateLead(leadId, {
      custom_fields_values: [{ field_id: detailsFieldId, values: [{ value: details }] }],
    }).catch(() => {});
    await kommoClient.addNote(
      leadId,
      `✅ Agendamento sincronizado com o sistema\n📅 ${result.data_agendamento} às ${result.horario}\n🏪 ${result.loja}\n👁 ${result.optometrista || "A definir"}`
    ).catch(() => {});
  }

  return result;
}

module.exports = {
  syncLeadAppointment,
  isAppointmentStage,
  appointmentStageForPipeline,
  readCustomField,
  normalizeDate,
  normalizeTime,
  STORE_BY_PIPELINE,
};
