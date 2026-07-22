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

process.env.SESSION_SECRET = 'timezone-test-secret-with-32-characters';
require('../server');

test('pool do Postgres fixa o fuso horário da sessão para America/Sao_Paulo em toda nova conexão', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /pool\.on\("connect"/, 'deveria escutar o evento connect do pool');
  const poolSetup = source.slice(source.indexOf('const pool = new Pool'), source.indexOf('const pool = new Pool') + 800);
  assert.match(poolSetup, /SET TIME ZONE 'America\/Sao_Paulo'/, 'deveria fixar o fuso da sessão a cada conexão nova');
});
