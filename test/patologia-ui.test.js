'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('painel exibe coluna Patologia para os usuários da loja', function() {
  assert.match(html, /<th>Patologia<\/th>/);
  assert.match(html, /r\.Patologia \|\| 'Pendente'/);
});

test('perfil optometrista recebe botões Patologia Sim e Patologia Não abaixo do check-in', function() {
  assert.match(html, /role === 'optometrista' && ownStore/);
  assert.match(html, />Patologia Sim<\/button>/);
  assert.match(html, />Patologia Não<\/button>/);
  assert.match(html, /class="clinical-actions"/);
});
