'use strict';
/**
 * Bug real encontrado em produção: 4 agendamentos foram gravados com o ano
 * completamente corrompido (26, 2626, 62026, 72026) em data_agendamento.
 * O POST/PATCH /api/agendamentos gravava o valor bruto vindo do cliente
 * direto na coluna DATE, sem nenhuma validação de formato ou de intervalo
 * razoável — bastava um valor mal formado (ex: vindo de texto livre do
 * WhatsApp/bot, ou de um bug no cliente) passar para o Postgres aceitar e
 * gravar sem reclamar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'data-agendamento-secret-com-32-caracteres-ok';

const { app, pool, signSession, toPgDate } = require('../server');

let server, baseUrl;
test.before(async () => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(async () => new Promise((resolve) => server.close(resolve)));

function H(token) { return { cookie: `tgt_session=${token}`, 'content-type': 'application/json' }; }
function tokAdmin() { return signSession({ id: '1', nome: 'Admin', email: 'admin@example.com', perfil: 'admin', loja: 'Todas' }); }

test('toPgDate rejeita anos absurdos (bug real: 26, 2626, 62026, 72026)', () => {
  assert.equal(toPgDate('0026-06-17'), null);
  assert.equal(toPgDate('2626-06-23'), null);
  assert.equal(toPgDate('62026-07-22'), null);
  assert.equal(toPgDate('72026-07-09'), null);
});

test('toPgDate continua aceitando datas normais em qualquer formato suportado', () => {
  assert.equal(toPgDate('2026-07-22'), '2026-07-22');
  assert.equal(toPgDate('22/07/2026'), '2026-07-22');
  assert.equal(toPgDate(''), null);
  assert.equal(toPgDate(null), null);
});

test('POST /api/agendamentos rejeita data com ano absurdo em vez de gravar crua', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const client = { query: async () => ({ rows: [] }), release: () => {} };
  pool.connect = async () => client;
  pool.query = async () => ({ rows: [] });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', {
      method: 'POST', headers: H(tokAdmin()),
      body: JSON.stringify({ nome: 'Cliente Real', loja: 'Todas', data_agendamento: '72026-07-09', horario: '10:00' })
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /Data do agendamento inválida/);
  } finally { pool.connect = originalConnect; pool.query = originalQuery; }
});

test('POST /api/agendamentos com data normal continua funcionando (sem regressão)', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const client = {
    query: async (sql) => {
      if (String(sql).includes('INSERT INTO agendamentos')) {
        return { rows: [{ id: 300, nome: 'Cliente Real', loja: 'Todas', data_agendamento: '2026-07-22', status: 'Agendado' }] };
      }
      return { rows: [] };
    },
    release: () => {}
  };
  pool.connect = async () => client;
  pool.query = async () => ({ rows: [] });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', {
      method: 'POST', headers: H(tokAdmin()),
      body: JSON.stringify({ nome: 'Cliente Real', loja: 'Todas', data_agendamento: '2026-07-22', horario: '10:00' })
    });
    assert.equal(r.status, 200);
  } finally { pool.connect = originalConnect; pool.query = originalQuery; }
});

test('PATCH /api/agendamentos/:id rejeita data com ano absurdo em vez de gravar crua', async () => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = async (sql) => {
    if (String(sql).includes('SELECT * FROM agendamentos WHERE id')) {
      return { rows: [{ id: 5, loja: 'Todas', status: 'Agendado', data_agendamento: '2026-07-01', excluido_em: null }] };
    }
    return { rows: [] };
  };
  pool.connect = async () => ({ query: async () => ({ rows: [] }), release: () => {} });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/5', {
      method: 'PATCH', headers: H(tokAdmin()),
      body: JSON.stringify({ data_agendamento: '2626-06-23' })
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /Data do agendamento inválida/);
  } finally { pool.query = originalQuery; pool.connect = originalConnect; }
});

test('PATCH /api/agendamentos/:id sem alterar a data continua funcionando (sem regressão)', async () => {
  const originalQuery = pool.query;
  const originalConnect = pool.connect;
  pool.query = async (sql) => {
    if (String(sql).includes('SELECT * FROM agendamentos WHERE id')) {
      return { rows: [{ id: 5, loja: 'Todas', status: 'Agendado', data_agendamento: '2026-07-01', excluido_em: null }] };
    }
    return { rows: [] };
  };
  pool.connect = async () => ({
    query: async (sql) => {
      if (String(sql).includes('UPDATE agendamentos SET')) {
        return { rows: [{ id: 5, loja: 'Todas', status: 'Agendado', data_agendamento: '2026-07-01' }] };
      }
      return { rows: [] };
    },
    release: () => {}
  });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/5', {
      method: 'PATCH', headers: H(tokAdmin()),
      body: JSON.stringify({ observacao: 'Correção de cadastro' })
    });
    assert.equal(r.status, 200);
  } finally { pool.query = originalQuery; pool.connect = originalConnect; }
});
