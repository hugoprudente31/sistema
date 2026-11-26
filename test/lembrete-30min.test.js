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
