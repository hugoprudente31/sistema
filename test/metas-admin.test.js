const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.SESSION_TTL_HOURS = '1';
const { app, pool, signSession } = require('../server');

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
test.after(async () => new Promise((resolve) => server.close(resolve)));

function headers(perfil) {
  const token = signSession({ id: '1', nome: 'Teste', email: `${perfil.replace(/\s/g,'')}@example.com`, perfil });
  return { cookie: `tgt_session=${token}`, 'content-type': 'application/json' };
}

test('cadastro de metas é bloqueado para perfis não administrativos', async () => {
  const response = await fetch(baseUrl + '/api/admin/metas', { headers: headers('gerente de loja') });
  assert.equal(response.status, 403);
});

test('admin salva meta mensal do Grupo TGT', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    assert.match(String(sql), /INSERT INTO metas_desempenho/);
    assert.equal(params[0], '2026-08-01');
    assert.equal(params[1], 'grupo');
    assert.equal(params[2], 'grupo:tgt');
    assert.equal(params[5], 150000);
    return { rows: [{ id: 1, competencia: '2026-08-01', tipo_escopo: 'grupo', meta_faturamento: 150000 }] };
  };
  try {
    const response = await fetch(baseUrl + '/api/admin/metas', {
      method: 'POST', headers: headers('admin'),
      body: JSON.stringify({ competencia: '2026-08', tipo_escopo: 'grupo', meta_faturamento: 150000 })
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  } finally { pool.query = originalQuery; }
});

test('painel contém campos administrativos e usa ID permanente do consultor', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="cardMetasAdmin"/);
  assert.match(html, /p\.isAdmin.*cardMetasAdmin/);
  assert.match(html, /vendedor_consultor_id: byId\('metaConsultor'\)/);
  assert.match(html, /Meta faturamento \(valor pago\)/);
});
