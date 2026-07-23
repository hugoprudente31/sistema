'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mailingboss = require('../mailingboss');

test('emailValido reconhece formatos válidos e inválidos', () => {
  assert.equal(mailingboss.emailValido('cliente@example.com'), true);
  assert.equal(mailingboss.emailValido('cliente@example'), false);
  assert.equal(mailingboss.emailValido('naolembra.gmail.com'), false, 'placeholder real de produção, sem @, não pode passar');
  assert.equal(mailingboss.emailValido(''), false);
  assert.equal(mailingboss.emailValido(null), false);
});

test('tagParaLoja normaliza acento/caixa e usa formato loja-xxx', () => {
  assert.equal(mailingboss.tagParaLoja('óticas TGT - Gonzaga'), 'loja-oticas-tgt-gonzaga');
  assert.equal(mailingboss.tagParaLoja('óticas Target - Ademar de Barros'), 'loja-oticas-target-ademar-de-barros');
  assert.equal(mailingboss.tagParaLoja(''), 'loja-nao-informada');
  assert.equal(mailingboss.tagParaLoja(null), 'loja-nao-informada');
});

test('adicionarInscrito não chama a API e sinaliza skipped quando MAILINGBOSS_TOKEN não está configurado', async () => {
  const original = process.env.MAILINGBOSS_TOKEN;
  delete process.env.MAILINGBOSS_TOKEN;
  const originalFetch = global.fetch;
  let chamouFetch = false;
  global.fetch = async () => { chamouFetch = true; return { ok: true, json: async () => ({ status: 'success' }) }; };
  try {
    const resultado = await mailingboss.adicionarInscrito({ email: 'cliente@example.com', nome: 'Cliente Teste', loja: 'Loja A' });
    assert.equal(resultado.skipped, true);
    assert.equal(chamouFetch, false, 'sem token configurado, não deve nem tentar chamar a API');
  } finally {
    if (original === undefined) delete process.env.MAILINGBOSS_TOKEN; else process.env.MAILINGBOSS_TOKEN = original;
    global.fetch = originalFetch;
  }
});

test('adicionarInscrito não chama a API e sinaliza skipped quando o e-mail é ausente/inválido (evita poluir a lista com lixo)', async () => {
  process.env.MAILINGBOSS_TOKEN = 'token-de-teste';
  const originalFetch = global.fetch;
  let chamouFetch = false;
  global.fetch = async () => { chamouFetch = true; return { ok: true, json: async () => ({ status: 'success' }) }; };
  try {
    const resultado = await mailingboss.adicionarInscrito({ email: 'naotem.gmail.com', nome: 'Cliente Teste', loja: 'Loja A' });
    assert.equal(resultado.skipped, true);
    assert.equal(chamouFetch, false);
  } finally {
    delete process.env.MAILINGBOSS_TOKEN;
    global.fetch = originalFetch;
  }
});

test('adicionarInscrito monta a URL, o corpo e a tag por loja corretamente quando tudo está configurado', async () => {
  process.env.MAILINGBOSS_TOKEN = 'token-de-teste';
  const originalFetch = global.fetch;
  let requisicao = null;
  global.fetch = async (url, options) => {
    requisicao = { url, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ status: 'success', data: { subscriber_uid: 'abc123' } }) };
  };
  try {
    const resultado = await mailingboss.adicionarInscrito({
      email: 'cliente@example.com', nome: 'Maria Silva', whatsapp: '13999998888', loja: 'óticas TGT - Gonzaga', origem: 'landing_page'
    });
    assert.equal(resultado.ok, true);
    assert.equal(requisicao.url, 'https://member.mailingboss.com/integration/index.php/lists/subscribers/create/token-de-teste');
    assert.equal(requisicao.body.email, 'cliente@example.com');
    assert.equal(requisicao.body.fname, 'Maria');
    assert.equal(requisicao.body.lname, 'Silva');
    assert.equal(requisicao.body.PHONE, '13999998888', 'a lista "Agendamento Online" exige telefone -- confirmado contra a API real');
    assert.equal(requisicao.body.TERMO, '100', 'a lista exige aceite de termos -- confirmado como aceite implícito com o cliente');
    assert.equal(requisicao.body.taginternals, 'loja-oticas-tgt-gonzaga, origem-landing-page');
    assert.ok(requisicao.body.list_uid, 'deve usar a lista padrão quando MAILINGBOSS_LIST_UID não está configurado');
  } finally {
    delete process.env.MAILINGBOSS_TOKEN;
    global.fetch = originalFetch;
  }
});

test('adicionarInscrito usa MAILINGBOSS_LIST_UID quando configurado, em vez do padrão', async () => {
  process.env.MAILINGBOSS_TOKEN = 'token-de-teste';
  process.env.MAILINGBOSS_LIST_UID = 'lista-customizada-123';
  const originalFetch = global.fetch;
  let requisicao = null;
  global.fetch = async (url, options) => {
    requisicao = JSON.parse(options.body);
    return { ok: true, json: async () => ({ status: 'success' }) };
  };
  try {
    await mailingboss.adicionarInscrito({ email: 'cliente@example.com', nome: 'Cliente', loja: 'Loja A' });
    assert.equal(requisicao.list_uid, 'lista-customizada-123');
  } finally {
    delete process.env.MAILINGBOSS_TOKEN;
    delete process.env.MAILINGBOSS_LIST_UID;
    global.fetch = originalFetch;
  }
});

test('adicionarInscrito lança erro quando a API do Mailingboss responde com falha', async () => {
  process.env.MAILINGBOSS_TOKEN = 'token-de-teste';
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, json: async () => ({ status: 'error', message: 'token invalido' }) });
  try {
    await assert.rejects(() => mailingboss.adicionarInscrito({ email: 'cliente@example.com', nome: 'Cliente', loja: 'Loja A' }));
  } finally {
    delete process.env.MAILINGBOSS_TOKEN;
    global.fetch = originalFetch;
  }
});

test('sincronizarLead nunca lança erro, mesmo quando a API falha (não pode derrubar quem chamou)', async () => {
  process.env.MAILINGBOSS_TOKEN = 'token-de-teste';
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('rede fora do ar'); };
  try {
    await assert.doesNotReject(() => mailingboss.sincronizarLead({ id: 999, email: 'cliente@example.com', nome: 'Cliente', loja: 'Loja A' }));
  } finally {
    delete process.env.MAILINGBOSS_TOKEN;
    global.fetch = originalFetch;
  }
});
