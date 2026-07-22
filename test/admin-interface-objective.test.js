const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('painel operacional agrupa exportações e não mistura comandos técnicos no cabeçalho', () => {
  const painelOs = html.slice(html.indexOf('Painel de Acompanhamento de OS'), html.indexOf('filters-box', html.indexOf('Painel de Acompanhamento de OS')));
  assert.match(painelOs, /Exportar relatório/);
  assert.match(painelOs, /Baixar CSV/);
  assert.match(painelOs, /Baixar PDF/);
  assert.doesNotMatch(painelOs, /Sincronizar sistema|Diagnóstico do Kommo|Notificações retroativas|Disparar lembretes/);
});

test('central técnica concentra manutenção e permanece exclusiva do Super Admin', () => {
  const central = html.slice(html.indexOf('id="areaTecnica"'), html.indexOf('id="cardKommoDiag"'));
  assert.match(central, /Central Técnica do Criador/);
  assert.match(central, /Sincronizar sistema/);
  assert.match(central, /Diagnóstico do Kommo/);
  assert.match(central, /Sincronizar agendamentos → Kommo/);
  assert.match(central, /Gerar notificações retroativas/);
  assert.match(central, /Disparar lembretes 24h/);
  assert.match(html, /if \(p\.isSuperAdmin\) byId\('areaTecnica'\)\.classList\.remove\('hidden'\)/);
  assert.doesNotMatch(html, /if \(p\.isAdmin\) byId\('areaTecnica'\)/);
});

test('gestão de usuários carrega automaticamente e oferece filtros objetivos', () => {
  assert.match(html, /id="usuarioBusca"/);
  assert.match(html, /id="usuarioFiltroPerfil"/);
  assert.match(html, /id="usuarioFiltroStatus"/);
  assert.match(html, /function filtrarUsuariosAdmin\(\)/);
  assert.match(html, /limparFormularioMeta\(\);\s*carregarUsuarios\(\);\s*return carregarMetasAdmin\(\)/);
  assert.doesNotMatch(html, />Atualizar lista</);
});
