'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('painel operacional não repete presença ou resultado em uma coluna própria', function() {
  assert.doesNotMatch(html, /<th>Atendimento<\/th>/);
  assert.doesNotMatch(html, /<th>Presença<\/th>/);
  assert.doesNotMatch(html, /<th>Resultado Optometrista<\/th>/);
  assert.doesNotMatch(html, /function atendimentoLabel\(/);
  assert.match(html, /statusClassAgendamento\(r\)/);
  assert.match(html, /AtendimentoSemaforoLabel/);
  assert.match(html, /marcarResultadoOptometrista/);
  assert.match(html, /colspan="17"/);
  assert.doesNotMatch(html, /colspan="18"/);
  assert.doesNotMatch(html, /colspan="19"/);
});

test('perfil optometrista recebe exatamente as três escolhas clínicas', function() {
  assert.match(html, /role === 'optometrista' && ownStore/);
  assert.match(html, />Check-in Sim veio<\/button>/);
  assert.match(html, />Check-in Não veio<\/button>/);
  assert.match(html, />Patologia<\/button>/);
  assert.doesNotMatch(html, />Patologia Sim<\/button>/);
  assert.doesNotMatch(html, />Patologia Não<\/button>/);
  assert.match(html, /class="clinical-actions"/);
  assert.match(html, /choice-selected/);
});

test('as três escolhas clínicas têm cores próprias antes e depois do clique', function() {
  assert.match(html, /clinical-choice-yes/);
  assert.match(html, /clinical-choice-no/);
  assert.match(html, /clinical-choice-pathology/);
  assert.match(html, /clinical-choice-yes\.choice-selected/);
  assert.match(html, /clinical-choice-no\.choice-selected/);
  assert.match(html, /clinical-choice-pathology\.choice-selected/);
  assert.match(html, /aria-pressed=/);
});

test('resultado Patologia sinaliza toda a linha e o botão em vermelho neon', function() {
  assert.match(html, /ResultadoOptometrista[^\n]+patologia[^\n]+row-pathology/);
  assert.match(html, /\.row-pathology td/);
  assert.match(html, /#ffe4ea !important/);
  assert.match(html, /clinical-choice-pathology\.choice-selected[^}]+#ff1744/);
  assert.match(html, /semaforo = 'vermelho'; semaforoLabel = 'Patologia'/);
});
