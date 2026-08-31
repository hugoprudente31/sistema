const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('gerente recebe ação explícita para corrigir valor já lançado na própria loja', function() {
  assert.match(html, /function gerentePodeCorrigirValor\(r\)/);
  assert.match(html, /roleName\(\) === 'gerente de loja'/);
  assert.match(html, /normalizeKey\(r && r\.Loja[^]*normalizeKey\(state\.user && state\.user\.loja/);
  assert.match(html, />Corrigir valor<\/button>/);
});

test('correção envia somente o novo valor da venda e atualiza o painel', function() {
  const inicio = html.indexOf('function corrigirValorVenda(id)');
  const fim = html.indexOf('\nfunction getActionHtml', inicio);
  const funcao = html.slice(inicio, fim);
  assert.match(funcao, /apiPatch\('\/api\/agendamentos\/'[^]*\{ valorVenda: novoValor \}/);
  assert.match(funcao, /agendarAtualizacaoAposAcao\(0\)/);
  assert.match(funcao, /Number\.isFinite\(novoValor\)/);
});

test('servidor mantém gerente limitado à própria loja e registra auditoria', function() {
  const inicio = server.indexOf('app.patch("/api/agendamentos/:id"');
  const fim = server.indexOf('app.delete("/api/agendamentos/:id"', inicio);
  const rota = server.slice(inicio, fim);
  assert.match(rota, /ensureStoreAccess\(req\.session, current\.rows\[0\]\.loja\)/);
  assert.match(rota, /"gerente de loja"/);
  assert.match(rota, /valor_venda = COALESCE\(\$15, valor_venda\)/);
  assert.match(rota, /saveAppointmentBackup/);
});
