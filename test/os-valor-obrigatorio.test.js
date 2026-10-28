const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('modal de OS sempre mostra o valor, mesmo para perfis sem financeiro', function() {
  const inicio = html.indexOf('function abrirModalOS(id, row)');
  const fim = html.indexOf('\nfunction salvarOS_Modal', inicio);
  const funcao = html.slice(inicio, fim);
  assert.match(funcao, /var campoValorOS = [^\n]*Valor da OS \(R\$\) \*/);
  assert.match(funcao, /: *\r?\n *\('<div class="row">' \+ campoValorOS \+ '<\/div>'\)/);
});

test('salvar OS exige valor maior que zero e sempre o envia', function() {
  const inicio = html.indexOf('function salvarOS_Modal(id)');
  const fim = html.indexOf('\nfunction abrirPromptOS', inicio);
  const funcao = html.slice(inicio, fim);
  assert.match(funcao, /Valor da OS é obrigatório\./);
  assert.match(funcao, /valorVenda: valorOS,/);
});

test('edição com número de OS exige valor', function() {
  const inicio = html.indexOf('function salvarEdicaoLinha()');
  const fim = html.indexOf('\nfunction abrirModalReagendamento', inicio);
  const funcao = html.slice(inicio, fim);
  assert.match(funcao, /payload\.numeroOS && osOuValorAlterado/);
  assert.match(funcao, /Informe o valor da OS para registrar a OS\./);
});

test('servidor rejeita OS sem valor para qualquer perfil e loja', function() {
  const inicio = server.indexOf('app.patch("/api/agendamentos/:id"');
  const fim = server.indexOf('app.delete("/api/agendamentos/:id"', inicio);
  const rota = server.slice(inicio, fim);
  assert.match(rota, /if \(numeroOSFinal && \(alterouNumeroOS \|\| alterouValorVenda\) && !\(valorVendaEfetivo > 0\)\)/);
  assert.match(rota, /status\(400\)[^\n]*Informe o valor da OS/);
  // A regra vem antes do UPDATE, para nada ser gravado sem valor.
  assert.ok(rota.indexOf('valorVendaEfetivo > 0') < rota.indexOf('valor_venda = COALESCE($15, valor_venda)'));
});
