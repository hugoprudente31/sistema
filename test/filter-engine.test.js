const test = require('node:test');
const assert = require('node:assert/strict');
const { filterAppointments } = require('../public/filter-engine');

const rows = [
  { ID: 1, NomeCompleto: 'José Silva', Loja: 'Óticas TGT Enseada', DataAgendamento: '2026-06-19', StatusAgenda: 'Agendado', StatusOS: '', AgendadoPorEmail: 'vendedor@tgt.com' },
  { ID: 2, NomeCompleto: 'Maria Souza', Loja: 'Óticas TGT Enseada', DataAgendamento: '2026-06-10', StatusAgenda: 'Concluído', NumeroOS: 'OS-2', StatusOS: 'Em produção', AgendadoPorEmail: 'vendedor@tgt.com' },
  { ID: 3, NomeCompleto: 'Carlos Lima', Loja: 'Óticas TGT - Gonzaga', DataAgendamento: '2026-01-10', StatusAgenda: 'Cancelado', NumeroOS: 'OS-3', StatusOS: 'Cancelado', AgendadoPorEmail: 'outro@tgt.com' },
  { ID: 4, NomeCompleto: 'Atendimento Futuro', Loja: 'Óticas TGT Enseada', DataAgendamento: '2026-07-01', StatusAgenda: 'Confirmado', AgendadoPorEmail: 'outro@tgt.com' },
  { ID: 5, NomeCompleto: 'Compra Real', Loja: 'Óticas TGT Enseada', DataAgendamento: '2026-06-11', StatusAgenda: 'Concluído', NumeroOS: 'OS-5', StatusOS: 'Em produção', ValorVenda: '1.250,50', AgendadoPorEmail: 'vendedor@tgt.com' }
];
const user = { nome: 'Vendedor', email: 'vendedor@tgt.com' };

test('sem filtro mostra todos os registros permitidos', () => {
  assert.equal(filterAppointments(rows, {}, user, '2026-06-19').length, 5);
});

test('período inteligente só é aplicado quando selecionado', () => {
  assert.deepEqual(filterAppointments(rows, { periodoDias: '15' }, user, '2026-06-19').map((r) => r.ID), [1, 2, 5]);
});

test('combina loja, status, cliente e datas com normalização', () => {
  const result = filterAppointments(rows, {
    loja: 'oticas tgt enseada', status: 'concluido', cliente: 'maria', dataDe: '2026-06-01', dataAte: '2026-06-30'
  }, user, '2026-06-19');
  assert.deepEqual(result.map((r) => r.ID), [2]);
});

test('meus serviços e minhas OS ativas respeitam usuário e status', () => {
  assert.deepEqual(filterAppointments(rows, { meus: 'true' }, user, '2026-06-19').map((r) => r.ID), [1, 2, 5]);
  assert.deepEqual(filterAppointments(rows, { minhasOSAtivas: 'true' }, user, '2026-06-19').map((r) => r.ID), [2, 5]);
});

test('resultado comprou exige valor de venda registrado', () => {
  assert.deepEqual(filterAppointments(rows, { resultado: ['comprou'] }, user, '2026-06-19').map((r) => r.ID), [5]);
});
