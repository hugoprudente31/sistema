'use strict';
/**
 * Teste de INTEGRAÇÃO — roda contra um Postgres de verdade (schema real,
 * criado pelo mesmo initDatabase() usado em produção: tabelas, índices,
 * constraints, triggers). Os 290 testes do `npm test` normal usam pool/
 * connect mockados — ótimo pra lógica de permissão, mas nenhum deles
 * bateria de verdade numa trava do BANCO (ex.: o índice único
 * uniq_agendamento_ativo_slot, que causou o bug real do "Erro HTTP 500"
 * genérico ao tentar marcar dois agendamentos no mesmo horário/optometrista).
 * Só um teste rodando contra o banco de verdade pega esse tipo de bug.
 *
 * NÃO roda dentro de `npm test` (o script "test" não inclui esta pasta de
 * propósito — ver package.json). Só roda via `npm run test:integration`,
 * e só se TEST_DATABASE_URL estiver definida. Sem essa variável, os testes
 * são pulados (skip), nunca falham — não tem senha nenhuma hardcoded aqui.
 *
 * Isolamento: cria um banco PRÓPRIO ("sistema_test") no mesmo servidor
 * apontado por TEST_DATABASE_URL — nunca toca no banco real de produção,
 * mesmo que a connection string aponte pro mesmo servidor Postgres. Os
 * dados de teste usam uma loja fictícia fácil de identificar
 * ("Loja Integração TGT [teste]") e cada teste limpa o que criou.
 *
 * Como rodar localmente:
 *   1. Pegue uma connection string de algum Postgres (pode ser o mesmo
 *      servidor de produção — só a base de dados criada é diferente,
 *      "sistema_test", nunca a "railway" real; ou qualquer Postgres local).
 *   2. TEST_DATABASE_URL="postgresql://usuario:senha@host:porta/postgres" npm run test:integration
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');

const ADMIN_URL = process.env.TEST_DATABASE_URL;

if (!ADMIN_URL) {
  test('testes de integração pulados — defina TEST_DATABASE_URL pra rodar', { skip: true }, () => {});
} else {
  const LOJA_TESTE = 'Loja Integração TGT [teste]';

  function urlComBanco(url, nomeBanco) {
    const u = new URL(url);
    u.pathname = '/' + nomeBanco;
    return u.toString();
  }

  let TEST_DATABASE_URL;
  let app, pool, signSession, initDatabase;
  let server, baseUrl;

  test.before(async () => {
    // 1) Garante que o banco isolado de teste existe (não mexe no banco
    // apontado originalmente por TEST_DATABASE_URL além de criar este).
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const existe = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'sistema_test'");
    if (!existe.rows.length) {
      await admin.query('CREATE DATABASE sistema_test');
    }
    await admin.end();

    // 2) Aponta a variável que o server.js usa ANTES de dar require nele —
    // o pool é criado no topo do módulo, lendo DATABASE_URL nesse instante.
    TEST_DATABASE_URL = urlComBanco(ADMIN_URL, 'sistema_test');
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.SESSION_SECRET = 'integration-test-secret-com-32-caracteres-ok';
    process.env.SESSION_TTL_HOURS = '1';

    ({ app, pool, signSession, initDatabase } = require('../../server'));

    // 3) Cria o schema real (tabelas, índices, constraints, triggers) —
    // mesma função que roda no boot de produção, idempotente.
    await initDatabase();

    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  test.after(async () => {
    // Rede de segurança: apaga qualquer resíduo desta loja de teste, mesmo
    // que algum teste individual tenha falhado antes de limpar sozinho.
    await pool.query('DELETE FROM agendamentos WHERE loja = $1', [LOJA_TESTE]).catch(() => {});
    await pool.query('DELETE FROM vendedores_consultores WHERE loja = $1', [LOJA_TESTE]).catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  });

  function H(token) {
    return { cookie: `tgt_session=${token}`, 'content-type': 'application/json' };
  }

  function tokenAdmin() {
    return signSession({ id: '1', nome: 'Admin Integração', email: 'admin.integracao@example.com', perfil: 'admin', loja: 'Todas' });
  }

  async function criarAgendamento(overrides) {
    return fetch(baseUrl + '/api/agendamentos', {
      method: 'POST',
      headers: H(tokenAdmin()),
      body: JSON.stringify(Object.assign({
        nome: 'Cliente Suite de Integração',
        whatsapp: '11999999999',
        loja: LOJA_TESTE,
        optometrista: 'Optometrista Integração',
        data_agendamento: '2027-03-15',
        horario: '10:00',
        vendedor_nome: 'Vendedor Integração'
      }, overrides))
    });
  }

  test('constraint real do banco: dois agendamentos no mesmo optometrista/loja/horário — o segundo recebe 409 com mensagem clara, não 500', async () => {
    const primeiro = await criarAgendamento({});
    const corpoPrimeiro = await primeiro.json();
    assert.equal(primeiro.status, 200, 'primeiro agendamento deveria ser criado normalmente');
    assert.ok(corpoPrimeiro.agendamento && corpoPrimeiro.agendamento.id, 'resposta deveria trazer o agendamento criado');

    try {
      const segundo = await criarAgendamento({ nome: 'Outro Cliente da Suite' });
      assert.equal(segundo.status, 409, 'segundo agendamento no mesmo horário deveria ser rejeitado com 409, não 500');
      const corpoSegundo = await segundo.json();
      assert.equal(corpoSegundo.ok, false);
      assert.match(corpoSegundo.message, /já está ocupado/);
    } finally {
      await pool.query('DELETE FROM agendamentos WHERE id = $1', [corpoPrimeiro.agendamento.id]);
    }
  });

  test('trigger real do banco: nome do vendedor digitado no formulário vira identidade com ID em vendedores_consultores', async () => {
    const nomeUnico = 'Vendedor Integração ' + Date.now();
    const resposta = await criarAgendamento({
      data_agendamento: '2027-03-16',
      vendedor_nome: nomeUnico
    });
    assert.equal(resposta.status, 200);
    const corpo = await resposta.json();
    const agendamentoId = corpo.agendamento.id;

    try {
      assert.ok(corpo.agendamento.vendedor_consultor_id, 'trigger deveria ter preenchido vendedor_consultor_id automaticamente');

      const identidade = await pool.query(
        'SELECT id, nome, loja FROM vendedores_consultores WHERE id = $1',
        [corpo.agendamento.vendedor_consultor_id]
      );
      assert.equal(identidade.rows.length, 1, 'deveria existir uma identidade correspondente em vendedores_consultores');
      assert.equal(identidade.rows[0].nome, nomeUnico);
      assert.equal(identidade.rows[0].loja, LOJA_TESTE);
    } finally {
      await pool.query('DELETE FROM agendamentos WHERE id = $1', [agendamentoId]);
      await pool.query('DELETE FROM vendedores_consultores WHERE nome = $1', [nomeUnico]);
    }
  });

  test('constraint real do banco: reagendar (PATCH) para um horário já ocupado também recebe 409, não 500', async () => {
    const ocupado = await criarAgendamento({ data_agendamento: '2027-03-17', horario: '11:00' });
    const corpoOcupado = await ocupado.json();
    const livre = await criarAgendamento({ data_agendamento: '2027-03-17', horario: '15:00', nome: 'Cliente a Reagendar' });
    const corpoLivre = await livre.json();

    try {
      const reagendar = await fetch(baseUrl + '/api/agendamentos/' + corpoLivre.agendamento.id, {
        method: 'PATCH',
        headers: H(tokenAdmin()),
        body: JSON.stringify({ data_agendamento: '2027-03-17', horario: '11:00' })
      });
      assert.equal(reagendar.status, 409, 'reagendar pro horário ocupado deveria devolver 409, não 500');
      const corpoReagendar = await reagendar.json();
      assert.match(corpoReagendar.message, /já está ocupado/);
    } finally {
      await pool.query('DELETE FROM agendamentos WHERE id IN ($1,$2)', [corpoOcupado.agendamento.id, corpoLivre.agendamento.id]);
    }
  });
}
