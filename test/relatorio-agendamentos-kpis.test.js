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

test('relatório em PDF traz a coluna WhatsApp logo depois do cliente', function() {
  const inicio = html.indexOf('\nfunction gerarAgendaPDF');
  const corpo = html.slice(inicio, html.indexOf('\nfunction gerarFaturamentoPDF', inicio));
  assert.match(corpo, /'Cliente', 'WhatsApp', 'Status'/);
  assert.match(corpo, /formatarWhatsAppRelatorio\(r\.WhatsApp \|\| r\.whatsapp\)/);
});

test('WhatsApp do relatório sai formatado e tolera número fora do padrão', function() {
  const inicio = html.indexOf('function formatarWhatsAppRelatorio');
  const fim = html.indexOf('\nfunction gerarAgendaPDF', inicio);
  const contexto = {};
  vm.runInNewContext(html.slice(inicio, fim), contexto);
  const fmt = contexto.formatarWhatsAppRelatorio;
  assert.equal(fmt('11912345678'), '(11) 91234-5678');
  assert.equal(fmt('+55 (13) 99876-5432'), '(13) 99876-5432');
  assert.equal(fmt('1332345678'), '(13) 3234-5678');
  assert.equal(fmt(''), '—');
  assert.equal(fmt(null), '—');
  assert.equal(fmt('9876-5432'), '9876-5432');
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
