'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('painel exibe o resultado único do optometrista para os usuários da loja', function() {
  assert.match(html, /<th>Resultado Optometrista<\/th>/);
  assert.match(html, /r\.ResultadoOptometrista \|\| 'Pendente'/);
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
