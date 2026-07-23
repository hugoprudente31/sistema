'use strict';
/**
 * Bug real encontrado em produção: um agendamento vindo da landing page foi
 * gravado com loja = "Óticas Target - Santo Antônio" — valor que não bate
 * com nenhuma das 5 lojas cadastradas (a oficial é "óticas Target - Ademar
 * de Barros"). O mapa de variações tinha entradas para "Sto. Antônio" e
 * "Santo Antônio", mas nenhuma com hífen entre "Target" e "Santo Antônio",
 * então caiu no fallback antigo (que devolvia o texto cru sem corrigir),
 * criando um agendamento invisível para qualquer perfil de loja (só
 * admin/atendimento central enxergam agendamentos fora do padrão).
 */
process.env.SESSION_SECRET = 'normaliza-loja-secret-com-32-caracteres';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLojaPublica } = require('../server');

test('reconhece a variação real que causou o bug (hífen entre Target e Santo Antônio)', () => {
  assert.equal(normalizeLojaPublica('Óticas Target - Santo Antônio'), 'óticas Target - Ademar de Barros');
  assert.equal(normalizeLojaPublica('Target - Sto. Antônio'), 'óticas Target - Ademar de Barros');
  assert.equal(normalizeLojaPublica('Óticas TGT - Santo Antônio'), 'óticas Target - Ademar de Barros');
});

test('continua reconhecendo as variações já cadastradas para as outras lojas', () => {
  assert.equal(normalizeLojaPublica('Gonzaga'), 'óticas TGT - Gonzaga');
  assert.equal(normalizeLojaPublica('Enseada'), 'óticas TGT Enseada');
  assert.equal(normalizeLojaPublica('Pitangueiras'), 'óticas TGT Pitangueiras');
  assert.equal(normalizeLojaPublica('Ademar de Barros'), 'óticas Target - Ademar de Barros');
  assert.equal(normalizeLojaPublica('Santos'), 'óticas TGT - Gonzaga');
});

test('é insensível a pontuação, acento e maiúsculas/minúsculas', () => {
  assert.equal(normalizeLojaPublica('gonzaga & santos'), 'óticas TGT - Gonzaga');
  assert.equal(normalizeLojaPublica('GONZAGA'), 'óticas TGT - Gonzaga');
  assert.equal(normalizeLojaPublica('  Enseada  '), 'óticas TGT Enseada');
});

test('loja não reconhecida retorna null em vez de aceitar um valor inventado', () => {
  // Antes desta correção, um valor não mapeado era devolvido sem alteração,
  // criando um agendamento com uma loja que não existe de verdade.
  assert.equal(normalizeLojaPublica('Loja que não existe'), null);
  assert.equal(normalizeLojaPublica(''), null);
  assert.equal(normalizeLojaPublica(null), null);
});
