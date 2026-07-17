const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('venda ativa tem prioridade verde sobre ausência antiga no painel', function() {
  const compra = html.indexOf("if (!cancelado && (venda === 'sim' || valorVenda > 0))");
  const ausencia = html.indexOf("compareceu === 'nao' || compareceu === 'nao compareceu'");
  assert.ok(compra >= 0, 'regra da venda ativa não encontrada');
  assert.ok(ausencia > compra, 'a venda precisa ser avaliada antes da ausência antiga');
});

test('modal permite ao gerente corrigir a presença e mantém a loja travada', function() {
  assert.match(html, /id="editCompareceu"/);
  assert.match(html, /payload\.compareceu = byId\('editCompareceu'\)\.value/);
  assert.match(html, /state\.user\.loja[^]*byId\('editLoja'\)\.disabled = true/);
});

test('servidor normaliza compras novas e corrige compras antigas', function() {
  assert.match(server, /const compareceuVenda = compraAtiva \? "Sim" : null/);
  assert.match(server, /const comprasCorrigidas = await pool\.query/);
  assert.match(server, /SET compareceu = 'Sim'/);
  assert.match(server, /CREATE OR REPLACE FUNCTION validar_agendamento_tgt\(\)[^]*NEW\.compareceu := 'Sim'/);
});
