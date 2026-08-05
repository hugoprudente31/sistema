const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.SESSION_TTL_HOURS = '1';

const { app, pool, signSession, buildPermissions, publicUser, isSuperAdmin } = require('../server');

const HUGO_EMAIL = 'hugoprudente.marketing@gmail.com';
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

test('somente a identidade oficial recebe Super Admin', () => {
  const hugo = publicUser({ id: 1, nome: 'Hugo', email: HUGO_EMAIL, cargo: 'admin', can_view_finance: true });
  const outro = publicUser({ id: 2, nome: 'Outro', email: 'outro@example.com', cargo: 'admin', can_view_finance: true });

  assert.equal(hugo.perfil, 'super_admin');
  assert.equal(hugo.permissions.isSuperAdmin, true);
  assert.equal(hugo.permissions.isAdmin, true);
  assert.equal(hugo.permissions.canManageSystem, true);
  assert.equal(hugo.permissions.canManageKommo, true);
  assert.equal(hugo.permissions.canManageLandingPages, true);
  assert.equal(outro.perfil, 'admin');
  assert.equal(outro.permissions.isSuperAdmin, false);
  assert.equal(buildPermissions({ email: 'fake@example.com', cargo: 'super_admin' }).isSuperAdmin, false);
  assert.equal(isSuperAdmin({ email: HUGO_EMAIL, perfil: 'super_admin' }), true);
});

test('admin comum não acessa manutenção técnica', async () => {
  const token = signSession({ id: '2', email: 'admin@example.com', perfil: 'admin' });
  const response = await fetch(baseUrl + '/api/admin/kommo/diagnostico', {
    headers: { cookie: `tgt_session=${token}` }
  });
  assert.equal(response.status, 403);
});

test('diagnóstico de loja exige super admin', async () => {
  const token = signSession({ id: '2', email: 'admin@example.com', perfil: 'admin' });
  const response = await fetch(baseUrl + '/api/admin/diag/loja-mismatch', {
    headers: { cookie: `tgt_session=${token}` }
  });
  assert.equal(response.status, 403);
});

// Item 1 da lista de recomendações pós-auditoria: essa rota varre TODA
// tabela com coluna de loja, não só agendamentos como antes — é o mesmo tipo
// de bug (nome de loja legado) que apareceu 5 vezes nesta sessão de trabalho.
test('diagnóstico de loja varre todas as tabelas e aponta divergência', async () => {
  const originalQuery = pool.query;
  pool.query = async (sql) => {
    const s = String(sql);
    // "FROM lojas" também aparece na subconsulta NOT EXISTS de cada tabela
    // verificada -- checar pelo SELECT completo da lista de lojas primeiro
    // pra não confundir com a query de divergência de vendedores_consultores.
    if (s.includes('SELECT nome, ativo FROM lojas')) return { rows: [{ nome: 'óticas TGT - Gonzaga', ativo: true }] };
    if (s.includes('FROM vendedores_consultores')) return { rows: [{ loja: 'Gonzaga', total: 1 }] };
    return { rows: [] };
  };
  const token = signSession({ id: '1', email: HUGO_EMAIL, perfil: 'super_admin' });
  try {
    const response = await fetch(baseUrl + '/api/admin/diag/loja-mismatch', {
      headers: { cookie: `tgt_session=${token}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.ok(
      body.divergencias.some((d) => d.tabela === 'vendedores_consultores' && d.loja === 'Gonzaga'),
      'deveria apontar a divergência simulada em vendedores_consultores'
    );
    assert.match(body.resumo, /1 valor/);
  } finally {
    pool.query = originalQuery;
  }
});

test('conta Hugo não pode ser excluída pelo painel', async () => {
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [{ id: 1, email: HUGO_EMAIL }] });
  const token = signSession({ id: '2', email: 'admin@example.com', perfil: 'admin' });
  try {
    const response = await fetch(baseUrl + '/api/usuarios/1', {
      method: 'DELETE',
      headers: { cookie: `tgt_session=${token}` }
    });
    assert.equal(response.status, 403);
  } finally {
    pool.query = originalQuery;
  }
});
