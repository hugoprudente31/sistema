'use strict';
/**
 * Correções da auditoria de outubro/2026:
 * - agendamentos da grade antiga de 15 min continuam editáveis;
 * - DATE vindo do banco como objeto Date não transforma edição em reagendamento;
 * - choque de horário considera a duração do atendimento (20 min);
 * - "Reagendado" é um agendamento ativo (ocupa horário, recebe lembrete);
 * - sábado: Santos até 16:00, Guarujá até 15:00;
 * - lead da LP aparece só como Setor de Relacionamento Pós Vendas;
 * - confirmação da LP exige o nome real digitado pela Central.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';
process.env.SESSION_TTL_HOURS = '1';

const { app, pool, signSession } = require('../server');
const {
  STATUS_QUE_OCUPAM_HORARIO,
  STATUS_AGENDA_PENDENTES,
  sqlHorarioConflita,
  jornadaPadrao,
  gerarSlotsJornada
} = require('../lib/horarios');

const E = 'Óticas TGT Enseada';
const G = 'Óticas TGT - Gonzaga';
// Datas sempre futuras (e dentro do limite de anos aceito por toPgDate).
function proximoDiaDaSemana(diaSemana) {
  const d = new Date(new Date().getFullYear() + 2, 0, 1);
  while (d.getDay() !== diaSemana) d.setDate(d.getDate() + 1);
  return d;
}
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const QUARTA_DATE = proximoDiaDaSemana(3);
const QUARTA = iso(QUARTA_DATE);
const SABADO = iso(proximoDiaDaSemana(6));

let server, baseUrl;

function tok(perfil, loja) {
  return signSession({ id: '1', nome: 'Test', email: `t@${perfil.replace(/\s+/g, '')}.com`, perfil, loja: loja || '' });
}
function H(token) {
  return { cookie: `tgt_session=${token}`, 'content-type': 'application/json' };
}
function ag(extra) {
  return Object.assign({
    id: 100, nome: 'Maria Silva', whatsapp: '13999999999', email: 'maria@x.com',
    loja: E, optometrista: 'Ana', status: 'Confirmado', observacao: '',
    compareceu: 'Pendente', numero_os: '123', valor_venda: 0, kommo_lead_id: null,
    excluido_em: null, horario: '10:15', data_agendamento: new Date(QUARTA_DATE.getTime())
  }, extra || {});
}

function withQuery(map) {
  const orig = pool.query;
  pool.query = async function(sql) {
    for (const key of Object.keys(map)) if (sql.includes(key)) return map[key];
    return { rows: [] };
  };
  return function restore() { pool.query = orig; };
}

// Cliente de transação: devolve `choque` para a consulta de sobreposição e
// captura os parâmetros do UPDATE/INSERT.
function withConnect({ choque = null, row = ag() } = {}) {
  const orig = pool.connect;
  const captured = { sqls: [] };
  pool.connect = async function() {
    return {
      query: async function(sql, params) {
        captured.sqls.push(sql);
        if (sql.includes('EXTRACT(EPOCH')) return { rows: choque ? [choque] : [] };
        if (sql.includes('UPDATE agendamentos SET') || sql.includes('INSERT INTO agendamentos')) {
          captured.params = params;
          return { rows: [row] };
        }
        return { rows: [] };
      },
      release: function() {}
    };
  };
  return { captured, restore: function() { pool.connect = orig; } };
}

// Payload real do modal de edição: reenvia loja/data/horário inalterados.
function payloadModal(extra) {
  return Object.assign({
    origem: '', nomeCompleto: 'Maria Silva', whatsApp: '13999999999', email: 'maria@x.com',
    loja: E, optometrista: 'Ana', dataAgendamento: QUARTA, horario: '10:15',
    statusAgenda: 'Confirmado', numeroOS: '123', valorVenda: '', observacao: ''
  }, extra || {});
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

test('Reagendado é status ativo e ocupa horário', () => {
  assert.ok(STATUS_AGENDA_PENDENTES.includes('Reagendado'));
  assert.ok(STATUS_QUE_OCUPAM_HORARIO.includes('Reagendado'));
  assert.ok(STATUS_QUE_OCUPAM_HORARIO.includes('OS em Andamento'));
});

test('choque de horário usa janela de 20 minutos e é seguro para horários fora do padrão', () => {
  const sql = sqlHorarioConflita('horario', '$4');
  assert.match(sql, /ABS\(EXTRACT\(EPOCH FROM \(horario::time - \$4::text::time\)\)\) < 1200/);
  assert.match(sql, /ELSE horario = \$4::text/);
  assert.match(sql, /CASE/);
});

test('sábado: Santos até 16:00 e Guarujá até 15:00', () => {
  assert.equal(jornadaPadrao(G, 6).horaFim, '16:00');
  for (const loja of [E, 'Óticas TGT Pitangueiras', 'Óticas Target - Ademar de Barros']) {
    assert.equal(jornadaPadrao(loja, 6).horaFim, '15:00', loja);
    const slots = gerarSlotsJornada(jornadaPadrao(loja, 6));
    assert.equal(slots[slots.length - 1], '15:00', loja);
  }
});

test('modal de edição salva agendamento da grade antiga (10:15) sem mexer no horário', async () => {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag()] } });
  const c = withConnect();
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)), body: JSON.stringify(payloadModal())
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.ok(c.captured.params, 'UPDATE deveria ter sido executado');
  } finally { r1(); c.restore(); }
});

test('data do banco (objeto Date) não transforma edição comum em reagendamento', async () => {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag({ horario: '10:20' })] } });
  const c = withConnect();
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify(payloadModal({ horario: '10:20', email: 'novo@x.com' }))
    });
    assert.equal(r.status, 200);
    // status/presença não podem ser resetados para Agendado/Pendente.
    assert.notEqual(c.captured.params[9], 'Agendado');
    assert.notEqual(c.captured.params[30], 'LIMPAR');
  } finally { r1(); c.restore(); }
});

test('origem vazia reenviada por quem não vê a origem não transfere a autoria', async () => {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag({ horario: '10:20', origem: 'Instagram' })] } });
  const c = withConnect();
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify(payloadModal({ horario: '10:20', numeroOS: '999', valorVenda: '350' }))
    });
    assert.equal(r.status, 200);
    assert.equal(c.captured.params[31], false, 'só lançar OS não muda o Agendado por');
  } finally { r1(); c.restore(); }
});

test('mudar para horário fora da grade de 20 minutos continua bloqueado', async () => {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag({ horario: '10:20' })] } });
  const c = withConnect();
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify(payloadModal({ horario: '10:45' }))
    });
    assert.equal(r.status, 400);
    assert.equal(c.captured.params, undefined);
  } finally { r1(); c.restore(); }
});

test('mudar para horário que se sobrepõe a outro atendimento é bloqueado', async () => {
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [ag({ horario: '11:00' })] } });
  const c = withConnect({ choque: { id: 7, horario: '10:15' } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify(payloadModal({ horario: '10:20' }))
    });
    const body = await r.json();
    assert.equal(r.status, 409);
    assert.match(body.message, /10:15/);
    assert.equal(c.captured.params, undefined);
  } finally { r1(); c.restore(); }
});

test('novo agendamento pelo painel que se sobrepõe a outro é bloqueado', async () => {
  const c = withConnect({ choque: { id: 7, horario: '10:15' } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', {
      method: 'POST', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({
        nome: 'Cliente Novo', loja: E, optometrista: 'Ana', data_agendamento: QUARTA,
        horario: '10:20', proprietario_nome: 'Vendedor Real'
      })
    });
    assert.equal(r.status, 409);
    assert.equal(c.captured.params, undefined);
  } finally { c.restore(); }
});

test('agendamento do painel por quem não vê origem grava origem padrão', async () => {
  const c = withConnect();
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', {
      method: 'POST', headers: H(tok('gerente de loja', E)),
      body: JSON.stringify({
        nome: 'Cliente Novo', loja: E, optometrista: 'Ana', data_agendamento: QUARTA,
        horario: '10:20', proprietario_nome: 'Vendedor Real'
      })
    });
    assert.equal(r.status, 200);
    assert.ok(c.captured.params.includes('Loja'), 'origem padrão "Loja" deveria ser gravada');
  } finally { c.restore(); }
});

test('sábado no Guarujá não aceita 15:20; em Santos aceita', async () => {
  for (const [loja, esperado] of [[E, 400], [G, 200]]) {
    const c = withConnect();
    try {
      const r = await fetch(baseUrl + '/api/agendamentos', {
        method: 'POST', headers: H(tok('admin', loja)),
        body: JSON.stringify({
          nome: 'Cliente Sabado', loja, optometrista: 'Ana', data_agendamento: SABADO,
          horario: '15:20', proprietario_nome: 'Vendedor Real'
        })
      });
      assert.equal(r.status, esperado, loja);
    } finally { c.restore(); }
  }
});

test('lead da LP não revela a Landing Page para quem não é Super Admin', async () => {
  const lp = ag({
    origem: 'Landing Page', origem_sync: 'landing_page', responsavel: 'Landing Page',
    proprietario_nome: 'Landing Page', proprietario_id: 'landing-page',
    criado_por_email: 'landingpage@sistema.local',
    agendado_por_nome: 'Setor de Relacionamento Pós Vendas',
    access_tags: 'origem:site;fluxo:pendente-confirmacao',
    observacao: 'Quero exame | Landing page: teste-visao | Campanha: outubro | UTM: utm_source=meta'
  });
  const r1 = withQuery({ 'FROM agendamentos': { rows: [lp] } });
  try {
    const r = await fetch(baseUrl + '/api/agendamentos', { headers: H(tok('atendimento central', '')) });
    const body = await r.json();
    assert.equal(r.status, 200);
    const item = body.agendamentos[0];
    const texto = JSON.stringify(item).toLowerCase();
    assert.ok(!texto.includes('landing'), texto);
    assert.ok(!texto.includes('utm'), texto);
    assert.ok(!texto.includes('campanha'), texto);
    assert.equal(item.setor_relacionamento, true);
    assert.equal(item.responsavel, 'Setor de Relacionamento Pós Vendas');
    assert.equal(item.observacao, 'Quero exame');
  } finally { r1(); }
});

test('confirmação de lead da LP exige o nome real digitado pela Central', async () => {
  const lp = ag({ status: 'Agendado', origem_sync: 'landing_page', horario: '10:20' });
  const r1 = withQuery({ 'SELECT * FROM agendamentos WHERE id': { rows: [lp] } });
  const c = withConnect();
  try {
    const semNome = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('atendimento central', '')),
      body: JSON.stringify({ statusAgenda: 'Confirmado' })
    });
    assert.equal(semNome.status, 400);
    const comNome = await fetch(baseUrl + '/api/agendamentos/100', {
      method: 'PATCH', headers: H(tok('atendimento central', '')),
      body: JSON.stringify({ statusAgenda: 'Confirmado', confirmadoPorCentralNome: 'Joana Lima' })
    });
    assert.equal(comNome.status, 200);
  } finally { r1(); c.restore(); }
});
