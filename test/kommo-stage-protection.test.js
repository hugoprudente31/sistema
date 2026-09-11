"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const kommo = require("../kommo/client");
const labels = require("../kommo/labels");
const reminder = require("../kommo/reminder");
const recovery = require("../kommo/recovery");

test("markScheduled remove recuperação/frio e preserva etiquetas válidas", async () => {
  const originalGet = kommo.getLeadTags;
  const originalSet = kommo.setLeadTags;
  let saved;
  kommo.getLeadTags = async () => [
    { name: "loja-enseada" },
    { name: "lead-frio" },
    { name: "em-recuperacao" },
    { name: "🔴 cancelado" },
  ];
  kommo.setLeadTags = async (_leadId, names) => { saved = names; };
  try {
    await labels.markScheduled("123", "Confirmado");
    assert.deepEqual(saved.sort(), [
      "loja-enseada",
      "lead-quente",
      "🟢 agendado-confirmado",
    ].sort());
  } finally {
    kommo.getLeadTags = originalGet;
    kommo.setLeadTags = originalSet;
  }
});

test("lembrete reafirma a etapa Agendamento do pipeline antes do disparo", async () => {
  const originalGetLead = kommo.getLead;
  const originalMove = kommo.moveToStage;
  const originalMark = labels.markScheduled;
  const calls = [];
  kommo.getLead = async () => ({ pipeline_id: 12931092 });
  kommo.moveToStage = async (leadId, stageId) => calls.push(["stage", leadId, stageId]);
  labels.markScheduled = async (leadId, status) => calls.push(["labels", leadId, status]);
  try {
    await reminder.keepLeadScheduled({ kommo_lead_id: "456", status: "Agendado" });
    assert.deepEqual(calls, [
      ["labels", "456", "Agendado"],
      ["stage", "456", "103341140"],
    ]);
  } finally {
    kommo.getLead = originalGetLead;
    kommo.moveToStage = originalMove;
    labels.markScheduled = originalMark;
  }
});

test("recuperação consulta agendamento ativo com status e exclusão seguros", async () => {
  let query;
  const db = {
    query: async (sql, params) => {
      query = { sql, params };
      return { rows: [{ id: 99, status: "Agendado" }] };
    },
  };
  const appointment = await recovery.getActiveAppointment("789", db);
  assert.equal(appointment.id, 99);
  assert.deepEqual(query.params, ["789"]);
  assert.match(query.sql, /status IN \('Agendado', 'Confirmado'\)/);
  assert.match(query.sql, /excluido_em IS NULL/);
});

test("recuperação falha fechada e reagendamento restaura funil agendado", () => {
  const recoverySource = fs.readFileSync(path.join(__dirname, "..", "kommo", "recovery.js"), "utf8");
  const flowSource = fs.readFileSync(path.join(__dirname, "..", "kommo", "bot", "flowEngine.js"), "utf8");
  assert.match(recoverySource, /const appointment = await getActiveAppointment\(lead\.id\)/);
  assert.match(recoverySource, /sem confirmar no banco, nunca movemos\/fechamos o lead/);
  assert.match(flowSource, /await labels\.markScheduled\(leadId, "Agendado"\)/);
  assert.match(flowSource, /await moveStage\(leadId, "agendado", loja\.prefix\)/);
});
