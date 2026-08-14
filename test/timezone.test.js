'use strict';
/**
 * O Postgres gerenciado usa UTC por padrão para CURRENT_TIMESTAMP/NOW().
 * Sem fixar o fuso da sessão, qualquer registro feito após ~21h (horário de
 * Brasília) grava/exibe a data do dia seguinte, já que as colunas de
 * data/hora são TIMESTAMP sem fuso. Este teste garante que a correção
 * (fixar o fuso da sessão do Postgres em cada conexão do pool) não seja
 * removida sem querer numa refatoração futura.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('pool compartilhado fixa o fuso de Brasília já na abertura da conexão', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
  assert.match(source, /options:\s*"-c timezone=America\/Sao_Paulo"/,
    'deveria configurar o fuso no handshake, antes da primeira consulta');
  assert.doesNotMatch(source, /pool\.on\("connect"[^]*client\.query/,
    'não deve iniciar uma consulta concorrente dentro do evento connect');
});
