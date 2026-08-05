'use strict';
/**
 * Pedido real do Hugo: consultor que atendeu um cliente num dia (ex.:
 * 04/08/2026) mas não conseguiu lançar no sistema na hora, e só registra
 * depois. A regra de "horário comercial" (10h-18h dia útil, sáb 10h-16h,
 * domingo fechado) existe pra proteger reserva NOVA de horário sem sentido
 * — não deveria valer pra lançamento retroativo de algo que já aconteceu.
 *
 * A trava só existia no JavaScript do navegador (validarHorarioVisual em
 * public/index.html) — o servidor nem verifica isso nesta rota (só na
 * pública da landing page). Este teste executa a função real extraída do
 * arquivo, dentro de um sandbox `vm`, igual ao padrão já usado em
 * interceptor-browser-real.test.js — não é regex sobre texto-fonte.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extrairFuncao(nome) {
  const inicio = html.indexOf(`function ${nome}(`);
  assert.ok(inicio > -1, `função ${nome} não encontrada em public/index.html`);
  const fimAssinatura = html.indexOf('{', inicio) + 1;
  // Fecha no primeiro "}" sem indentação após a assinatura — todo o corpo
  // desta função usa if de uma linha só, sem chaves aninhadas.
  const fechamento = html.indexOf('\n}', fimAssinatura);
  assert.ok(fechamento > -1, `fechamento de ${nome} não encontrado`);
  return html.slice(inicio, fechamento + 2);
}

function carregarSandbox(hojeFixo) {
  const sandbox = {
    __els: {},
    byId(id) { return sandbox.__els[id]; },
    hojeBrasil() { return hojeFixo; }
  };
  vm.createContext(sandbox);
  vm.runInContext(extrairFuncao('validarHorarioVisual'), sandbox);
  return sandbox;
}

function validar(sandbox, data, horario) {
  sandbox.__els = { dataAgendamento: { value: data }, horario: { value: horario } };
  return vm.runInContext('validarHorarioVisual()', sandbox);
}

test('lançamento retroativo (data passada) fica livre da regra de horário comercial', () => {
  const sandbox = carregarSandbox('2026-08-05');
  assert.equal(validar(sandbox, '2026-08-04', '20:00'), null, 'horário tarde num dia passado deveria ser aceito');
  assert.equal(validar(sandbox, '2026-08-04', '08:00'), null, 'horário cedo num dia passado deveria ser aceito');
  assert.equal(validar(sandbox, '2026-08-02', '10:00'), null, 'domingo passado deveria ser aceito (lançamento retroativo)');
});

test('reserva de hoje e do futuro continuam obedecendo o horário comercial normalmente', () => {
  const sandbox = carregarSandbox('2026-08-05');
  assert.match(validar(sandbox, '2026-08-05', '08:00'), /entre 10:00 e 18:00/, 'hoje fora do horário deveria continuar bloqueado');
  assert.match(validar(sandbox, '2026-08-06', '08:00'), /entre 10:00 e 18:00/, 'futuro fora do horário deveria continuar bloqueado');
  assert.equal(validar(sandbox, '2026-08-06', '11:00'), null, 'futuro dentro do horário deveria continuar liberado');
});
