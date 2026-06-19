const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.SESSION_TTL_HOURS = "1";

const { app, pool, signSession } = require("../server");

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

test("rotas internas rejeitam acesso anônimo", async () => {
  for (const path of ["/api/agendamentos", "/api/usuarios", "/api/dashboard"]) {
    const response = await fetch(baseUrl + path);
    assert.equal(response.status, 401, path);
  }
});

test("proxy GAS rejeita acesso anônimo", async () => {
  const response = await fetch(baseUrl + "/api/gas", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fn: "getUsuarios", args: [] })
  });
  assert.equal(response.status, 401);
});

test("login exige e-mail e senha", async () => {
  const response = await fetch(baseUrl + "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@example.com" })
  });
  assert.equal(response.status, 400);
});

test("login individual valida bcrypt e emite cookie HttpOnly", async () => {
  const originalQuery = pool.query;
  const hash = await bcrypt.hash("SenhaIndividual#2026", 4);
  pool.query = async () => ({
    rows: [{
      id: 1,
      nome: "Administrador",
      email: "admin@example.com",
      senha: hash,
      cargo: "admin",
      loja: "Loja A",
      access_tags: "",
      can_view_finance: true,
      ativo: true
    }]
  });

  try {
    for (let index = 0; index < 6; index += 1) {
      const response = await fetch(baseUrl + "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@example.com", password: "SenhaIndividual#2026" })
      });
      assert.equal(response.status, 200, `login válido ${index + 1}`);
      assert.match(response.headers.get("set-cookie") || "", /HttpOnly/);
      const body = await response.json();
      assert.equal(body.user.permissions.isAdmin, true);
    }
  } finally {
    pool.query = originalQuery;
  }
});

test("sessão assinada válida é aceita", async () => {
  const token = signSession({ id: "1", email: "admin@example.com", perfil: "admin" });
  const response = await fetch(baseUrl + "/api/auth/session", {
    headers: { cookie: `tgt_session=${token}` }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.session.email, "admin@example.com");
});

test("sessão adulterada é rejeitada", async () => {
  const token = signSession({ id: "1", email: "admin@example.com", perfil: "admin" });
  const response = await fetch(baseUrl + "/api/auth/session", {
    headers: { cookie: `tgt_session=${token}x` }
  });
  assert.equal(response.status, 401);
});

test("usuário comum não acessa administração ou financeiro", async () => {
  const token = signSession({
    id: "2",
    email: "vendedor@example.com",
    perfil: "vendedor",
    loja: "Loja A"
  });
  const headers = { cookie: `tgt_session=${token}` };

  const users = await fetch(baseUrl + "/api/usuarios", { headers });
  assert.equal(users.status, 403);

  const finance = await fetch(baseUrl + "/api/faturamentos", { headers });
  assert.equal(finance.status, 403);
});

test("proxy GAS aplica whitelist por perfil", async () => {
  const token = signSession({
    id: "2",
    email: "vendedor@example.com",
    perfil: "vendedor",
    loja: "Loja A"
  });
  const response = await fetch(baseUrl + "/api/gas", {
    method: "POST",
    headers: {
      cookie: `tgt_session=${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ fn: "atualizarPlanilhaSistemaCompleto", args: [] })
  });
  assert.equal(response.status, 403);
});

test("respostas incluem cabeçalhos básicos de segurança", async () => {
  const response = await fetch(baseUrl + "/");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-powered-by"), null);
});
