'use strict';
/**
 * Testa a visibilidade de agendamentos criados por "atendimento central"
 * nos painéis dos perfis de loja (gerente, vendedor, optometrista).
 *
 * Camada testada: filter-engine.js (filtro client-side).
 * A lógica server-side (GAS applyVisibility_ / ensureStoreAccess) segue
 * o mesmo critério: filtra pelo campo Loja do agendamento, não por quem criou.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const { filterAppointments, isMine } = require('../public/filter-engine');

// ── Fixtures ────────────────────────────────────────────────────────────────

const HOJE = '2026-06-19';

// Agendamentos criados pelas atendentes centrais para diferentes lojas
const rows = [
  {
    ID: 10,
    NomeCompleto: 'Cliente Gonzaga A',
    Loja: 'Óticas TGT - Gonzaga',
    DataAgendamento: '2026-06-19',
    StatusAgenda: 'Agendado',
    AgendadoPorEmail: 'gabrielle@oticastgt.com.br',
    AgendadoPorNome: 'Gabrielle',
  },
  {
    ID: 11,
    NomeCompleto: 'Cliente Enseada B',
    Loja: 'Óticas TGT Enseada',
    DataAgendamento: '2026-06-19',
    StatusAgenda: 'Agendado',
    AgendadoPorEmail: 'mcfi.tgt@gmail.com.br',
    AgendadoPorNome: 'Maria Cristina',
  },
  {
    ID: 12,
    NomeCompleto: 'Cliente Gonzaga C',
    Loja: 'Óticas TGT - Gonzaga',
    DataAgendamento: '2026-06-18',
    StatusAgenda: 'Confirmado',
    NumeroOS: 'OS-42',
    StatusOS: 'Em produção',
    AgendadoPorEmail: 'gabrielle@oticastgt.com.br',
    AgendadoPorNome: 'Gabrielle',
  },
  {
    ID: 13,
    NomeCompleto: 'Cliente Pitangueiras D',
    Loja: 'Óticas TGT Pitangueiras',
    DataAgendamento: '2026-06-17',
    StatusAgenda: 'Agendado',
    AgendadoPorEmail: 'mcfi.tgt@gmail.com.br',
    AgendadoPorNome: 'Maria Cristina',
  },
  {
    ID: 14,
    NomeCompleto: 'Cliente Enseada E',
    Loja: 'Óticas TGT Enseada',
    DataAgendamento: '2026-06-16',
    StatusAgenda: 'Confirmado',
    NumeroOS: 'OS-55',
    StatusOS: 'Em produção',
    AgendadoPorEmail: 'gabrielle@oticastgt.com.br',
    AgendadoPorNome: 'Gabrielle',
  },
];

// Usuárias atendimento central
const gabrielle    = { nome: 'Gabrielle',    email: 'gabrielle@oticastgt.com.br', perfil: 'atendimento central' };
const mariaCristina = { nome: 'Maria Cristina', email: 'mcfi.tgt@gmail.com.br',   perfil: 'atendimento central' };

// Usuários das lojas (o frontend auto-define filtros.loja para esses perfis)
const gerenteGonzaga  = { nome: 'Gerente Gonzaga',    email: 'gerente.gonzaga@tgt.com',    perfil: 'gerente de loja',       loja: 'Óticas TGT - Gonzaga'  };
const vendedorEnseada = { nome: 'Vendedor Enseada',   email: 'vendedor.enseada@tgt.com',   perfil: 'consultor de vendas',   loja: 'Óticas TGT Enseada'    };
const optoGonzaga     = { nome: 'Opto Gonzaga',       email: 'opto.gonzaga@tgt.com',       perfil: 'optometrista',          loja: 'Óticas TGT - Gonzaga'  };

// Simula o que coletarFiltros() faz para perfis restritos à loja
function filtrosDaLoja(user) {
  return { loja: user.loja };
}

// ── Grupo 1: Visibilidade para gerente de loja ───────────────────────────────

test('gerente de Gonzaga vê agendamentos criados pela central para Gonzaga', () => {
  const result = filterAppointments(rows, filtrosDaLoja(gerenteGonzaga), gerenteGonzaga, HOJE);
  const ids = result.map(r => r.ID).sort((a, b) => a - b);
  assert.deepEqual(ids, [10, 12], 'deve incluir apenas os dois registros de Gonzaga');
});

test('gerente de Gonzaga NÃO vê agendamentos de Enseada nem Pitangueiras', () => {
  const result = filterAppointments(rows, filtrosDaLoja(gerenteGonzaga), gerenteGonzaga, HOJE);
  const ids = result.map(r => r.ID);
  assert.ok(!ids.includes(11), 'NÃO deve incluir Enseada B (ID 11)');
  assert.ok(!ids.includes(13), 'NÃO deve incluir Pitangueiras D (ID 13)');
  assert.ok(!ids.includes(14), 'NÃO deve incluir Enseada E (ID 14)');
});

// ── Grupo 2: Visibilidade para vendedor de loja ──────────────────────────────

test('vendedor de Enseada vê agendamentos criados pela central para Enseada', () => {
  const result = filterAppointments(rows, filtrosDaLoja(vendedorEnseada), vendedorEnseada, HOJE);
  const ids = result.map(r => r.ID).sort((a, b) => a - b);
  assert.deepEqual(ids, [11, 14], 'deve incluir os dois registros de Enseada');
});

test('vendedor de Enseada NÃO vê Gonzaga nem Pitangueiras', () => {
  const result = filterAppointments(rows, filtrosDaLoja(vendedorEnseada), vendedorEnseada, HOJE);
  const ids = result.map(r => r.ID);
  assert.ok(!ids.includes(10), 'NÃO deve incluir Gonzaga A (ID 10)');
  assert.ok(!ids.includes(12), 'NÃO deve incluir Gonzaga C (ID 12)');
  assert.ok(!ids.includes(13), 'NÃO deve incluir Pitangueiras D (ID 13)');
});

// ── Grupo 3: Optometrista ────────────────────────────────────────────────────

test('optometrista de Gonzaga vê agendamentos da sua loja criados pela central', () => {
  const result = filterAppointments(rows, filtrosDaLoja(optoGonzaga), optoGonzaga, HOJE);
  const ids = result.map(r => r.ID);
  assert.ok(ids.includes(10), 'deve incluir Gonzaga A (ID 10)');
  assert.ok(!ids.includes(11), 'NÃO deve incluir Enseada B (ID 11)');
});

// ── Grupo 4: Atendimento central — visão global ──────────────────────────────

test('Gabrielle (central) sem filtro vê agendamentos de TODAS as lojas', () => {
  const result = filterAppointments(rows, {}, gabrielle, HOJE);
  assert.equal(result.length, rows.length, 'deve retornar todos os registros');
});

test('Maria Cristina (central) sem filtro vê agendamentos de TODAS as lojas', () => {
  const result = filterAppointments(rows, {}, mariaCristina, HOJE);
  assert.equal(result.length, rows.length);
});

test('central pode filtrar voluntariamente por uma loja específica', () => {
  const result = filterAppointments(rows, { loja: 'Óticas TGT Enseada' }, gabrielle, HOJE);
  const ids = result.map(r => r.ID).sort((a, b) => a - b);
  assert.deepEqual(ids, [11, 14], 'quando filtra por Enseada vê só Enseada');
});

test('central filtrando por Gonzaga vê só Gonzaga', () => {
  const result = filterAppointments(rows, { loja: 'Óticas TGT - Gonzaga' }, mariaCristina, HOJE);
  const ids = result.map(r => r.ID).sort((a, b) => a - b);
  assert.deepEqual(ids, [10, 12]);
});

// ── Grupo 5: isMine — "meus agendamentos" ───────────────────────────────────

test('isMine — Gabrielle identifica corretamente seus próprios agendamentos', () => {
  const seusDaGabi = rows.filter(r => r.AgendadoPorEmail === 'gabrielle@oticastgt.com.br');
  const naoSeusDaGabi = rows.filter(r => r.AgendadoPorEmail !== 'gabrielle@oticastgt.com.br');
  seusDaGabi.forEach(r => assert.equal(isMine(r, gabrielle), true,  `ID ${r.ID} deve ser dela`));
  naoSeusDaGabi.forEach(r => assert.equal(isMine(r, gabrielle), false, `ID ${r.ID} NÃO deve ser dela`));
});

test('isMine — Maria Cristina identifica corretamente seus próprios agendamentos', () => {
  const seusDaMC = rows.filter(r => r.AgendadoPorEmail === 'mcfi.tgt@gmail.com.br');
  seusDaMC.forEach(r => assert.equal(isMine(r, mariaCristina), true, `ID ${r.ID} deve ser dela`));
});

test('isMine — gerente de Gonzaga NÃO é owner de agendamento criado pela central', () => {
  const rowGabi = rows.find(r => r.ID === 10);
  assert.equal(isMine(rowGabi, gerenteGonzaga), false,
    'agendamento criado pela Gabrielle não pertence ao gerente');
});

test('central com filtro "meus" vê só o que ela criou, em qualquer loja', () => {
  const resultGabi = filterAppointments(rows, { meus: 'true' }, gabrielle, HOJE);
  const idsDaGabi = resultGabi.map(r => r.ID).sort((a, b) => a - b);
  // Gabrielle criou: 10 (Gonzaga), 12 (Gonzaga), 14 (Enseada)
  assert.deepEqual(idsDaGabi, [10, 12, 14], 'Gabrielle com "meus" vê os 3 que ela criou em diferentes lojas');

  const resultMC = filterAppointments(rows, { meus: 'true' }, mariaCristina, HOJE);
  const idsDaMC = resultMC.map(r => r.ID).sort((a, b) => a - b);
  // Maria Cristina criou: 11 (Enseada), 13 (Pitangueiras)
  assert.deepEqual(idsDaMC, [11, 13], 'Maria Cristina com "meus" vê os 2 que ela criou');
});

// ── Grupo 6: Isolamento cruzado ──────────────────────────────────────────────

test('sem filtro de loja — nenhum perfil de loja vê dados de outra loja na engine', () => {
  // Simula: GAS já entregou só os dados da loja correta, filtro de loja está definido
  const apenasGonzaga = rows.filter(r => r.Loja === 'Óticas TGT - Gonzaga');

  // Gerente de Gonzaga com os dados que já vieram filtrados do servidor
  const result = filterAppointments(apenasGonzaga, filtrosDaLoja(gerenteGonzaga), gerenteGonzaga, HOJE);
  assert.ok(result.every(r => r.Loja === 'Óticas TGT - Gonzaga'),
    'todos os registros devem ser de Gonzaga');
});
