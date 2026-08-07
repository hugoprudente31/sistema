'use strict';
/**
 * Auditoria do Painel de Acompanhamento de OS (2026-08-06/07): "OS Atrasadas"
 * e "OS 7/15/30 dias" sempre mostravam 0 (placeholders nunca implementados
 * desde a migração pro Postgres), e o filtro "Etapa do lead" tinha suporte
 * no SQL do backend mas o front-end nunca mandava o parâmetro. As respostas
 * de GET /api/dashboard e /api/agendamentos já têm teste de comportamento
 * (dashboard-simples.test.js, perfis.test.js); este arquivo cobre o que só
 * existe embutido no <script> de public/index.html, seguindo o mesmo padrão
 * de checagem por texto-fonte já usado em vendedor-identidade.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('filtro "Etapa do lead" é enviado ao backend (buildAgendamentosUrl manda estagio=)', () => {
  const start = html.indexOf('function buildAgendamentosUrl');
  const body = html.slice(start, html.indexOf('\nfunction ', start + 20));
  assert.match(body, /f\.estagio.*estagio=/, 'estagio tinha suporte no SQL do servidor mas nunca era enviado pela URL do painel');
});

test('"OS Atrasadas" usa o IsOverdue já calculado por linha, em vez de ficar sempre 0', () => {
  const start = html.indexOf('function buildDashboardLocal');
  const body = html.slice(start, html.indexOf('\nfunction ', start + 20));
  assert.match(body, /if \(r\.IsOverdue\) atrasadas\+\+/);
});

test('"OS 7/15/30 dias" calcula um valor real como fallback (contarOsPorPeriodo), não fica hardcoded em 0', () => {
  assert.match(html, /function contarOsPorPeriodo\(rows, dias, hoje\)/);
  const start = html.indexOf('function buildDashboardLocal');
  const body = html.slice(start, html.indexOf('\nfunction ', start + 20));
  assert.match(body, /os7: contarOsPorPeriodo\(rows, 7, hoje\)/);
  assert.match(body, /os15: contarOsPorPeriodo\(rows, 15, hoje\)/);
  assert.match(body, /os30: contarOsPorPeriodo\(rows, 30, hoje\)/);
});

test('painel prioriza os7/os15/os30 calculados no backend (não presos ao filtro de data da tela) sobre o fallback local', () => {
  const start = html.indexOf('function recarregarComFiltros');
  const body = html.slice(start, html.indexOf('\nfunction ', start + 20));
  assert.match(body, /aplicarOsBackendNoDashboard\(\)/, 'deve aplicar por cima os valores vindos de GET /api/dashboard (results[1])');
  assert.match(body, /state\.dashboardOsBackend = dashboardBackend/);
});

test('edição pontual (aplicarRespostaAgendamentoAtualizado) também reaplica os7/os15/os30 do backend, sem regredir pro fallback local', () => {
  const start = html.indexOf('function aplicarRespostaAgendamentoAtualizado');
  const body = html.slice(start, html.indexOf('\nfunction ', start + 20));
  assert.match(body, /aplicarOsBackendNoDashboard\(\)/);
});

test('aviso de busca truncada (capped) só é commitado em state depois do gate de requestSeq, não direto no fetch', () => {
  const start = html.indexOf('function recarregarComFiltros');
  const body = html.slice(start, html.indexOf('\nfunction ', start + 20));
  assert.match(body, /state\.agendamentosCapped = !!\(results\[0\] && results\[0\]\.__capped\)/);
  const fetchStart = html.indexOf('function getAgendamentosPostgres');
  const fetchBody = html.slice(fetchStart, html.indexOf('\nfunction ', fetchStart + 20));
  assert.doesNotMatch(fetchBody, /state\.agendamentosCapped\s*=/, 'getAgendamentosPostgres não deve gravar direto em state -- só o callback já gateado por requestSeq faz isso');
});
