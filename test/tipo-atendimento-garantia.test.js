'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';

const { normalizarTipoAtendimento } = require('../server');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('tipo de atendimento: Garantia é reconhecido, o resto vira Exame de vista', () => {
  assert.equal(normalizarTipoAtendimento('Garantia'), 'Garantia');
  assert.equal(normalizarTipoAtendimento('  GARANTIA de armação '), 'Garantia');
  assert.equal(normalizarTipoAtendimento('Exame de vista'), 'Exame de vista');
  assert.equal(normalizarTipoAtendimento(''), 'Exame de vista');
  assert.equal(normalizarTipoAtendimento(null), 'Exame de vista');
});

test('banco e rotas gravam e filtram o tipo de atendimento', () => {
  assert.match(server, /addColumnIfMissing\("agendamentos", "tipo_atendimento"/);
  assert.match(server, /access_tags, tipo_atendimento, origem_sync/);
  assert.match(server, /tipo_atendimento = COALESCE\(\$33, tipo_atendimento\)/);
  assert.match(server, /if \(q\.tipoAtendimento\)/);
});

test('painel oferece Garantia no cadastro, na edição e no filtro', () => {
  for (const id of ['tipoAtendimento', 'editTipoAtendimento', 'filtroTipoAtendimento']) {
    const select = html.match(new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(select, `select ${id} existe`);
    assert.match(select[1], /<option value="Garantia">Garantia<\/option>/);
  }
  assert.match(html, /tipo_atendimento: payload\.tipoAtendimento/);
});
