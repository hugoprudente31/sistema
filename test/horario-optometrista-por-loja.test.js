'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-with-at-least-32-characters';

const { app, pool, signSession } = require('../server');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const OPTOMETRISTAS = [
  { id: 1, nome: 'Bruna', loja: 'Óticas Target - Ademar de Barros' },
  { id: 2, nome: 'Mariani', loja: 'Óticas TGT - Gonzaga' }
];

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('Atendimento Central lista o horário por optometrista só da loja escolhida', async () => {
  const original = pool.query;
  const consultas = [];
  pool.query = async (sql, params = []) => {
    const texto = String(sql);
    consultas.push({ sql: texto, params });
    if (/FROM optometristas o\s/.test(texto) && !/horarios_optometrista/.test(texto)) {
      const loja = params.find((p) => typeof p === 'string');
      const normaliza = (v) => String(v).toLowerCase().replace(/\s*-\s*/g, ' ');
      return { rows: OPTOMETRISTAS.filter((o) => !loja || normaliza(o.loja) === normaliza(loja)) };
    }
    return { rows: [] };
  };
  try {
    const token = signSession({ id: '9', email: 'central@example.com', perfil: 'atendimento central' });
    const resp = await fetch(baseUrl + '/api/admin/configuracoes/horarios-optometrista?loja=' + encodeURIComponent('Óticas TGT - Gonzaga'), {
      headers: { cookie: `tgt_session=${token}` }
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.ok, true);
    const nomes = new Set(body.horarios.map((h) => h.optometrista_nome));
    assert.deepEqual([...nomes], ['Mariani']);
    assert.equal(body.horarios.length, 7);

    const consultaHorarios = consultas.find((c) => /FROM horarios_optometrista ho/.test(c.sql));
    assert.match(consultaHorarios.sql, /REGEXP_REPLACE\(o\.loja/);
    assert.ok(consultaHorarios.params.some((p) => /gonzaga/i.test(String(p))));
  } finally {
    pool.query = original;
  }
});

test('painel de horário por optometrista exige a loja antes de listar ou salvar', () => {
  assert.match(html, /horarios-optometrista\?loja=' \+ encodeURIComponent\(loja\)/);
  assert.match(html, /Selecione a loja para ver e editar os horários dos optometristas dela\./);
  assert.match(html, /function salvarHorarioOptometrista\(\) \{[\s\S]*?if \(!byId\('horOptoLojaSelect'\)\.value\)/);
  assert.match(html, /onclick="editarHorarioOptometrista\(/);
});
