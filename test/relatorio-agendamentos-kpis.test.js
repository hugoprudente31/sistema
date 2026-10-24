'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function carregarCalculadora() {
  const inicio = html.indexOf('function calcularTotaisAgendaRelatorio');
  const fim = html.indexOf('\nfunction gerarAgendaPDF', inicio);
  assert.ok(inicio >= 0 && fim > inicio, 'calculadora dos totais não encontrada');
  const contexto = {
    normalizeKey(valor) {
      return String(valor || '').toLowerCase().normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').trim();
    }
  };
  vm.runInNewContext(html.slice(inicio, fim), contexto);
  return contexto.calcularTotaisAgendaRelatorio;
}

test('relatório inclui os cartões Faltas e Só realizou o exame', function() {
  assert.match(html, /label: 'Faltas'/);
  assert.match(html, /label: 'Só realizou o exame \(não comprou\)'/);
});

test('totais distinguem falta, exame sem compra e comparecimento com OS', function() {
  const calcular = carregarCalculadora();
  const totais = calcular([
    { Compareceu: 'Não', StatusAgenda: 'Não Compareceu' },
    { Compareceu: 'Sim', StatusAgenda: 'Compareceu' },
    { Compareceu: 'Sim', StatusAgenda: 'Compareceu', NumeroOS: '2870,07', ValorVenda: 320 },
    { compareceu: 'Pendente', status: 'Agendado' }
  ]);

  assert.deepEqual(
    JSON.parse(JSON.stringify(totais)),
    { compareceram: 2, faltas: 1, somenteExame: 1, comOS: 1, valorTotal: 320 }
  );
});

test('campos legados do banco também entram corretamente nos totais', function() {
  const calcular = carregarCalculadora();
  const totais = calcular([
    { compareceu: 'Não', status: 'Não Compareceu' },
    { compareceu: 'Sim', status: 'Compareceu', numero_os: '', valor_venda: 0 },
    { compareceu: 'Sim', status: 'Compareceu', numero_os: 'OS-10', valor_venda: 500 }
  ]);

  assert.equal(totais.faltas, 1);
  assert.equal(totais.somenteExame, 1);
  assert.equal(totais.comOS, 1);
  assert.equal(totais.valorTotal, 500);
});

test('relatórios em PDF incluem o WhatsApp do lead', function() {
  const agenda = html.slice(html.indexOf('function gerarAgendaPDF'), html.indexOf('function gerarFaturamentoPDF'));
  assert.match(agenda, /'Cliente', 'WhatsApp'/);
  assert.match(agenda, /r\.WhatsApp \|\| r\.whatsapp/);
  const faturamento = html.slice(html.indexOf('function gerarFaturamentoPDF'), html.indexOf('function gerarHistoricoPDF'));
  assert.match(faturamento, /'Cliente', 'WhatsApp'/);
});
