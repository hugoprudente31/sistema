'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const reminder = require('../kommo/reminder');
const scheduling = fs.readFileSync(path.join(__dirname, '..', 'kommo', 'scheduling.js'), 'utf8');
const webhook = fs.readFileSync(path.join(__dirname, '..', 'kommo', 'webhook.js'), 'utf8');
const labels = fs.readFileSync(path.join(__dirname, '..', 'kommo', 'labels.js'), 'utf8');
const flow = fs.readFileSync(path.join(__dirname, '..', 'kommo', 'bot', 'flowEngine.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('mensagem de 2 horas é agradável e identifica avaliação, horário e loja', function() {
  const message = reminder.buildTwoHourMessage({
    nome: 'Maria Silva',
    horario: '15:30',
    loja: 'Óticas TGT Enseada'
  });
  assert.match(message, /Olá, \*Maria\*!/);
  assert.match(message, /\*2 horas\*/);
  assert.match(message, /\*Avaliação Visual\*/);
  assert.match(message, /15:30/);
  assert.match(message, /Óticas TGT Enseada/);
  assert.match(message, /Até já!/);
});

test('lembrete 2h usa janela de execução e trava de duplicidade', function() {
  const reminderSource = fs.readFileSync(path.join(__dirname, '..', 'kommo', 'reminder.js'), 'utf8');
  assert.match(server, /lembrete_2h_em TIMESTAMPTZ/);
  assert.match(reminderSource, /lembrete_2h_em IS NULL/);
  assert.match(reminderSource, /INTERVAL '105 minutes'/);
  assert.match(reminderSource, /INTERVAL '125 minutes'/);
  assert.match(reminderSource, /scheduleEveryMinutes\("Reminder2h"/);
  assert.match(reminderSource, /sendProactiveMessage/);
});

test('lembrete 24h recupera reinício após o horário e não marca falha como enviada', function() {
  const reminderSource = fs.readFileSync(path.join(__dirname, '..', 'kommo', 'reminder.js'), 'utf8');
  assert.match(reminderSource, /scheduleEveryMinutes\("ReminderCatchup"/);
  assert.match(reminderSource, /new Date\(\)\.getHours\(\) >= targetHour/);
  assert.doesNotMatch(server, /Marca mesmo com erro para não re-tentar/);
});

test('bloqueio parcial é aplicado no bot, landing page e sistema interno', function() {
  assert.match(scheduling, /hora_inicio TIME/);
  assert.match(scheduling, /\$3::time >= hora_inicio AND \$3::time < hora_fim/);
  assert.match(scheduling, /estaLojaBloqueada\(lojaNormalizada, dataPg, horarioNormalizado\)/);
  assert.match(webhook, /hora_inicio/);
  assert.match(webhook, /hora_fim/);
  assert.match(server, /buscarBloqueioDisponibilidade/);
  assert.match(server, /horariosBase = horariosBase\.filter\(h => h < bloqueioAgenda\.hora_inicio \|\| h >= bloqueioAgenda\.hora_fim\)/);
});

test('lead de entrada recebe uma única etiqueta de loja', function() {
  assert.match(labels, /LOJA_ENSEADA:\s+"loja-enseada"/);
  assert.match(labels, /LOJA_GONZAGA:\s+"loja-gonzaga"/);
  assert.match(labels, /LOJA_PITANGUEIRAS:\s+"loja-pitangueiras"/);
  assert.match(labels, /LOJA_ADEMAR:\s+"loja-ademar-de-barros"/);
  assert.match(labels, /swapLabel\(leadId, STORE_LABELS, label\)/);
  assert.match(flow, /labels\.applyStoreLabel\(leadId, loja\.prefix\)/);
});
