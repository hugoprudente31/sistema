'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('lead frio só entra em recuperação após 72 horas', () => {
  const source = read('kommo/recovery.js');
  assert.match(source, /const HOURS_72 = 72 \* 60 \* 60 \* 1000/);
  assert.match(source, /Date\.now\(\) - lastActivity >= HOURS_72/);
  assert.doesNotMatch(source, /HOURS_48/);
});

test('não compareceu agenda e envia o acompanhamento após 45 minutos', () => {
  const server = read('server.js');
  const followups = read('kommo/followups.js');
  assert.match(server, /nao_compareceu_em/);
  assert.match(server, /agendar_followup_nao_compareceu_tgt/);
  assert.match(followups, /INTERVAL '45 minutes'/);
  assert.match(followups, /nao_compareceu_lembrete_em = NOW\(\)/);
  assert.match(followups, /sendProactiveMessage/);
  assert.match(followups, /nao_compareceu_tentativas/);
  assert.match(followups, /nao_compareceu_falha_em/);
  assert.match(followups, /INTERVAL '5 minutes' \* POWER/);
  assert.match(followups, /followup_falhou/);
});

test('negociação salva programa acompanhamento persistente para 25 minutos', () => {
  const routes = read('negociacao-routes.js');
  const followups = read('kommo/followups.js');
  assert.match(routes, /proposta_agendada_em = NOW\(\) \+ INTERVAL '25 minutes'/);
  assert.match(routes, /proposta_enviada_em IS NULL/);
  assert.doesNotMatch(routes, /proposta_15min/);
  assert.doesNotMatch(routes, /15 \* 60 \* 1000/);
  assert.match(followups, /proposta_agendada_em <= NOW\(\)/);
  assert.match(followups, /proposta_enviada_em = NOW\(\)/);
  assert.match(followups, /sendProactiveMessage/);
  assert.match(followups, /proposta_tentativas/);
  assert.match(followups, /proposta_falha_em/);
  assert.match(followups, /proposta_falhou/);
});
