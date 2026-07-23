const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.SESSION_SECRET = 'dashboard-executivo-secret-with-32-characters';
const { app, pool, signSession } = require('../server');

let server;
let baseUrl;
test.before(async () => new Promise((resolve) => {
  server = app.listen(0, '127.0.0.1', () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
test.after(async () => new Promise((resolve) => server.close(resolve)));

function headers(perfil) {
  const token = signSession({ id: '1', nome: 'Gestor', email: `gestor-${perfil}@example.com`, perfil });
  return { cookie: `tgt_session=${token}` };
}

test('dashboard executivo é exclusivo do Admin', async () => {
  const response = await fetch(baseUrl + '/api/admin/dashboard-executivo', { headers: headers('gerente de loja') });
  assert.equal(response.status, 403);
});

test('dashboard executivo consolida grupo, lojas, consultores, origens, setores, metas e alertas', async () => {
  const original = pool.query;
  pool.query = async (sql) => {
    const text = String(sql);
    const base = { agendamentos: 10, clientes: 8, comparecimentos: 6, faltas: 2, vendas: 3, faturamento: 3000, descontos: 150, os_ativas: 2, os_atrasadas: 1, lead_time_medio: 5 };
    if (text.includes('FROM metas_desempenho')) return { rows: [{ tipo_escopo: 'grupo', meta_faturamento: 5000 }] };
    if (text.includes('DATE_TRUNC')) return { rows: [{ competencia: '2026-07', ...base }] };
    if (text.includes('GROUP BY a.vendedor_consultor_id')) return { rows: [{ id: 12, consultor: 'Ana', loja: 'Gonzaga', ...base }] };
    if (text.includes('AS origem') && text.includes('GROUP BY CASE')) return { rows: [
      { origem: 'Atendimento Central', ...base },
      { origem: 'Loja', agendamentos: 5, clientes: 4, comparecimentos: 3, faltas: 1, vendas: 2, faturamento: 1000, descontos: 0, os_ativas: 0, os_atrasadas: 0, lead_time_medio: 0 }
    ] };
    if (text.includes('AS loja') && text.includes('GROUP BY CASE')) return { rows: [{ loja: 'Gonzaga', ...base }] };
    if (text.includes('NOT EXISTS (SELECT 1 FROM lojas')) return { rows: [] };
    return { rows: [base] };
  };
  try {
    const response = await fetch(baseUrl + '/api/admin/dashboard-executivo?inicio=2026-07-01&fim=2026-07-31', { headers: headers('admin') });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.resumo.taxa_comparecimento, 60);
    assert.equal(body.resumo.taxa_conversao, 50);
    assert.equal(body.resumo.ticket_medio, 1000);
    assert.equal(body.lojas.length, 1);
    assert.equal(body.consultores[0].id, 12);
    assert.equal(body.origens[0].origem, 'Atendimento Central');
    for (const canal of ['Atendimento Central', 'Landing Page (Teste de Visão)', 'Loja']) assert.ok(body.origens.some((row) => row.origem === canal));
    const agendadoPelaLoja = body.origens.find((row) => row.origem === 'Loja');
    assert.equal(agendadoPelaLoja.clientes, 4);
    assert.equal(body.marketing.clientes, 8, 'Loja não deve contar como canal de marketing rastreado');
    assert.equal(body.marketing.vendas, 3, 'Loja não deve contar como canal de marketing rastreado');
    assert.equal(body.setores.length, 5);
    assert.equal(body.metas.length, 1);
    assert.ok(body.alertas.some((a) => a.area === 'Atendimento'));
  } finally { pool.query = original; }
});

test('dashboard alerta automaticamente quando há agendamentos com loja fora do cadastro oficial', async () => {
  // Bug real: agendamentos vindos da landing page com loja não normalizada
  // (ex: "Óticas Target - Santo Antônio" sem bater com nenhuma das 5 lojas
  // cadastradas) ficavam invisíveis para perfis de loja por semanas, e só
  // apareciam num diagnóstico manual (/api/admin/diag/loja-mismatch) que
  // ninguém sabia que precisava consultar. Este alerta precisa aparecer
  // sozinho no dashboard executivo, sem precisar saber que o diagnóstico existe.
  const original = pool.query;
  pool.query = async (sql) => {
    const text = String(sql);
    const base = { agendamentos: 10, clientes: 8, comparecimentos: 6, faltas: 2, vendas: 3, faturamento: 3000, descontos: 150, os_ativas: 2, os_atrasadas: 1, lead_time_medio: 5 };
    if (text.includes('FROM metas_desempenho')) return { rows: [] };
    if (text.includes('DATE_TRUNC')) return { rows: [] };
    if (text.includes('GROUP BY a.vendedor_consultor_id')) return { rows: [] };
    if (text.includes('AS origem') && text.includes('GROUP BY CASE')) return { rows: [] };
    if (text.includes('AS loja') && text.includes('GROUP BY CASE')) return { rows: [] };
    if (text.includes('NOT EXISTS (SELECT 1 FROM lojas')) return { rows: [
      { loja: 'Óticas Target - Santo Antônio', total: 44 },
      { loja: 'loja inventada', total: 2 }
    ] };
    return { rows: [base] };
  };
  try {
    const response = await fetch(baseUrl + '/api/admin/dashboard-executivo?inicio=2026-07-01&fim=2026-07-31', { headers: headers('admin') });
    assert.equal(response.status, 200);
    const body = await response.json();
    const alertaCadastro = body.alertas.find((a) => a.area === 'Cadastro');
    assert.ok(alertaCadastro, 'deve existir um alerta de área "Cadastro" quando há loja órfã');
    assert.equal(alertaCadastro.nivel, 'alto');
    assert.match(alertaCadastro.mensagem, /46 agendamento/, 'deve somar o total de todas as variantes órfãs (44 + 2)');
    assert.match(alertaCadastro.mensagem, /Óticas Target - Santo Antônio/);
  } finally { pool.query = original; }
});

test('dashboard não alerta sobre cadastro quando não há loja órfã', async () => {
  const original = pool.query;
  pool.query = async (sql) => {
    const text = String(sql);
    const base = { agendamentos: 10, clientes: 8, comparecimentos: 6, faltas: 2, vendas: 3, faturamento: 3000, descontos: 150, os_ativas: 2, os_atrasadas: 1, lead_time_medio: 5 };
    if (text.includes('FROM metas_desempenho')) return { rows: [] };
    if (text.includes('DATE_TRUNC')) return { rows: [] };
    if (text.includes('GROUP BY a.vendedor_consultor_id')) return { rows: [] };
    if (text.includes('AS origem') && text.includes('GROUP BY CASE')) return { rows: [] };
    if (text.includes('AS loja') && text.includes('GROUP BY CASE')) return { rows: [] };
    if (text.includes('NOT EXISTS (SELECT 1 FROM lojas')) return { rows: [] };
    return { rows: [base] };
  };
  try {
    const response = await fetch(baseUrl + '/api/admin/dashboard-executivo?inicio=2026-07-01&fim=2026-07-31', { headers: headers('admin') });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(!body.alertas.some((a) => a.area === 'Cadastro'), 'não deve haver alerta de Cadastro quando a query não retorna lojas órfãs');
  } finally { pool.query = original; }
});

test('a query de loja órfã usa comparação insensível a acento/caixa contra a tabela lojas oficial', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const routeStart = source.indexOf('app.get("/api/admin/dashboard-executivo"');
  const routeBody = source.slice(routeStart, source.indexOf('\napp.', routeStart + 20));
  assert.match(routeBody, /NOT EXISTS \(SELECT 1 FROM lojas l WHERE/, 'deve excluir lojas que já batem com o cadastro oficial via NOT EXISTS');
  assert.match(routeBody, /storeSql\("l\.nome", "a\.loja"\)/, 'deve reusar o helper storeSql (mesma normalização de acento\\/caixa usada no resto do sistema)');
});

test('dashboard normaliza Atendimento Central (Kommo+WhatsApp+Central), Landing Page, Loja e a loja Target', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /maria cristina[\s\S]*Atendimento Central/i);
  for (const canal of ['Atendimento Central', 'Landing Page', 'Loja']) assert.match(source, new RegExp(canal));
  const channelRule = source.slice(source.indexOf('const executiveChannelSql'), source.indexOf('const [resumoResult'));
  const landingPos = channelRule.indexOf("THEN 'Landing Page");
  const lojaStaffPos = channelRule.indexOf("THEN 'Loja'");
  const kommoLinkPos = channelRule.indexOf('a.kommo_lead_id IS NOT NULL');
  assert.ok(landingPos > -1 && kommoLinkPos > -1 && landingPos < kommoLinkPos, 'landing page deve ter prioridade sobre vínculo Kommo');
  assert.ok(lojaStaffPos > -1 && kommoLinkPos > -1 && lojaStaffPos < kommoLinkPos, 'agendamento por perfil da loja deve ter prioridade sobre o vínculo raso de Kommo (kommo_lead_id)');
  assert.match(channelRule, /LIKE '%whatsapp%'[\s\S]*THEN 'Atendimento Central'/, 'WhatsApp deve ser unificado em Atendimento Central');
  assert.match(channelRule, /kommo_lead_id IS NOT NULL[\s\S]*THEN 'Atendimento Central'/, 'Kommo (catch-all raso) continua caindo em Atendimento Central como último recurso');
  assert.match(source, /LIKE '%target%' THEN 'Óticas Target'/);
  assert.match(source, /Clientes dos canais rastreados/);
  assert.match(source, /canaisMarketing = new Set\(\["Atendimento Central", "Landing Page \(Teste de Visão\)"\]\)/, 'Loja deve ficar fora da soma de Marketing');
});

test('interface Admin contém todas as áreas empresariais e uma fonte executiva única', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="cardDashboardExecutivo"/);
  for (const area of ['Visão do grupo','Lojas','Clientes','Setores','Consultores','Metas e alertas']) assert.match(html, new RegExp(area));
  assert.match(html, /\/api\/admin\/dashboard-executivo/);
  assert.match(html, /p\.isAdmin.*cardDashboardExecutivo/);
});
