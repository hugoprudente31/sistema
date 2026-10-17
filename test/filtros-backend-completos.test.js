'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('API filtra critérios de seleção no SQL antes de aplicar LIMIT', () => {
  const start = server.indexOf('app.get("/api/agendamentos"');
  const body = server.slice(start, server.indexOf('app.patch("/api/agendamentos/:id"', start));
  assert.match(body, /CONCAT_WS\(' ', a\.nome, a\.whatsapp, a\.email\) ILIKE/);
  assert.match(body, /a\.optometrista/);
  assert.match(body, /a\.vendedor_atendeu_nome/);
  assert.match(body, /a\.proprietario_nome/);
  assert.match(body, /a\.access_tags/);
  assert.match(body, /const resultados =/);
  assert.ok(body.indexOf('if (q.cliente)') < body.indexOf('ORDER BY a.id DESC LIMIT'), 'filtros precisam ser montados antes do LIMIT');
});

test('API entende Somente agendados como Agendado ou Confirmado', () => {
  assert.match(server, /q\.somenteAgendados[^]*IN \('agendado','confirmado'\)/);
});
