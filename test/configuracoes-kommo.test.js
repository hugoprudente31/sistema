const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.SESSION_TTL_HOURS = "1";
process.env.CONFIG_ENCRYPTION_KEY = "test-config-encryption-key-32-bytes-ok";

const { app, signSession, encryptSecret, decryptSecret } = require("../server");
const kommoClient = require("../kommo/client");

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("encryptSecret/decryptSecret: round-trip preserva o valor original", () => {
  const original = "token-super-secreto-do-kommo-123";
  const encrypted = encryptSecret(original);
  assert.notEqual(encrypted, original);
  assert.equal(decryptSecret(encrypted), original);
});

test("decryptSecret devolve string vazia para payload corrompido, sem lançar exceção", () => {
  assert.equal(decryptSecret("isso-nao-e-um-payload-valido"), "");
});

test("kommoClient.reconfigure atualiza subdomain/accessToken/baseUrl no mesmo singleton, sem precisar recriar o módulo", () => {
  const subdomainOriginal = kommoClient.subdomain;
  const tokenOriginal = kommoClient.accessToken;
  try {
    kommoClient.reconfigure({ subdomain: "empresa-teste", accessToken: "token-teste" });
    assert.equal(kommoClient.subdomain, "empresa-teste");
    assert.equal(kommoClient.accessToken, "token-teste");
    assert.equal(kommoClient.baseUrl, "https://empresa-teste.kommo.com/api/v4");
  } finally {
    kommoClient.reconfigure({ subdomain: subdomainOriginal, accessToken: tokenOriginal });
  }
});

test("kommoClient.reconfigure ignora campos ausentes (atualização parcial não apaga o outro campo)", () => {
  kommoClient.reconfigure({ subdomain: "loja-a", accessToken: "token-a" });
  kommoClient.reconfigure({ accessToken: "token-b" });
  assert.equal(kommoClient.subdomain, "loja-a");
  assert.equal(kommoClient.accessToken, "token-b");
});

test("Atendimento Central pode ver o status do Kommo, mas não pode salvar credenciais", async () => {
  const tokenCentral = signSession({ id: "1", email: "central@example.com", perfil: "atendimento central" });

  const respGet = await fetch(baseUrl + "/api/admin/configuracoes/kommo", {
    headers: { cookie: `tgt_session=${tokenCentral}` }
  });
  assert.notEqual(respGet.status, 403);

  const respPost = await fetch(baseUrl + "/api/admin/configuracoes/kommo", {
    method: "POST",
    headers: { cookie: `tgt_session=${tokenCentral}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subdomain: "tentativa-nao-autorizada" })
  });
  assert.equal(respPost.status, 403);
});

test("Perfil de loja não acessa nenhuma rota de Configurações", async () => {
  const tokenVendedor = signSession({ id: "2", email: "vendedor@example.com", perfil: "vendedor" });

  const respKommo = await fetch(baseUrl + "/api/admin/configuracoes/kommo", {
    headers: { cookie: `tgt_session=${tokenVendedor}` }
  });
  assert.equal(respKommo.status, 403);

  const respHorariosLoja = await fetch(baseUrl + "/api/admin/configuracoes/horarios-loja", {
    headers: { cookie: `tgt_session=${tokenVendedor}` }
  });
  assert.equal(respHorariosLoja.status, 403);

  const respHorariosOpto = await fetch(baseUrl + "/api/admin/configuracoes/horarios-optometrista", {
    headers: { cookie: `tgt_session=${tokenVendedor}` }
  });
  assert.equal(respHorariosOpto.status, 403);

  const respBloqueios = await fetch(baseUrl + "/api/admin/configuracoes/bloqueios-agenda", {
    headers: { cookie: `tgt_session=${tokenVendedor}` }
  });
  assert.equal(respBloqueios.status, 403);
});

test("Admin e Atendimento Central acessam horários de loja e de optometrista", async () => {
  for (const perfil of ["admin", "atendimento central"]) {
    const token = signSession({ id: "3", email: `${perfil.replace(/\s+/g, "-")}@example.com`, perfil });
    const respLoja = await fetch(baseUrl + "/api/admin/configuracoes/horarios-loja", {
      headers: { cookie: `tgt_session=${token}` }
    });
    assert.notEqual(respLoja.status, 403);

    const respOpto = await fetch(baseUrl + "/api/admin/configuracoes/horarios-optometrista", {
      headers: { cookie: `tgt_session=${token}` }
    });
    assert.notEqual(respOpto.status, 403);

    const respBloqueios = await fetch(baseUrl + "/api/admin/configuracoes/bloqueios-agenda", {
      headers: { cookie: `tgt_session=${token}` }
    });
    assert.notEqual(respBloqueios.status, 403);
  }
});
