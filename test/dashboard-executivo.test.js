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
    if (text.includes('AS origem') && text.includes('GROUP BY CASE')) return { rows: [{ origem: 'Redes sociais', ...base }] };
    if (text.includes('AS loja') && text.includes('GROUP BY CASE')) return { rows: [{ loja: 'Gonzaga', ...base }] };
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
    assert.equal(body.origens[0].origem, 'Redes sociais');
    assert.equal(body.marketing.clientes, 8);
    assert.equal(body.marketing.vendas, 3);
    assert.equal(body.setores.length, 5);
    assert.equal(body.metas.length, 1);
    assert.ok(body.alertas.some((a) => a.area === 'Atendimento'));
  } finally { pool.query = original; }
});

test('dashboard normaliza Atendimento Central, canais de marketing e a loja Target', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(source, /maria cristina[\s\S]*Atendimento Central/i);
  for (const canal of ['Kommo', 'Landing Page', 'WhatsApp', 'Redes sociais']) assert.match(source, new RegExp(canal));
  const channelRule = source.slice(source.indexOf('const executiveChannelSql'), source.indexOf('const [resumoResult'));
  assert.ok(channelRule.indexOf("THEN 'WhatsApp'") < channelRule.indexOf("THEN 'Kommo'"), 'canal original deve ter prioridade sobre vínculo Kommo');
  assert.ok(channelRule.indexOf("THEN 'Landing Page'") < channelRule.indexOf("THEN 'Kommo'"), 'landing page deve ter prioridade sobre vínculo Kommo');
  assert.match(source, /LIKE '%target%' THEN 'Óticas Target'/);
  assert.match(source, /Clientes dos canais rastreados/);
});

test('interface Admin contém todas as áreas empresariais e uma fonte executiva única', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /id="cardDashboardExecutivo"/);
  for (const area of ['Visão do grupo','Lojas','Clientes','Setores','Consultores','Metas e alertas']) assert.match(html, new RegExp(area));
  assert.match(html, /\/api\/admin\/dashboard-executivo/);
  assert.match(html, /p\.isAdmin.*cardDashboardExecutivo/);
});
