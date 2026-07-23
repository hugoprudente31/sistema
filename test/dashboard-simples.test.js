'use strict';
/**
 * Bug real encontrado em produção (introduzido em 46521a3, 2026-06-28):
 * GET /api/dashboard filtrava a contagem de `clientes` por
 * `excluido_em IS NULL`, mas a tabela `clientes` nunca teve essa coluna
 * (só `agendamentos` tem) — todo request quebrava com 500
 * ("column \"excluido_em\" does not exist"), para 100% dos perfis, sempre.
 * Passou despercebido por quase um mês porque a única cobertura existente
 * (security.test.js) só testava a rejeição de acesso anônimo -- nenhum
 * teste chamava a rota com sessão válida. Esse tipo de bug (coluna que não
 * existe) também é invisível a testes que mockam pool.query, já que o mock
 * nunca valida a SQL contra o schema real -- por isso este arquivo reforça
 * com uma checagem direta no texto-fonte, além do teste de comportamento.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = 'dashboard-simples-secret-com-32-caracteres';
const { app, pool, signSession } = require('../server');

let server, baseUrl;
test.before(async () => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(async () => new Promise((resolve) => server.close(resolve)));

function H(token) { return { cookie: `tgt_session=${token}` }; }

test('GET /api/dashboard não referencia excluido_em na contagem de clientes (coluna que não existe na tabela clientes)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const rotaStart = source.indexOf('app.get("/api/dashboard"');
  const rotaBody = source.slice(rotaStart, source.indexOf('\napp.', rotaStart + 20));
  const clientesQueryStart = rotaBody.indexOf('FROM clientes');
  const clientesQueryEnd = rotaBody.indexOf(');', clientesQueryStart);
  const clientesQuery = rotaBody.slice(clientesQueryStart, clientesQueryEnd);
  assert.ok(!/excluido_em/.test(clientesQuery), 'a tabela clientes não tem coluna excluido_em -- referenciá-la aqui quebra a rota com 500 para todo mundo');
});

test('GET /api/dashboard responde 200 com sessão válida (admin)', async () => {
  const original = pool.query;
  pool.query = async (sql) => {
    if (String(sql).includes('FROM clientes')) return { rows: [{ total: 12 }] };
    if (String(sql).includes('FROM agendamentos')) {
      return { rows: [{ total_agendamentos: 30, os_com_valor: 5, faturamento_total: 1000, desconto_total: 50 }] };
    }
    return { rows: [] };
  };
  try {
    const token = signSession({ id: '1', nome: 'Admin', email: 'admin@example.com', perfil: 'admin', loja: 'Todas' });
    const r = await fetch(baseUrl + '/api/dashboard', { headers: H(token) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.dashboard.total_clientes, 12);
    assert.equal(body.dashboard.total_agendamentos, 30);
  } finally { pool.query = original; }
});

test('GET /api/dashboard responde 200 com sessão válida (perfil de loja, escopo por loja)', async () => {
  const original = pool.query;
  const chamadas = [];
  pool.query = async (sql, params) => {
    chamadas.push({ sql: String(sql), params });
    if (String(sql).includes('FROM clientes')) return { rows: [{ total: 3 }] };
    if (String(sql).includes('FROM agendamentos')) {
      return { rows: [{ total_agendamentos: 8, os_com_valor: 1, faturamento_total: 200, desconto_total: 0 }] };
    }
    return { rows: [] };
  };
  try {
    const token = signSession({ id: '2', nome: 'Gerente', email: 'gerente@example.com', perfil: 'gerente de loja', loja: 'óticas TGT - Gonzaga' });
    const r = await fetch(baseUrl + '/api/dashboard', { headers: H(token) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.dashboard.total_clientes, 3);
    const clientesCall = chamadas.find((c) => c.sql.includes('FROM clientes'));
    assert.equal(clientesCall.params[0], 'óticas TGT - Gonzaga', 'perfil de loja deve filtrar clientes pela própria loja');
  } finally { pool.query = original; }
});
