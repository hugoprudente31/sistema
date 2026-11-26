const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

process.env.SESSION_SECRET = 'test-session-secret-with-at-least-32-characters';

const { criarMarca, validarImagem } = require('../lib/marca');

// PNG 1x1 transparente.
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const JPG_FAKE = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function criarComBancoEmMemoria() {
  const banco = new Map();
  const marca = criarMarca({
    getConfigValor: async (k) => (banco.has(k) ? banco.get(k) : null),
    setConfigValor: async (k, v) => { banco.set(k, v); },
    publicPath: path.join(__dirname, '..', 'public')
  });
  return { marca, banco };
}

async function servir(marca) {
  const app = express();
  app.use(marca.middleware);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('validarImagem aceita PNG/JPG e recusa outros formatos', () => {
  assert.equal(validarImagem(PNG_1X1), null);
  assert.equal(validarImagem(JPG_FAKE), null);
  assert.match(validarImagem('data:image/svg+xml;base64,PHN2Zz4='), /PNG ou JPG/);
  assert.match(validarImagem(JPG_FAKE, { somentePng: true }), /PNG/);
  assert.match(validarImagem(''), /Selecione/);
  assert.match(validarImagem('data:image/png;base64,' + 'A'.repeat(960000)), /700 KB/);
});

test('sem personalização, ícones e manifesto padrão continuam sendo servidos', async () => {
  const { marca } = criarComBancoEmMemoria();
  await marca.carregar();
  const { server, base } = await servir(marca);
  try {
    const manifesto = await (await fetch(base + '/manifest.webmanifest')).json();
    assert.equal(manifesto.icons[0].src, '/icons/icon-192.png');
    const icone = await fetch(base + '/icons/icon-192.png');
    assert.equal(icone.status, 200);
    assert.equal((await fetch(base + '/marca/logo-barra')).status, 404);
    assert.deepEqual(marca.resumo(), { versao: 0, temLogoBarra: false, temIconePersonalizado: false });
  } finally {
    server.close();
  }
});

test('logo da barra e ícone personalizados substituem os padrões e voltam ao padrão', async () => {
  const { marca, banco } = criarComBancoEmMemoria();
  await marca.carregar();
  assert.equal((await marca.salvarLogoBarra(JPG_FAKE, 'hugo@x')).ok, true);
  for (const nome of marca.nomesIcones) {
    assert.equal((await marca.salvarIcone(nome, PNG_1X1, 'hugo@x')).ok, true);
  }
  assert.equal((await marca.salvarIcone('icon999', PNG_1X1)).ok, false);

  const resumo = marca.resumo();
  assert.equal(resumo.temLogoBarra, true);
  assert.equal(resumo.temIconePersonalizado, true);
  assert.ok(resumo.versao > 0);

  // Persistiu no banco: uma nova instância carrega o mesmo estado.
  const outra = criarMarca({ getConfigValor: async (k) => banco.get(k) ?? null, setConfigValor: async () => {}, publicPath: path.join(__dirname, '..', 'public') });
  await outra.carregar();
  assert.equal(outra.resumo().temLogoBarra, true);

  const { server, base } = await servir(marca);
  try {
    const logo = await fetch(base + '/marca/logo-barra?v=' + resumo.versao);
    assert.equal(logo.headers.get('content-type'), 'image/jpeg');
    const icone = await fetch(base + '/icons/icon-512.png?v=' + resumo.versao);
    assert.equal(icone.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await icone.arrayBuffer()), Buffer.from(PNG_1X1.split(',')[1], 'base64'));
    const manifesto = await (await fetch(base + '/manifest.webmanifest')).json();
    assert.ok(manifesto.icons.every((i) => i.src.endsWith('?v=' + resumo.versao)));

    await marca.removerLogoBarra('hugo@x');
    await marca.removerIcones('hugo@x');
    assert.equal((await fetch(base + '/marca/logo-barra')).status, 404);
    const padrao = await fetch(base + '/icons/icon-512.png');
    assert.equal(padrao.status, 200);
    assert.ok(Number(padrao.headers.get('content-length')) > 1000);
  } finally {
    server.close();
  }
});

test('rotas de marca são exclusivas do Super Admin', async () => {
  const { app, signSession } = require('../server');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const semLogin = await fetch(base + '/api/admin/configuracoes/marca');
    assert.ok([401, 403].includes(semLogin.status));
    const token = signSession({ id: 2, nome: 'Outro', email: 'outro@example.com', perfil: 'admin' });
    const admin = await fetch(base + '/api/admin/configuracoes/marca/logo-barra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `tgt_session=${token}` },
      body: JSON.stringify({ dataUrl: PNG_1X1 })
    });
    assert.equal(admin.status, 403);

    const hugo = signSession({ id: 1, nome: 'Hugo', email: 'hugoprudente.marketing@gmail.com', perfil: 'super_admin' });
    const ok = await fetch(base + '/api/admin/configuracoes/marca', { headers: { Cookie: `tgt_session=${hugo}` } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
  } finally {
    server.close();
  }
});
