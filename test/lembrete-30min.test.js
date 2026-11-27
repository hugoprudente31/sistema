'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reminder = require('../kommo/reminder');
const reminderSource = fs.readFileSync(path.join(__dirname, '..', 'kommo', 'reminder.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('mensagem de 30 minutos informa nome, data, horário e loja', function() {
  const message = reminder.buildThirtyMinuteMessage({
    nome: 'Maria Silva',
    horario: '15:30',
    data_agendamento: '26/11/2026',
    loja: 'Óticas TGT Enseada'
  });
  assert.match(message, /\*Maria\*/);
  assert.match(message, /\*30 minutos\*/);
  assert.match(message, /26\/11\/2026/);
  assert.match(message, /\*15:30\*/);
  assert.match(message, /Óticas TGT Enseada/);
});

test('mensagem de 30 minutos cabe no campo de 256 caracteres da Kommo', function() {
  const message = reminder.buildThirtyMinuteMessage({
    nome: 'Maximiliano Bartolomeu de Albuquerque',
    horario: '17:30',
    data_agendamento: '31/12/2026',
    loja: 'Óticas TGT Ademar de Barros - Guarujá'
  });
  assert.ok(message.length <= 256, `mensagem com ${message.length} caracteres`);
});

test('lembrete 30min usa janela no fuso de São Paulo e não duplica envio', function() {
  assert.match(server, /lembrete_30min_em TIMESTAMPTZ/);
  assert.match(server, /lembrete_30min_ref TEXT/);
  assert.match(reminderSource, /lembrete_30min_ref IS DISTINCT FROM/);
  assert.match(reminderSource, /AT TIME ZONE 'America\/Sao_Paulo'\)\s*> NOW\(\) \+ INTERVAL '15 minutes'/);
  assert.match(reminderSource, /<= NOW\(\) \+ INTERVAL '35 minutes'/);
  assert.match(reminderSource, /scheduleEveryMinutes\("Reminder30min"/);
  assert.match(reminderSource, /runMonitoredJob\("reminder_30min"/);
  assert.match(server, /\/api\/admin\/lembretes\/30min\/disparar/);
});

test('lembrete 30min pode ser desligado por variável de ambiente', async function() {
  const anterior = process.env.REMINDER_30MIN_AUTOMATION_ENABLED;
  process.env.REMINDER_30MIN_AUTOMATION_ENABLED = 'false';
  try {
    const resultado = await reminder.runThirtyMinuteReminders();
    assert.equal(resultado.desativado, true);
  } finally {
    if (anterior === undefined) delete process.env.REMINDER_30MIN_AUTOMATION_ENABLED;
    else process.env.REMINDER_30MIN_AUTOMATION_ENABLED = anterior;
  }
});

test('lembrete 30min usa Salesbot próprio (modelo aprovado) quando configurado', async function() {
  const kommo = require('../kommo/client');
  const db = require('../lib/db');
  const originais = { update: kommo.updateLead, launch: kommo.launchSalesbot, proativa: kommo.sendProactiveMessage, note: kommo.addNote, query: db.pool.query };
  const chamadas = [];
  kommo.updateLead = async (id, body) => { chamadas.push(['update', id, body]); };
  kommo.launchSalesbot = async (bot, id) => { chamadas.push(['bot', bot, id]); };
  kommo.sendProactiveMessage = async () => { chamadas.push(['proativa']); };
  kommo.addNote = async () => {};
  db.pool.query = async (sql) => /SELECT/.test(sql)
    ? { rows: [{ id: 1, kommo_lead_id: '123', nome: 'Ana', horario: '15:00', loja: 'Gonzaga', data_agendamento: '27/11/2026', slot_ref: '2026-11-27 15:00', status: 'Agendado' }] }
    : { rowCount: 1, rows: [] };
  process.env.KOMMO_REMINDER_30MIN_SALESBOT_ID = '999';
  try {
    const r = await reminder.runThirtyMinuteReminders();
    assert.equal(r.enviados, 1);
    assert.deepEqual(chamadas.map(c => c[0]), ['update', 'bot']);
    assert.equal(chamadas[1][1], '999');
    assert.match(chamadas[0][2].custom_fields_values[0].values[0].value, /Data: 27\/11\/2026 \| Horario: 15:00 \| Loja: Gonzaga/);
  } finally {
    delete process.env.KOMMO_REMINDER_30MIN_SALESBOT_ID;
    kommo.updateLead = originais.update; kommo.launchSalesbot = originais.launch;
    kommo.sendProactiveMessage = originais.proativa; kommo.addNote = originais.note; db.pool.query = originais.query;
  }
});
