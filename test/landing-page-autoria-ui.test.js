'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const painel = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('coluna Agendado por identifica toda Landing Page como Setor de Relacionamento Pós Vendas', function() {
  assert.match(painel, /if \(origemLanding\) \{\s*return 'Setor de Relacionamento Pós Vendas';/);
  assert.doesNotMatch(painel, /\? 'LP ' \+ conta/);
});

test('confirmação da Landing Page pede e envia o nome real da pessoa da Central', function() {
  assert.match(painel, /prompt\('Informe o nome real da pessoa da Central que confirmou este agendamento:'\)/);
  assert.match(painel, /patch\.confirmadoPorCentralNome = nomeCentral/);
});

test('origem fica oculta na interface para todos, exceto o criador do sistema', function() {
  assert.match(painel, /function canViewLeadOrigin\(\).*canViewLeadOrigin/);
  assert.match(painel, /\['origem', 'filtroOrigem', 'finOrigem', 'histFiltroOrigem', 'editOrigem'\]/);
  assert.match(painel, /if \(!canViewLeadOrigin\(\)\) cols = cols\.filter/);
});
