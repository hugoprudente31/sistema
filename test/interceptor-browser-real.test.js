'use strict';
/**
 * Bug real encontrado em produção: o interceptor client-side de PATCH em
 * public/index.html filtrava/carimbava campos por perfil de forma
 * desalinhada com o servidor. Isso já causou dois bugs distintos (allowlist
 * desatualizado apagando resultadoOptometrista/patologia; validarPayload()
 * carimbando campos de "dono do registro" que o servidor rejeita com 403
 * para perfis restritos) — em ambos os casos, TODOS os testes de servidor
 * continuavam passando, porque o bug estava inteiramente no JavaScript do
 * navegador, nunca exercitado pela suíte.
 *
 * Este arquivo não faz asserção sobre texto-fonte (regex): ele extrai o
 * módulo real de public/index.html (entre os marcadores
 * TGT_SISTEMA_REGRAS_DEFINITIVAS_INICIO/FIM) e EXECUTA esse código de
 * verdade dentro de um sandbox mínimo (vm), exatamente como um navegador
 * executaria, para garantir que window.apiPatch/window.apiPost realmente
 * produzem o payload esperado — pegando de volta bugs de divergência
 * cliente/servidor como os de hoje.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extrairModuloRegras() {
  const startMarker = '<!-- TGT_SISTEMA_REGRAS_DEFINITIVAS_INICIO -->';
  const endMarker = '<!-- TGT_SISTEMA_REGRAS_DEFINITIVAS_FIM -->';
  const startIdx = html.indexOf(startMarker);
  const endIdx = html.indexOf(endMarker);
  assert.ok(startIdx > -1 && endIdx > startIdx, 'marcadores do módulo de regras não foram encontrados em public/index.html');
  const trecho = html.slice(startIdx + startMarker.length, endIdx);
  const scriptStart = trecho.indexOf('<script>') + '<script>'.length;
  const scriptEnd = trecho.lastIndexOf('</script>');
  assert.ok(scriptStart > -1 && scriptEnd > scriptStart, '<script> do módulo de regras não encontrado');
  return trecho.slice(scriptStart, scriptEnd);
}

const MODULE_CODE = extrairModuloRegras();

function rodarModuloNoBrowserFake(usuario) {
  const chamadasPatch = [];
  const chamadasPost = [];
  const windowObj = {
    state: { user: usuario },
    apiPatch: (path, payload) => { chamadasPatch.push({ path, payload }); return Promise.resolve({ ok: true }); },
    apiPost: (path, payload) => { chamadasPost.push({ path, payload }); return Promise.resolve({ ok: true }); },
    apiGet: () => Promise.resolve({ agendamentos: [] })
  };
  const sandbox = {
    window: windowObj,
    document: { addEventListener: () => {}, getElementById: () => null },
    console: { log: () => {} },
    setInterval: (fn) => { fn(); return 0; },
    clearInterval: () => {},
    setTimeout: (fn) => { fn(); return 0; },
    canManageOS: () => false,
    alert: () => {}
  };
  vm.createContext(sandbox);
  vm.runInContext(MODULE_CODE, sandbox, { filename: 'index.html#regras-definitivas' });
  return { windowObj, chamadasPatch, chamadasPost };
}

test('interceptor real de PATCH deixa passar resultadoOptometrista sem filtrar (bug do allowlist desatualizado)', () => {
  const { windowObj, chamadasPatch } = rodarModuloNoBrowserFake({
    perfil: 'optometrista', nome: 'Dra. Fulana', email: 'fulana@example.com', loja: 'óticas TGT Enseada', permissions: {}
  });

  return windowObj.apiPatch('/api/agendamentos/206', { resultadoOptometrista: 'Compareceu e comprou', patologia: 'Nenhuma' }).then(() => {
    assert.equal(chamadasPatch.length, 1);
    const payloadEnviado = chamadasPatch[0].payload;
    assert.equal(payloadEnviado.resultadoOptometrista, 'Compareceu e comprou', 'resultadoOptometrista não pode ser removido pelo interceptor');
    assert.equal(payloadEnviado.patologia, 'Nenhuma', 'patologia não pode ser removida pelo interceptor');
  });
});

test('interceptor real de PATCH não carimba mais campos de dono do registro (bug do validarPayload em edição)', () => {
  const { windowObj, chamadasPatch } = rodarModuloNoBrowserFake({
    perfil: 'optometrista', nome: 'Dra. Fulana', email: 'fulana@example.com', loja: 'óticas TGT Enseada', permissions: {}
  });

  return windowObj.apiPatch('/api/agendamentos/206', { resultadoOptometrista: 'Compareceu e comprou' }).then(() => {
    const payloadEnviado = chamadasPatch[0].payload;
    for (const campo of ['agendado_por_nome', 'ultima_alteracao_por_nome', 'ultima_alteracao_por_email', 'proprietario_nome', 'criado_por_nome']) {
      assert.equal(payloadEnviado[campo], undefined, `${campo} não deveria ter sido carimbado pelo interceptor de PATCH — o servidor rejeita esse campo com 403 para optometrista`);
    }
  });
});

test('interceptor real de PATCH continua bloqueando campos financeiros para consultor sem permissão de OS (Gonzaga)', () => {
  const { windowObj, chamadasPatch } = rodarModuloNoBrowserFake({
    perfil: 'consultor de vendas', nome: 'Vendedor Teste', email: 'vendedor@example.com', loja: 'óticas TGT - Gonzaga', permissions: {}
  });

  return windowObj.apiPatch('/api/agendamentos/1', { valorVenda: 500, numeroOS: '123', compareceu: 'Sim' }).then(() => {
    const payloadEnviado = chamadasPatch[0].payload;
    assert.equal(payloadEnviado.valorVenda, undefined, 'valorVenda deve continuar bloqueado para consultor sem canManageOS');
    assert.equal(payloadEnviado.numeroOS, undefined, 'numeroOS deve continuar bloqueado para consultor sem canManageOS');
    assert.equal(payloadEnviado.compareceu, 'Sim', 'campos fora do bloqueio continuam passando normalmente');
  });
});

test('interceptor real de POST (criação) continua carimbando os campos de auditoria via validarPayload', () => {
  const { windowObj, chamadasPost } = rodarModuloNoBrowserFake({
    perfil: 'consultor de vendas', nome: 'Vendedor Teste', email: 'vendedor@example.com', loja: 'óticas TGT - Gonzaga', permissions: {}
  });

  return windowObj.apiPost('/api/agendamentos', { nome: 'Cliente Real' }).then(() => {
    const payloadEnviado = chamadasPost[0].payload;
    assert.equal(payloadEnviado.agendado_por_nome, 'vendedor teste');
    assert.equal(payloadEnviado.criado_por_email, 'vendedor@example.com');
  });
});

test('interceptor real de POST continua bloqueando nome de cliente "teste"', () => {
  const { windowObj } = rodarModuloNoBrowserFake({
    perfil: 'admin', nome: 'Admin', email: 'admin@example.com', loja: 'Todas', permissions: {}
  });

  return assert.rejects(
    () => windowObj.apiPost('/api/agendamentos', { nome: 'Cliente TESTE' }),
    /Não é permitido cadastrar cliente com nome TESTE/
  );
});
