'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('módulos de produção compartilham um único pool PostgreSQL', () => {
  const productionFiles = [
    'server.js',
    'kommo/reminder.js',
    'kommo/followups.js',
    'kommo/webhook.js',
    'kommo/scheduling.js',
    'kommo/crmLog.js',
    'kommo/bot/stateManager.js',
  ];
  for (const file of productionFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /new Pool\s*\(/, `${file} não deve criar pool próprio`);
    assert.match(source, /lib\/db|lib\\db/, `${file} deve importar o pool compartilhado`);
  }
});

test('pool possui limites para conexão, consulta e transação ociosa', () => {
  const source = read('lib/db.js');
  assert.match(source, /DATABASE_POOL_MAX/);
  assert.match(source, /statement_timeout/);
  assert.match(source, /query_timeout/);
  assert.match(source, /idle_in_transaction_session_timeout/);
  assert.match(source, /connectionTimeoutMillis/);
});

test('schema usa migrações numeradas e trava entre instâncias', () => {
  const runner = read('lib/migrations.js');
  const migration = read('database/migrations/001_operational_hardening.js');
  assert.match(runner, /schema_migrations/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /BEGIN/);
  assert.match(runner, /ROLLBACK/);
  assert.match(migration, /automacao_execucoes/);
  assert.match(migration, /idx_agendamentos_operacao_loja_data/);
});

test('jobs automáticos usam trava distribuída e registram resultado', () => {
  const monitor = read('lib/jobMonitor.js');
  assert.match(monitor, /pg_try_advisory_lock/);
  assert.match(monitor, /INSERT INTO automacao_execucoes/);
  assert.match(monitor, /pg_advisory_unlock/);
});

test('retenção permanece desativada até autorização explícita', () => {
  const maintenance = read('lib/databaseMaintenance.js');
  const env = read('env.example');
  assert.match(maintenance, /DATABASE_RETENTION_ENABLED !== "true"/);
  assert.match(env, /DATABASE_RETENTION_ENABLED=false/);
  assert.match(env, /DATABASE_CRM_RETENTION_ENABLED=false/);
});
