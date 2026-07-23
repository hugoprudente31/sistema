'use strict';
/**
 * Testes completos de permissões por perfil e loja.
 * Cobre os 7 perfis × 4 lojas — agendamentos, OS, financeiro, negociação,
 * notificações e rotas exclusivas de admin.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.SESSION_TTL_HOURS = '1';
process.env.SALESBOT_SECRET = 'test-salesbot-secret';
process.env.KOMMO_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.KOMMO_USE_SALESBOT = 'true';
process.env.BOT_ENABLED = 'true';

const { app, pool, signSession } = require('../server');

let server, baseUrl;

// ─── 4 lojas da rede ─────────────────────────────────────────────────────────
const G = 'Óticas TGT - Gonzaga';
const E = 'Óticas TGT Enseada';
const P = 'Óticas TGT Pitangueiras';
const A = 'Óticas Target - Ademar de Barros';
const LOJAS = [G, E, P, A];

// ─── Helpers de sessão ───────────────────────────────────────────────────────
function tok(perfil, loja) {
  return signSession({
    id: String(Math.random()),
    nome: 'Test',
    email: `t@${perfil.replace(/\s+/g, '')}.com`,
    perfil,
    loja: loja || ''
  });
}
function H(token) {
  return { cookie: `tgt_session=${token}`, 'content-type': 'application/json' };
}

// ─── Helpers de mock ─────────────────────────────────────────────────────────
// Stub de agendamento com loja e campos opcionais
function ag(loja, extra) {
  return Object.assign(
    { id: 100, nome: 'Maria Silva', loja, status: 'Agendado',
      compareceu: null, numero_os: null, valor_venda: 0,
      kommo_lead_id: null, excluido_em: null },
    extra || {}
  );
}

// withQuery(map): substitui pool.query pelo mapa SQL-substring → resultado.
// Retorna função restore(). Chaves mais específicas devem vir antes.
function withQuery(map) {
  const orig = pool.query;
  pool.query = async function(sql) {
    for (const key of Object.keys(map)) {
      if (sql.includes(key)) return map[key];
    }
    return { rows: [] };
  };
  return function restore() { pool.query = orig; };
}

// withConnect(updateRow): substitui pool.connect para transações PATCH.
function withConnect(updateRow) {
  const orig = pool.connect;
  pool.connect = async function() {
    return {
      query: async function(sql) {
        if (sql.includes('UPDATE agendamentos SET')) return { rows: [updateRow] };
        return { rows: [] };
      },
      release: function() {}
    };
  };
  return function restore() { pool.connect = orig; };
}

test.before(async function() {
  await new Promise(function(resolve) {
    server = app.listen(0, '127.0.0.1', function() {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      resolve();
    });
  });
});

test.after(async function() {
  await new Promise(function(resolve) { server.close(resolve); });
});

// ════════════════════════════════════════════════════════════════════════════
// 1. SEM SESSÃO
// ════════════════════════════════════════════════════════════════════════════

test('sem sessão: todas as rotas protegidas retornam 401', async function() {
  const rotas = [
    '/api/agendamentos', '/api/faturamentos', '/api/lixeira',
    '/api/negociacao/1', '/api/notificacoes', '/api/lead-time',
    '/api/historico-agendamentos', '/api/usuarios', '/api/clientes'
  ];
  for (const rota of rotas) {
    const r = await fetch(baseUrl + rota);
    assert.equal(r.status, 401, 'esperado 401 em ' + rota);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ADMIN — acesso irrestrito
// ════════════════════════════════════════════════════════════════════════════

test('admin: agendamentos de todas as 4 lojas — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: LOJAS.map(function(l) { return ag(l); }) } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('admin')) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).total, 4);
  } finally { restore(); }
});

test('admin: lixeira (requireAdmin) — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/lixeira', { headers: H(tok('admin')) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('admin: faturamentos globais — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [ag(G, { valor_venda: 500, desconto: 50 })] } });
  try {
    const r = await fetch(baseUrl + '/api/faturamentos', { headers: H(tok('admin')) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(body.faturamentos.length > 0, 'deve retornar ao menos um registro');
  } finally { restore(); }
});

test('admin: lead-time global — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/lead-time', { headers: H(tok('admin')) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('admin: PATCH com campos OS em qualquer loja — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  const r2 = withConnect(ag(E, { numero_os: 'OS999' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('admin', G)),
      body: JSON.stringify({ numero_os: 'OS999' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('admin: negociação de qualquer loja — 200', async function() {
  const restore = withQuery({ 'FROM agendamento_negociacao': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/negociacao/100', { headers: H(tok('admin')) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('admin: POST /api/usuarios — não retorna 403', async function() {
  const restore = withQuery({
    'SELECT * FROM usuarios WHERE': { rows: [] },
    'INSERT INTO usuarios': { rows: [{ id: 99, nome: 'Novo', email: 'n@n.com', cargo: 'vendedor', loja: G, ativo: true }] }
  });
  try {
    const r = await fetch(baseUrl + '/api/usuarios', {
      method: 'POST', headers: H(tok('admin')),
      body: JSON.stringify({ nome: 'Novo', email: 'n@novo.com', senha: 'Senha#2026Forte', cargo: 'vendedor', loja: G })
    });
    assert.ok(r.status !== 403, 'admin não deve ser bloqueado em POST /api/usuarios');
  } finally { restore(); }
});

test('admin: POST /api/usuarios rejeita loja fora do cadastro oficial (evita repetir o bug da conta Ademar de Barros)', async function() {
  // Bug real encontrado em produção: 4 contas da loja Ademar de Barros foram
  // gravadas com usuarios.loja = "Óticas Target - Santo Antônio" — um valor
  // que o mapa de variações JÁ reconhece e normalizaria corretamente (ver
  // test/normaliza-loja-publica.test.js), então o problema nunca foi essa
  // variação especificamente, e sim que ANTES desta correção nenhuma
  // validação existia: qualquer texto era salvo cru, sem checar se batia com
  // alguma loja real. Este teste cobre esse caso — um valor que não bate com
  // NENHUMA variação conhecida — que antes era salvo sem erro.
  const restore = withQuery({ 'SELECT * FROM usuarios WHERE': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/usuarios', {
      method: 'POST', headers: H(tok('admin')),
      body: JSON.stringify({ nome: 'Novo', email: 'n2@novo.com', senha: 'Senha#2026Forte', cargo: 'vendedor', loja: 'Loja que não existe de verdade' })
    });
    assert.equal(r.status, 400, 'loja não cadastrada precisa ser rejeitada, não salva crua');
    assert.match((await r.json()).message, /Loja não reconhecida/);
  } finally { restore(); }
});

test('admin: POST /api/usuarios normaliza variações reconhecidas da loja antes de salvar (ex: nome legado "Santo Antônio")', async function() {
  // Este é o cenário exato do bug real: a conta é criada/editada com o nome
  // legado da loja, e precisa ser gravada com o nome oficial do cadastro
  // (`lojas`), não com o texto cru — senão o filtro de sessão em
  // GET /api/agendamentos (match exato contra agendamentos.loja) nunca bate.
  let payloadInserido = null;
  const orig = pool.query;
  pool.query = async function(sql, params) {
    if (sql.includes('SELECT * FROM usuarios WHERE')) return { rows: [] };
    if (sql.includes('INSERT INTO usuarios')) {
      payloadInserido = params;
      return { rows: [{ id: 99, nome: 'Novo', email: 'n3@n.com', cargo: 'vendedor', loja: 'óticas Target - Ademar de Barros', ativo: true }] };
    }
    return { rows: [] };
  };
  try {
    const r = await fetch(baseUrl + '/api/usuarios', {
      method: 'POST', headers: H(tok('admin')),
      body: JSON.stringify({ nome: 'Novo', email: 'n3@novo.com', senha: 'Senha#2026Forte', cargo: 'vendedor', loja: 'Óticas Target - Santo Antônio' })
    });
    assert.equal(r.status, 200);
    assert.equal(payloadInserido[5], 'óticas Target - Ademar de Barros', 'variação legada deve ser normalizada para o nome oficial antes do INSERT');
  } finally { pool.query = orig; }
});

test('admin: PATCH /api/usuarios/:id rejeita loja fora do cadastro oficial', async function() {
  const restore = withQuery({
    'SELECT id, email, cargo FROM usuarios WHERE id': { rows: [{ id: 20, email: 'x@x.com', cargo: 'optometrista' }] }
  });
  try {
    const r = await fetch(baseUrl + '/api/usuarios/20', {
      method: 'PATCH', headers: H(tok('admin')),
      body: JSON.stringify({ loja: 'Loja que não existe' })
    });
    assert.equal(r.status, 400);
    assert.match((await r.json()).message, /Loja não reconhecida/);
  } finally { restore(); }
});

test('admin: PATCH /api/usuarios/:id sem tocar em loja não exige o campo (COALESCE mantém o valor atual)', async function() {
  let paramsRecebidos = null;
  const orig = pool.query;
  pool.query = async function(sql, params) {
    if (sql.includes('SELECT id, email, cargo FROM usuarios WHERE id')) return { rows: [{ id: 20, email: 'x@x.com', cargo: 'optometrista' }] };
    if (sql.includes('UPDATE usuarios SET')) {
      paramsRecebidos = params;
      return { rows: [{ id: 20, nome: 'X', email: 'x@x.com', cargo: 'optometrista', loja: A, ativo: true }] };
    }
    return { rows: [] };
  };
  try {
    const r = await fetch(baseUrl + '/api/usuarios/20', {
      method: 'PATCH', headers: H(tok('admin')),
      body: JSON.stringify({ nome: 'Novo Nome' })
    });
    assert.equal(r.status, 200);
    assert.equal(paramsRecebidos[2], null, 'loja não enviada no PATCH deve virar null (COALESCE preserva o valor atual no banco)');
  } finally { pool.query = orig; }
});

test('admin: POST /api/clientes rejeita loja fora do cadastro oficial (mesmo bug encontrado em usuarios, agora na tabela clientes)', async function() {
  // Bug real encontrado em produção: 41 clientes da loja Ademar de Barros
  // foram gravados com loja_origem = "Óticas Target - Santo Antônio" (nome
  // legado), fazendo o dashboard dessa loja mostrar 1 cliente em vez de 42
  // -- POST /api/clientes nunca validava loja_origem contra o cadastro
  // oficial, o mesmo problema já corrigido em agendamentos e usuarios.
  const r = await fetch(baseUrl + '/api/clientes', {
    method: 'POST', headers: H(tok('admin')),
    body: JSON.stringify({ nome: 'Cliente Novo', loja_origem: 'Loja que não existe' })
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).message, /Loja não reconhecida/);
});

test('admin: POST /api/clientes normaliza variação legada da loja antes de salvar', async function() {
  let paramsRecebidos = null;
  const orig = pool.query;
  pool.query = async function(sql, params) {
    if (sql.includes('INSERT INTO clientes')) {
      paramsRecebidos = params;
      return { rows: [{ id: 500, nome: 'Cliente Novo', loja_origem: 'óticas Target - Ademar de Barros' }] };
    }
    return { rows: [] };
  };
  try {
    const r = await fetch(baseUrl + '/api/clientes', {
      method: 'POST', headers: H(tok('admin')),
      body: JSON.stringify({ nome: 'Cliente Novo', loja_origem: 'Óticas Target - Santo Antônio' })
    });
    assert.equal(r.status, 200);
    assert.equal(paramsRecebidos[7], 'óticas Target - Ademar de Barros', 'variação legada deve ser normalizada para o nome oficial antes do INSERT');
  } finally { pool.query = orig; }
});

test('gerente de loja: POST /api/clientes sem informar loja_origem usa a própria loja da sessão (sem regressão)', async function() {
  const restore = withQuery({ 'INSERT INTO clientes': { rows: [{ id: 501, nome: 'Cliente Sem Loja Explicita', loja_origem: null }] } });
  try {
    const r = await fetch(baseUrl + '/api/clientes', {
      method: 'POST', headers: H(tok('gerente de loja', G)),
      body: JSON.stringify({ nome: 'Cliente Sem Loja Explicita' })
    });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

// ════════════════════════════════════════════════════════════════════════════
// 3. ATENDIMENTO CENTRAL — vê tudo mas não é admin nem tem acesso financeiro
// ════════════════════════════════════════════════════════════════════════════

test('central: agendamentos de todas as 4 lojas — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: LOJAS.map(function(l) { return ag(l); }) } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('atendimento central')) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).total, 4);
  } finally { restore(); }
});

test('central: NÃO acessa lixeira — 403', async function() {
  const r = await fetch(baseUrl + '/api/lixeira', { headers: H(tok('atendimento central')) });
  assert.equal(r.status, 403);
});

test('central: NÃO acessa faturamentos (sem permissão financeira) — 403', async function() {
  const r = await fetch(baseUrl + '/api/faturamentos', { headers: H(tok('atendimento central')) });
  assert.equal(r.status, 403);
});

test('central: lead-time global — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/lead-time', { headers: H(tok('atendimento central')) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('central: negociação de qualquer loja — 200', async function() {
  const restore = withQuery({ 'FROM agendamento_negociacao': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/negociacao/100', { headers: H(tok('atendimento central')) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('central: NÃO cria usuários — 403', async function() {
  const r = await fetch(baseUrl + '/api/usuarios', {
    method: 'POST', headers: H(tok('atendimento central')),
    body: JSON.stringify({ nome: 'X', email: 'x@x.com', senha: 'Abc123#Forte', cargo: 'vendedor', loja: G })
  });
  assert.equal(r.status, 403);
});

test('central: NÃO pode marcar check-in compareceu — 403', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('atendimento central')),
      body: JSON.stringify({ compareceu: 'Sim', statusAgenda: 'Compareceu' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('central: NÃO pode marcar check-in não compareceu — 403', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('atendimento central')),
      body: JSON.stringify({ statusAgenda: 'Não Compareceu' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('central: corrige nome/WhatsApp num agendamento já marcado Compareceu — 200 (o formulário reenvia o status sem mudar)', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G, { status: 'Compareceu', compareceu: 'Sim' })] } });
  const r2 = withConnect(ag(G, { nome: 'Maria Silva Corrigida' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('atendimento central', G)),
      // o formulário sempre reenvia o statusAgenda atual junto, mesmo sem mudar
      body: JSON.stringify({ nome: 'Maria Silva Corrigida', whatsApp: '11999998888', statusAgenda: 'Compareceu' })
    });
    assert.equal(r.status, 200, 'corrigir dado do cliente não deveria esbarrar no bloqueio de presença');
  } finally { r1(); r2(); }
});

test('central: corrige nome num agendamento já marcado Não Compareceu — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E, { status: 'Não Compareceu', compareceu: 'Não' })] } });
  const r2 = withConnect(ag(E, { nome: 'João Corrigido' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('atendimento central', E)),
      body: JSON.stringify({ nome: 'João Corrigido', statusAgenda: 'Não Compareceu' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('central: tentar mudar de fato o status para Compareceu continua bloqueado — 403', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G, { status: 'Agendado' })] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('atendimento central', G)),
      body: JSON.stringify({ statusAgenda: 'Compareceu' })
    });
    assert.equal(r.status, 403, 'mudar o status de verdade para Compareceu ainda é check-in/presença');
  } finally { restore(); }
});

test('comprador: corrige nome num agendamento já marcado Compareceu — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(P, { status: 'Compareceu', compareceu: 'Sim' })] } });
  const r2 = withConnect(ag(P, { nome: 'Cliente Corrigido' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('comprador', P)),
      body: JSON.stringify({ nome: 'Cliente Corrigido', statusAgenda: 'Compareceu' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

// ════════════════════════════════════════════════════════════════════════════
// 4. GERENTE DE LOJA — uma instância por loja
// ════════════════════════════════════════════════════════════════════════════

for (const loja of LOJAS) {
  test('gerente [' + loja + ']: agendamentos escopados à própria loja', async function() {
    let capturedParam;
    const orig = pool.query;
    pool.query = async function(sql, params) {
      capturedParam = (params || [])[0];
      return { rows: [ag(loja)] };
    };
    try {
      const r = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('gerente de loja', loja)) });
      assert.equal(r.status, 200);
      assert.equal(capturedParam, loja, 'loja da sessão deve ser parâmetro SQL');
    } finally { pool.query = orig; }
  });
}

test('gerente: NÃO acessa lixeira — 403', async function() {
  const r = await fetch(baseUrl + '/api/lixeira', { headers: H(tok('gerente de loja', G)) });
  assert.equal(r.status, 403);
});

test('gerente: faturamentos da própria loja — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [ag(G, { valor_venda: 1200, desconto: 100 })] } });
  try {
    const r = await fetch(baseUrl + '/api/faturamentos', { headers: H(tok('gerente de loja', G)) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('gerente: lead-time da própria loja — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/lead-time', { headers: H(tok('gerente de loja', G)) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('gerente Gonzaga: PATCH com OS na própria loja — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  const r2 = withConnect(ag(G, { numero_os: 'OS100' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', G)),
      body: JSON.stringify({ numero_os: 'OS100' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

for (const loja of LOJAS) {
  test('gerente [' + loja + ']: venda na própria loja confirma presença — 200', async function() {
    const restoreQuery = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(loja, { compareceu: 'Não' })] } });
    const originalConnect = pool.connect;
    let updateParams;
    pool.connect = async function() {
      return {
        query: async function(sql, params) {
          if (sql.includes('UPDATE agendamentos SET')) {
            updateParams = params;
            return { rows: [ag(loja, { status: 'Compareceu', compareceu: 'Sim', valor_venda: 1300 })] };
          }
          return { rows: [] };
        },
        release: function() {}
      };
    };
    try {
      const response = await fetch(baseUrl + '/api/agendamentos/100', {
        method: 'PATCH', headers: H(tok('gerente de loja', loja)),
        body: JSON.stringify({ statusAgenda: 'Não Compareceu', valorVenda: '1300' })
      });
      assert.equal(response.status, 200);
      assert.equal(updateParams[9], 'Compareceu', 'venda deve corrigir o status de ausência');
      assert.equal(updateParams[10], 'Sim', 'venda deve confirmar a presença');
      assert.equal(updateParams[14], '1300');
    } finally {
      pool.connect = originalConnect;
      restoreQuery();
    }
  });
}

test('gerente Gonzaga: PATCH em agendamento da Enseada — 403 cross-store', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', G)),
      body: JSON.stringify({ status: 'Confirmado' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('gerente Enseada: PATCH em agendamento do Ademar — 403 cross-store', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(A)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({ status: 'Confirmado' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('gerente Gonzaga: GET negociação da própria loja — 200', async function() {
  const restore = withQuery({
    'SELECT 1 FROM agendamentos WHERE id': { rows: [{}] },
    'FROM agendamento_negociacao': { rows: [] }
  });
  try {
    const r = await fetch(baseUrl + '/api/negociacao/100', { headers: H(tok('gerente de loja', G)) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('gerente Gonzaga: GET negociação da Enseada — 403', async function() {
  const restore = withQuery({ 'SELECT 1 FROM agendamentos WHERE id': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/negociacao/100', { headers: H(tok('gerente de loja', G)) });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('gerente Gonzaga: POST negociação da Enseada — 403', async function() {
  const restore = withQuery({ 'SELECT 1 FROM agendamentos WHERE id': { rows: [] } });
  try {
    const r = await fetch(baseUrl + '/api/negociacao', {
      method: 'POST', headers: H(tok('gerente de loja', G)),
      body: JSON.stringify({ agendamento_id: 100 })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('gerente: NÃO cria usuários — 403', async function() {
  const r = await fetch(baseUrl + '/api/usuarios', {
    method: 'POST', headers: H(tok('gerente de loja', G)),
    body: JSON.stringify({ nome: 'X', email: 'x@x.com', senha: 'Abc#2026Forte', cargo: 'vendedor', loja: G })
  });
  assert.equal(r.status, 403);
});

// ════════════════════════════════════════════════════════════════════════════
// 5. COMPRADOR — financeiro + OS, escopo por loja, não é admin
// ════════════════════════════════════════════════════════════════════════════

for (const loja of LOJAS) {
  test('comprador [' + loja + ']: agendamentos escopados à própria loja', async function() {
    let capturedParam;
    const orig = pool.query;
    pool.query = async function(sql, params) {
      capturedParam = (params || [])[0];
      return { rows: [ag(loja)] };
    };
    try {
      const r = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('comprador', loja)) });
      assert.equal(r.status, 200);
      assert.equal(capturedParam, loja);
    } finally { pool.query = orig; }
  });
}

test('comprador Enseada: faturamentos — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [ag(E, { valor_venda: 800 })] } });
  try {
    const r = await fetch(baseUrl + '/api/faturamentos', { headers: H(tok('comprador', E)) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('comprador: NÃO acessa lixeira — 403', async function() {
  const r = await fetch(baseUrl + '/api/lixeira', { headers: H(tok('comprador', E)) });
  assert.equal(r.status, 403);
});

test('comprador: NÃO acessa lead-time — 403', async function() {
  const r = await fetch(baseUrl + '/api/lead-time', { headers: H(tok('comprador', E)) });
  assert.equal(r.status, 403);
});

test('comprador Enseada: PATCH OS na própria loja — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  const r2 = withConnect(ag(E, { numero_os: 'OS200', status_os: 'Aberta' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('comprador', E)),
      body: JSON.stringify({ numero_os: 'OS200', status_os: 'Aberta' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('comprador Enseada: PATCH em agendamento da Gonzaga — 403 cross-store', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('comprador', E)),
      body: JSON.stringify({ status: 'Confirmado' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('comprador Pitangueiras: PATCH em agendamento do Ademar — 403 cross-store', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(A)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('comprador', P)),
      body: JSON.stringify({ numero_os: 'OS300' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('comprador: NÃO pode marcar check-in compareceu — 403', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('comprador', E)),
      body: JSON.stringify({ compareceu: 'Sim', statusAgenda: 'Compareceu' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('comprador: NÃO pode marcar check-in não compareceu — 403', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(P)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('comprador', P)),
      body: JSON.stringify({ statusAgenda: 'Não Compareceu' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

// ════════════════════════════════════════════════════════════════════════════
// 6. CONSULTOR DE VENDAS — sem OS/financeiro, escopo por loja
// ════════════════════════════════════════════════════════════════════════════

test('consultor Pitangueiras: agendamentos da própria loja — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [ag(P)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('consultor de vendas', P)) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).total, 1);
  } finally { restore(); }
});

test('consultor: NÃO acessa faturamentos — 403', async function() {
  const r = await fetch(baseUrl + '/api/faturamentos', { headers: H(tok('consultor de vendas', P)) });
  assert.equal(r.status, 403);
});

test('consultor: NÃO acessa lead-time — 403', async function() {
  const r = await fetch(baseUrl + '/api/lead-time', { headers: H(tok('consultor de vendas', P)) });
  assert.equal(r.status, 403);
});

test('consultor Pitangueiras: PATCH numero_os — 403 (campo bloqueado)', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(P)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('consultor de vendas', P)),
      body: JSON.stringify({ numero_os: 'OS999' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('consultor Pitangueiras: PATCH valor_venda — 403 (campo bloqueado)', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(P)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('consultor de vendas', P)),
      body: JSON.stringify({ valor_venda: 500 })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('consultor Pitangueiras: PATCH desconto — 403 (campo bloqueado)', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(P)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('consultor de vendas', P)),
      body: JSON.stringify({ desconto: 50 })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('consultor Pitangueiras: PATCH status (campo permitido) — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(P)] } });
  const r2 = withConnect(ag(P, { status: 'Confirmado' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('consultor de vendas', P)),
      body: JSON.stringify({ status: 'Confirmado' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('consultor Pitangueiras: PATCH em agendamento da Gonzaga — 403 cross-store', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('consultor de vendas', P)),
      body: JSON.stringify({ status: 'Confirmado' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('consultor: NÃO pode excluir_lead — 403', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(P)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('consultor de vendas', P)),
      body: JSON.stringify({ excluir_lead: true })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('consultor: NÃO pode criar agendamento em outra loja — 403', async function() {
  const r = await fetch(baseUrl + '/api/agendamentos', {
    method: 'POST', headers: H(tok('consultor de vendas', P)),
    body: JSON.stringify({ nome: 'Cliente', loja: G, data_agendamento: '2099-12-31', horario: '10:00' })
  });
  assert.equal(r.status, 403);
});

test('consultor: POST negociação da própria loja — 200', async function() {
  const orig = pool.query;
  pool.query = async function(sql) {
    if (sql.includes('SELECT 1 FROM agendamentos WHERE id')) return { rows: [{}] };
    if (sql.includes('SELECT id FROM agendamento_negociacao')) return { rows: [] };
    if (sql.includes('INSERT INTO agendamento_negociacao')) return { rows: [{ id: 1 }] };
    return { rows: [] };
  };
  try {
    const r = await fetch(baseUrl + '/api/negociacao', {
      method: 'POST', headers: H(tok('consultor de vendas', P)),
      body: JSON.stringify({ agendamento_id: 100, status_negociacao: 'Em andamento' })
    });
    assert.equal(r.status, 200);
  } finally { pool.query = orig; }
});

// ════════════════════════════════════════════════════════════════════════════
// 7. VENDEDOR — mesmas restrições de campo que consultor
// ════════════════════════════════════════════════════════════════════════════

test('vendedor Gonzaga: agendamentos da própria loja — 200', async function() {
  const restore = withQuery({ 'FROM agendamentos': { rows: [ag(G)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('vendedor', G)) });
    assert.equal(r.status, 200);
  } finally { restore(); }
});

test('vendedor: NÃO acessa faturamentos — 403', async function() {
  const r = await fetch(baseUrl + '/api/faturamentos', { headers: H(tok('vendedor', G)) });
  assert.equal(r.status, 403);
});

test('vendedor: NÃO acessa lead-time — 403', async function() {
  const r = await fetch(baseUrl + '/api/lead-time', { headers: H(tok('vendedor', G)) });
  assert.equal(r.status, 403);
});

test('vendedor Gonzaga: PATCH status_os — 200 (OS liberada)', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  const r2 = withConnect(ag(G, { status_os: 'Finalizada' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('vendedor', G)),
      body: JSON.stringify({ status_os: 'Finalizada' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('vendedor Gonzaga: PATCH data_abertura_os — 200 (OS liberada)', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  const r2 = withConnect(ag(G, { data_abertura_os: '2026-07-10' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('vendedor', G)),
      body: JSON.stringify({ data_abertura_os: '2026-07-10' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('consultor Gonzaga: PATCH numero_os — 200 (OS liberada)', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  const r2 = withConnect(ag(G, { numero_os: 'OS-GONZAGA-1' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('consultor de vendas', G)),
      body: JSON.stringify({ numero_os: 'OS-GONZAGA-1' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('vendedor Gonzaga: valor_venda continua bloqueado — 403', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('vendedor', G)),
      body: JSON.stringify({ valor_venda: 500 })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('vendedor Gonzaga: PATCH observacao (campo permitido) — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(G)] } });
  const r2 = withConnect(ag(G, { observacao: 'Prefere Zeiss' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('vendedor', G)),
      body: JSON.stringify({ observacao: 'Prefere Zeiss' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('vendedor Gonzaga: PATCH em agendamento do Ademar — 403 cross-store', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(A)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('vendedor', G)),
      body: JSON.stringify({ observacao: 'ok' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('vendedor: NÃO pode criar agendamento em outra loja — 403', async function() {
  const r = await fetch(baseUrl + '/api/agendamentos', {
    method: 'POST', headers: H(tok('vendedor', G)),
    body: JSON.stringify({ nome: 'Cliente', loja: E, data_agendamento: '2099-12-31', horario: '10:00' })
  });
  assert.equal(r.status, 403);
});

test('vendedor: POST negociação da própria loja — 200', async function() {
  const orig = pool.query;
  pool.query = async function(sql) {
    if (sql.includes('SELECT 1 FROM agendamentos WHERE id')) return { rows: [{}] };
    if (sql.includes('SELECT id FROM agendamento_negociacao')) return { rows: [] };
    if (sql.includes('INSERT INTO agendamento_negociacao')) return { rows: [{ id: 2 }] };
    return { rows: [] };
  };
  try {
    const r = await fetch(baseUrl + '/api/negociacao', {
      method: 'POST', headers: H(tok('vendedor', G)),
      body: JSON.stringify({ agendamento_id: 100, status_negociacao: 'Em andamento' })
    });
    assert.equal(r.status, 200);
  } finally { pool.query = orig; }
});

// ════════════════════════════════════════════════════════════════════════════
// 8. OPTOMETRISTA — só compareceu/status/observação, sem financeiro ou OS
// ════════════════════════════════════════════════════════════════════════════

for (const loja of LOJAS) {
  test('optometrista [' + loja + ']: agendamentos escopados à própria loja', async function() {
    let capturedParam;
    const orig = pool.query;
    pool.query = async function(sql, params) {
      capturedParam = (params || [])[0];
      return { rows: [ag(loja)] };
    };
    try {
      const r = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('optometrista', loja)) });
      assert.equal(r.status, 200);
      assert.equal(capturedParam, loja);
    } finally { pool.query = orig; }
  });
}

test('optometrista Enseada: PATCH compareceu (campo permitido) — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  const r2 = withConnect(ag(E, { compareceu: 'sim' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ compareceu: 'sim' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('optometrista Enseada: PATCH status (campo permitido) — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  const r2 = withConnect(ag(E, { status: 'Confirmado' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ status: 'Confirmado' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('optometrista Enseada: PATCH observacao (campo permitido) — 200', async function() {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  const r2 = withConnect(ag(E, { observacao: 'Usa lentes de grau alto' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ observacao: 'Usa lentes de grau alto' })
    });
    assert.equal(r.status, 200);
  } finally { r1(); r2(); }
});

test('optometrista Enseada: PATCH patologia salva Sim no banco — 200', async function() {
  const restoreQuery = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  const originalConnect = pool.connect;
  let updateParams;
  pool.connect = async function() {
    return {
      query: async function(sql, params) {
        if (sql.includes('UPDATE agendamentos SET')) {
          updateParams = params;
          return { rows: [ag(E, { patologia: 'Sim' })] };
        }
        return { rows: [] };
      },
      release: function() {}
    };
  };
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ patologia: 'sim' })
    });
    assert.equal(r.status, 200);
    assert.equal(updateParams[28], 'Sim');
  } finally {
    restoreQuery();
    pool.connect = originalConnect;
  }
});

test('optometrista: valor de patologia inválido — 400', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ patologia: 'Talvez' })
    });
    assert.equal(r.status, 400);
  } finally { restore(); }
});

test('optometrista: as três escolhas gravam um único resultado e campos compatíveis', async function(t) {
  const casos = [
    { valor: 'Check-in Sim veio', status: 'Compareceu', compareceu: 'Sim', patologia: 'Pendente' },
    { valor: 'Check-in Não veio', status: 'Não Compareceu', compareceu: 'Não', patologia: 'Pendente' },
    { valor: 'Patologia', status: 'Compareceu', compareceu: 'Sim', patologia: 'Sim' }
  ];
  for (const caso of casos) {
    await t.test(caso.valor, async function() {
      const restoreQuery = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
      const originalConnect = pool.connect;
      let updateParams;
      pool.connect = async function() {
        return {
          query: async function(sql, params) {
            if (sql.includes('UPDATE agendamentos SET')) {
              updateParams = params;
              return { rows: [ag(E, {
                status: caso.status,
                compareceu: caso.compareceu,
                patologia: caso.patologia,
                resultado_optometrista: caso.valor
              })] };
            }
            return { rows: [] };
          },
          release: function() {}
        };
      };
      try {
        const r = await fetch(baseUrl + '/api/agendamentos/100', {
          method: 'PATCH', headers: H(tok('optometrista', E)),
          body: JSON.stringify({ resultadoOptometrista: caso.valor })
        });
        assert.equal(r.status, 200);
        assert.equal(updateParams[9], caso.status);
        assert.equal(updateParams[10], caso.compareceu);
        assert.equal(updateParams[28], caso.patologia);
        assert.equal(updateParams[29], caso.valor);
      } finally {
        restoreQuery();
        pool.connect = originalConnect;
      }
    });
  }
});

test('gerente visualiza o resultado do optometrista, mas não pode registrá-lo', async function() {
  const restoreView = withQuery({
    'SELECT * FROM agendamentos WHERE': { rows: [ag(E, { resultado_optometrista: 'Patologia' })] }
  });
  try {
    const view = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('gerente de loja', E)) });
    assert.equal(view.status, 200);
    assert.equal((await view.json()).agendamentos[0].resultado_optometrista, 'Patologia');
  } finally { restoreView(); }

  const restorePatch = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const patch = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({ resultadoOptometrista: 'Patologia' })
    });
    assert.equal(patch.status, 403);
  } finally { restorePatch(); }
});

test('gerente da loja visualiza patologia, mas não pode registrá-la', async function() {
  const restoreView = withQuery({
    'SELECT * FROM agendamentos WHERE': { rows: [ag(E, { patologia: 'Sim' })] }
  });
  try {
    const view = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('gerente de loja', E)) });
    assert.equal(view.status, 200);
    const body = await view.json();
    assert.equal(body.agendamentos[0].patologia, 'Sim');
  } finally { restoreView(); }

  const restorePatch = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const patch = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({ patologia: 'Não' })
    });
    assert.equal(patch.status, 403);
  } finally { restorePatch(); }
});

test('optometrista: PATCH numero_os — 403 (campo bloqueado)', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ numero_os: 'OS500' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('optometrista: PATCH valor_venda — 403 (campo bloqueado)', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ valor_venda: 999 })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('optometrista: PATCH loja — 403 (campo bloqueado)', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(E)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ loja: G })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('optometrista: NÃO acessa faturamentos — 403', async function() {
  const r = await fetch(baseUrl + '/api/faturamentos', { headers: H(tok('optometrista', E)) });
  assert.equal(r.status, 403);
});

test('optometrista: NÃO acessa lead-time — 403', async function() {
  const r = await fetch(baseUrl + '/api/lead-time', { headers: H(tok('optometrista', E)) });
  assert.equal(r.status, 403);
});

test('optometrista Enseada: PATCH em agendamento da Pitangueiras — 403 cross-store', async function() {
  const restore = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag(P)] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('optometrista', E)),
      body: JSON.stringify({ compareceu: 'sim' })
    });
    assert.equal(r.status, 403);
  } finally { restore(); }
});

test('optometrista: NÃO pode criar agendamento — 403', async function() {
  const r = await fetch(baseUrl + '/api/agendamentos', {
    method: 'POST', headers: H(tok('optometrista', E)),
    body: JSON.stringify({ nome: 'Cliente', loja: E, data_agendamento: '2099-12-31', horario: '10:00' })
  });
  assert.equal(r.status, 403);
});

// ════════════════════════════════════════════════════════════════════════════
// 9. NOTIFICAÇÕES — admin/central vê tudo; demais perfis filtram por loja
// ════════════════════════════════════════════════════════════════════════════

test('notificações: admin vê todas — 200', async function() {
  const restore = withQuery({
    'FROM notificacoes': { rows: [{ id: 1, tipo: 'negociacao', titulo: 'T', mensagem: 'M', agendamento_id: 1, criado_em: new Date().toISOString() }] }
  });
  try {
    const r = await fetch(baseUrl + '/api/notificacoes', { headers: H(tok('admin')) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).notificacoes.length, 1);
  } finally { restore(); }
});

test('notificações: central vê todas — 200', async function() {
  const restore = withQuery({
    'FROM notificacoes': { rows: [{ id: 2, tipo: 'proposta_15min', titulo: 'T', mensagem: 'M', agendamento_id: 2, criado_em: new Date().toISOString() }] }
  });
  try {
    const r = await fetch(baseUrl + '/api/notificacoes', { headers: H(tok('atendimento central')) });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).notificacoes.length, 1);
  } finally { restore(); }
});

test('notificações: gerente Gonzaga tem loja como parâmetro SQL', async function() {
  let capturedParams = [];
  const orig = pool.query;
  pool.query = async function(sql, params) {
    capturedParams = params || [];
    return { rows: [] };
  };
  try {
    await fetch(baseUrl + '/api/notificacoes', { headers: H(tok('gerente de loja', G)) });
    assert.ok(capturedParams.includes(G), 'loja Gonzaga deve estar nos parâmetros do SQL de notificações');
  } finally { pool.query = orig; }
});

test('notificações: vendedor Pitangueiras tem loja como parâmetro SQL', async function() {
  let capturedParams = [];
  const orig = pool.query;
  pool.query = async function(sql, params) {
    capturedParams = params || [];
    return { rows: [] };
  };
  try {
    await fetch(baseUrl + '/api/notificacoes', { headers: H(tok('vendedor', P)) });
    assert.ok(capturedParams.includes(P), 'loja Pitangueiras deve estar nos parâmetros do SQL de notificações');
  } finally { pool.query = orig; }
});

test('notificações: optometrista Enseada tem loja como parâmetro SQL', async function() {
  let capturedParams = [];
  const orig = pool.query;
  pool.query = async function(sql, params) {
    capturedParams = params || [];
    return { rows: [] };
  };
  try {
    await fetch(baseUrl + '/api/notificacoes', { headers: H(tok('optometrista', E)) });
    assert.ok(capturedParams.includes(E), 'loja Enseada deve estar nos parâmetros do SQL de notificações');
  } finally { pool.query = orig; }
});

// ════════════════════════════════════════════════════════════════════════════
// 10. ROTAS EXCLUSIVAS DE ADMIN — todos os outros perfis bloqueados
// ════════════════════════════════════════════════════════════════════════════

const NAO_ADMIN = [
  ['atendimento central', ''],
  ['gerente de loja', G],
  ['comprador', E],
  ['consultor de vendas', P],
  ['vendedor', P],
  ['optometrista', E]
];

test('todos os não-admin: GET /api/lixeira retorna 403', async function() {
  for (const arr of NAO_ADMIN) {
    const r = await fetch(baseUrl + '/api/lixeira', { headers: H(tok(arr[0], arr[1])) });
    assert.equal(r.status, 403, arr[0] + ' deve ser bloqueado na lixeira');
  }
});

test('todos os não-admin: POST /api/usuarios retorna 403', async function() {
  for (const arr of NAO_ADMIN) {
    const r = await fetch(baseUrl + '/api/usuarios', {
      method: 'POST', headers: H(tok(arr[0], arr[1])),
      body: JSON.stringify({ nome: 'X', email: 'x@tst.com', senha: 'Abc#Forte2026', cargo: 'vendedor', loja: arr[1] })
    });
    assert.equal(r.status, 403, arr[0] + ' deve ser bloqueado em POST /api/usuarios');
  }
});

test('todos os não-admin: DELETE /api/agendamentos retorna 403', async function() {
  for (const arr of NAO_ADMIN) {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'DELETE', headers: H(tok(arr[0], arr[1]))
    });
    assert.equal(r.status, 403, arr[0] + ' deve ser bloqueado em DELETE agendamento');
  }
});

test('perfis sem acesso financeiro: faturamentos retorna 403', async function() {
  const semFinance = [
    ['atendimento central', ''],
    ['consultor de vendas', P],
    ['vendedor', P],
    ['optometrista', E]
  ];
  for (const arr of semFinance) {
    const r = await fetch(baseUrl + '/api/faturamentos', { headers: H(tok(arr[0], arr[1])) });
    assert.equal(r.status, 403, arr[0] + ' deve ser bloqueado em faturamentos');
  }
});

test('perfis sem acesso a lead-time: retorna 403', async function() {
  const semLeadTime = [
    ['comprador', E],
    ['consultor de vendas', P],
    ['vendedor', P],
    ['optometrista', E]
  ];
  for (const arr of semLeadTime) {
    const r = await fetch(baseUrl + '/api/lead-time', { headers: H(tok(arr[0], arr[1])) });
    assert.equal(r.status, 403, arr[0] + ' deve ser bloqueado em lead-time');
  }
});

test('perfis sem acesso a historico-agendamentos: retorna 403', async function() {
  const semHistorico = [
    ['atendimento central', ''],
    ['comprador', E],
    ['consultor de vendas', P],
    ['vendedor', P],
    ['optometrista', E]
  ];
  for (const arr of semHistorico) {
    const r = await fetch(baseUrl + '/api/historico-agendamentos', { headers: H(tok(arr[0], arr[1])) });
    assert.equal(r.status, 403, arr[0] + ' deve ser bloqueado em historico-agendamentos');
  }
});

// ─── Reagendamento reabre como pendente (qualquer perfil) ─────────────────────
// withConnectCaptura: como withConnect, mas guarda os params reais do UPDATE
// para inspecionar exatamente o que foi enviado ao banco.
function withConnectCaptura(updateRow) {
  const orig = pool.connect;
  const captured = {};
  pool.connect = async function() {
    return {
      query: async function(sql, params) {
        if (sql.includes('UPDATE agendamentos SET')) {
          captured.params = params;
          return { rows: [updateRow] };
        }
        return { rows: [] };
      },
      release: function() {}
    };
  };
  return { params: captured, restore: function() { pool.connect = orig; } };
}
const IDX_STATUS = 9, IDX_COMPARECEU = 10, IDX_RESULTADO_OPT = 29, IDX_LIMPAR = 30;

test('reagendar para nova data sem informar presença junto reabre como Agendado/Pendente e limpa resultado do optometrista', async function() {
  const original = ag(E, {
    status: 'Não Compareceu', compareceu: 'Não',
    resultado_optometrista: 'Check-in Não veio', data_agendamento: '2026-07-15'
  });
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [original] } });
  const r2 = withConnectCaptura(ag(E, { status: 'Agendado', compareceu: 'Pendente', data_agendamento: '2026-07-24' }));
  try {
    for (const perfil of ['vendedor', 'atendimento central', 'gerente de loja', 'admin']) {
      const r = await fetch(baseUrl + '/api/agendamentos/100', {
        method: 'PATCH', headers: H(tok(perfil, E)),
        body: JSON.stringify({ data_agendamento: '2026-07-24' })
      });
      assert.equal(r.status, 200, perfil + ' deveria conseguir reagendar');
      assert.equal(r2.params.params[IDX_STATUS], 'Agendado', perfil + ': status deveria reabrir como Agendado');
      assert.equal(r2.params.params[IDX_COMPARECEU], 'Pendente', perfil + ': presença deveria voltar a Pendente');
      assert.equal(r2.params.params[IDX_LIMPAR], 'LIMPAR', perfil + ': resultado do optometrista deveria ser limpo');
    }
  } finally { r1(); r2.restore(); }
});

test('reagendar informando presença/status na mesma requisição não sobrescreve o valor explícito', async function() {
  const original = ag(E, {
    status: 'Não Compareceu', compareceu: 'Não',
    resultado_optometrista: 'Check-in Não veio', data_agendamento: '2026-07-15'
  });
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [original] } });
  const r2 = withConnectCaptura(ag(E, { status: 'Confirmado', compareceu: 'Sim', data_agendamento: '2026-07-24' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({ data_agendamento: '2026-07-24', status: 'Confirmado', compareceu: 'Sim' })
    });
    assert.equal(r.status, 200);
    assert.equal(r2.params.params[IDX_STATUS], 'Confirmado');
    assert.equal(r2.params.params[IDX_COMPARECEU], 'Sim');
    assert.equal(r2.params.params[IDX_LIMPAR], null, 'não deveria disparar a limpeza automática quando o status já veio explícito');
  } finally { r1(); r2.restore(); }
});

test('editar outros campos sem mudar a data não reabre nem limpa o resultado do optometrista', async function() {
  const original = ag(E, {
    status: 'Não Compareceu', compareceu: 'Não',
    resultado_optometrista: 'Check-in Não veio', data_agendamento: '2026-07-15'
  });
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [original] } });
  const r2 = withConnectCaptura(ag(E, { observacao: 'Cliente pediu para ligar antes' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({ observacao: 'Cliente pediu para ligar antes' })
    });
    assert.equal(r.status, 200);
    assert.equal(r2.params.params[IDX_STATUS], null, 'sem mudança de data, status não deveria ser forçado');
    assert.equal(r2.params.params[IDX_COMPARECEU], null, 'sem mudança de data, presença não deveria ser forçada');
    assert.equal(r2.params.params[IDX_LIMPAR], null, 'sem mudança de data, resultado do optometrista não deveria ser limpo');
  } finally { r1(); r2.restore(); }
});

test('reagendar um atendimento marcado Não Compareceu mas com venda registrada corrige para Compareceu/Sim (verde), não volta para pendente', async function() {
  // Cenário real: optometrista marcou "não veio", mas a venda comprova que o
  // cliente compareceu e comprou. A venda tem que vencer tanto a marcação
  // antiga quanto o reset automático de reagendamento.
  const original = ag(E, {
    status: 'Não Compareceu', compareceu: 'Não', resultado_optometrista: 'Check-in Não veio',
    valor_venda: 1500, data_agendamento: '2026-07-10'
  });
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [original] } });
  const r2 = withConnectCaptura(ag(E, { status: 'Compareceu', compareceu: 'Sim', data_agendamento: '2026-07-24' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({ data_agendamento: '2026-07-24' })
    });
    assert.equal(r.status, 200);
    assert.equal(r2.params.params[IDX_STATUS], 'Compareceu', 'venda ativa deve corrigir o status mesmo reagendando a data');
    assert.equal(r2.params.params[IDX_COMPARECEU], 'Sim', 'venda ativa deve corrigir a presença mesmo reagendando a data');
    assert.equal(r2.params.params[IDX_LIMPAR], null, 'não deve apagar o resultado do optometrista quando já existe venda confirmada');
  } finally { r1(); r2.restore(); }
});

test('reagendar um atendimento já marcado Compareceu (sem mudar presença) não mexe em status/presença, só na data', async function() {
  const original = ag(E, {
    status: 'Compareceu', compareceu: 'Sim', resultado_optometrista: 'Check-in Sim veio',
    valor_venda: 1500, data_agendamento: '2026-07-10'
  });
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [original] } });
  const r2 = withConnectCaptura(ag(E, { data_agendamento: '2026-07-24' }));
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({ data_agendamento: '2026-07-24' })
    });
    assert.equal(r.status, 200);
    assert.equal(r2.params.params[IDX_STATUS], null, 'já estava Compareceu — não precisa reescrever, COALESCE preserva');
    assert.equal(r2.params.params[IDX_LIMPAR], null, 'não deve apagar o resultado do optometrista quando já existe venda confirmada');
  } finally { r1(); r2.restore(); }
});
