const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('banco cria identidade comercial única por nome normalizado e loja', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /CREATE TABLE IF NOT EXISTS vendedores_consultores/);
  assert.match(server, /UNIQUE \(nome_chave, loja_chave\)/);
  assert.match(server, /vendedor_consultor_id/);
  assert.match(server, /CREATE TRIGGER trg_vincular_vendedor_consultor_tgt/);
  assert.match(server, /ON CONFLICT \(nome_chave, loja_chave\)/);
});

test('formulário envia o nome para os campos comerciais estruturados', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /list="listaVendedoresConsultores"/);
  assert.match(html, /vendedor_nome: payload\.consultorNome/);
  assert.match(html, /vendedor_atendeu_nome: payload\.consultorNome/);
  assert.match(html, /consultor_responsavel: payload\.consultorNome/);
  assert.match(html, /VendedorConsultorId: r\.vendedor_consultor_id/);
});
