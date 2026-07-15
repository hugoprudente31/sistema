const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const scheduling = require("../kommo/scheduling");
const {
  syncLeadAppointment,
  isAppointmentStage,
  readCustomField,
  normalizeDate,
  normalizeTime,
} = require("../kommo/appointmentSync");

test("reconhece o estágio de agendamento das quatro lojas", () => {
  assert.equal(isAppointmentStage("9511355", "103341012"), true);
  assert.equal(isAppointmentStage("9907903", "103341100"), true);
  assert.equal(isAppointmentStage("12931092", "103341140"), true);
  assert.equal(isAppointmentStage("12931096", "103340708"), true);
  assert.equal(isAppointmentStage("9511355", "108252660"), false);
});

test("lê campos personalizados do Kommo por nome, código ou id", () => {
  const fields = [
    { field_id: 10, field_name: "Data do Agendamento", values: [{ value: "20/07/2026" }] },
    { field_id: 11, field_code: "HORARIO", values: [{ value: "10:15" }] },
  ];
  assert.equal(readCustomField(fields, ["DATA_AGENDAMENTO", "DATA DO AGENDAMENTO"]), "20/07/2026");
  assert.equal(readCustomField(fields, ["HORARIO"]), "10:15");
  assert.equal(readCustomField(fields, ["IGNORADO"], "10"), "20/07/2026");
  assert.equal(normalizeDate(1784505600), "2026-07-20");
  assert.equal(normalizeTime("9:30"), "09:30");
});

test("evento de mudança de etapa grava o agendamento no banco compartilhado", async () => {
  const calls = { notes: [], updates: [], create: [] };
  const fakeKommo = {
    async getLead() {
      return {
        name: "Lead",
        pipeline_id: 12931092,
        status_id: 103341140,
        custom_fields_values: [
          { field_name: "DATA_AGENDAMENTO", values: [{ value: "20/07/2026" }] },
          { field_name: "HORÁRIO", values: [{ value: "10:15" }] },
        ],
        _embedded: { contacts: [{ id: 77 }] },
      };
    },
    async getContact() {
      return {
        name: "Cliente Kommo",
        custom_fields_values: [
          { field_code: "PHONE", values: [{ value: "+55 13 99999-0000" }] },
          { field_code: "EMAIL", values: [{ value: "cliente@example.com" }] },
        ],
      };
    },
    async addNote(_leadId, text) { calls.notes.push(text); },
    async updateLead(_leadId, body) { calls.updates.push(body); },
  };
  const fakeScheduling = {
    async criarAgendamento(payload) {
      calls.create.push(payload);
      return {
        ok: true, created: true, id: 501,
        data_agendamento: "20/07/2026", horario: "10:15",
        loja: "óticas TGT Enseada", optometrista: "Melina",
      };
    },
  };

  const result = await syncLeadAppointment("12345", {}, { kommo: fakeKommo, scheduling: fakeScheduling });
  assert.equal(result.ok, true);
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].leadId, "12345");
  assert.equal(calls.create[0].loja, "óticas TGT Enseada");
  assert.equal(calls.create[0].horario, "10:15");
  assert.equal(calls.create[0].whatsapp, "+55 13 99999-0000");
  assert.equal(calls.updates.length, 1);
  assert.match(calls.notes[0], /sincronizado com o sistema/);
});

test("evento repetido é idempotente e não duplica atualização no Kommo", async () => {
  let notes = 0;
  let updates = 0;
  const fakeKommo = {
    async getLead() {
      return {
        pipeline_id: 9511355,
        status_id: 103341012,
        custom_fields_values: [
          { field_code: "DATA_AGENDAMENTO", values: [{ value: "2026-07-20" }] },
          { field_code: "HORARIO", values: [{ value: "10:00" }] },
        ],
      };
    },
    async addNote() { notes += 1; },
    async updateLead() { updates += 1; },
  };
  const fakeScheduling = {
    async criarAgendamento() {
      return { ok: true, unchanged: true, id: 10, data_agendamento: "20/07/2026", horario: "10:00", loja: "óticas Target - Ademar de Barros" };
    },
  };
  const result = await syncLeadAppointment("88", {}, { kommo: fakeKommo, scheduling: fakeScheduling });
  assert.equal(result.unchanged, true);
  assert.equal(notes, 0);
  assert.equal(updates, 0);
});

test("Kommo e landing usam os mesmos horários de atendimento", () => {
  const weekday = "2026-07-16";
  const gonzaga = scheduling.getHorariosLoja("óticas TGT - Gonzaga", weekday);
  const enseada = scheduling.getHorariosLoja("óticas TGT Enseada", weekday);
  assert.equal(gonzaga[0], "10:00");
  assert.equal(gonzaga.includes("09:30"), false);
  assert.equal(gonzaga.includes("13:00"), true);
  assert.equal(gonzaga.includes("14:00"), false);
  assert.equal(enseada.includes("13:00"), false);
  assert.equal(enseada.includes("14:00"), true);
});

test("webhook ativo processa atualização de lead e bot só confirma registro real", () => {
  const root = path.join(__dirname, "..");
  const webhook = fs.readFileSync(path.join(root, "kommo", "webhook.js"), "utf8");
  const flow = fs.readFileSync(path.join(root, "kommo", "bot", "flowEngine.js"), "utf8");
  assert.match(webhook, /payload\?\.leads\?\.status/);
  assert.match(webhook, /syncLeadAppointment\(String\(updatedLead\.id\)/);
  assert.match(flow, /buscarAgendamentoAtivoPorLead\(leadId\)/);
  assert.match(flow, /testeNaoEncontrado/);
});
