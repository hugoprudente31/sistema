const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.SESSION_TTL_HOURS = '1';

const { app, pool, signSession, buildPermissions, publicUser, isSuperAdmin, rodarAuditoriaIntegridadeMensal } = require('../server');

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

// Recomendação pós-auditoria: a checagem de loja-mismatch só rodava quando
// alguém lembrava de abrir a rota manualmente. Agora roda sozinha 1x por
// mês (ver startAuditoriaIntegridadeCron em server.js) e avisa pelo sino de
// notificações do painel só quando encontra algo — sem ruído mensal se
// estiver tudo certo.
test('auditoria mensal não roda de novo se já rodou este mês', async () => {
  const originalQuery = pool.query;
  let chamadas = 0;
  pool.query = async (sql) => {
    chamadas++;
    return { rows: [{ existe: 1 }] }; // já tem registro deste mês em logs_sistema
  };
  try {
    const resultado = await rodarAuditoriaIntegridadeMensal();
    assert.equal(resultado.executou, false);
    assert.equal(chamadas, 1, 'deveria parar assim que confirmar que já rodou este mês, sem consultar mais nada');
  } finally {
    pool.query = originalQuery;
  }
});

test('auditoria mensal notifica o admin (e o Hugo por e-mail) só quando encontra divergência de loja', async () => {
  const originalQuery = pool.query;
  const inserts = [];
  pool.query = async (sql, params) => {
    const s = String(sql);
    if (s.includes('SELECT 1 FROM logs_sistema')) return { rows: [] }; // ainda não rodou este mês
    if (s.includes('SELECT nome, ativo FROM lojas')) return { rows: [{ nome: 'óticas TGT - Gonzaga', ativo: true }] };
    if (s.includes('FROM vendedores_consultores')) return { rows: [{ loja: 'Gonzaga', total: 1 }] };
    if (s.includes('INSERT INTO logs_sistema')) { inserts.push({ tabela: 'logs_sistema', params }); return { rows: [] }; }
    if (s.includes('INSERT INTO notificacoes')) { inserts.push({ tabela: 'notificacoes', params }); return { rows: [] }; }
    return { rows: [] };
  };
  try {
    const resultado = await rodarAuditoriaIntegridadeMensal();
    assert.equal(resultado.executou, true);
    assert.equal(resultado.divergencias.length, 1);

    const log = inserts.find((i) => i.tabela === 'logs_sistema');
    assert.ok(log, 'deveria registrar a execução em logs_sistema mesmo com divergência');

    const notif = inserts.find((i) => i.tabela === 'notificacoes');
    assert.ok(notif, 'deveria criar uma notificação quando encontra divergência');
    assert.ok(notif.params[4].includes(HUGO_EMAIL), 'a notificação deveria alcançar o Hugo diretamente pelo e-mail');
    assert.ok(notif.params[4].includes('admin'), 'a notificação deveria alcançar qualquer admin, não só o Hugo');
  } finally {
    pool.query = originalQuery;
  }
});

test('auditoria mensal não notifica ninguém quando não encontra divergência nenhuma', async () => {
  const originalQuery = pool.query;
  const inserts = [];
  pool.query = async (sql, params) => {
    const s = String(sql);
    if (s.includes('SELECT 1 FROM logs_sistema')) return { rows: [] };
    if (s.includes('INSERT INTO logs_sistema')) { inserts.push({ tabela: 'logs_sistema', params }); return { rows: [] }; }
    if (s.includes('INSERT INTO notificacoes')) { inserts.push({ tabela: 'notificacoes', params }); return { rows: [] }; }
    return { rows: [] }; // nenhuma tabela devolve divergência
  };
  try {
    const resultado = await rodarAuditoriaIntegridadeMensal();
    assert.equal(resultado.divergencias.length, 0);
    assert.ok(inserts.some((i) => i.tabela === 'logs_sistema'), 'deveria registrar a execução mesmo sem achar nada');
    assert.ok(!inserts.some((i) => i.tabela === 'notificacoes'), 'não deveria notificar ninguém quando não há problema');
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
