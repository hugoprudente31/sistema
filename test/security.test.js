const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");

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

test("agenda de loja usa comparacao sem diferenca de acento", async () => {
  const originalQuery = pool.query;
  let capturedSql = "";
  let capturedParams = [];
  pool.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [{ id: 10, loja: "Óticas TGT Enseada" }] };
  };
  const token = signSession({ id: "3", email: "opto@example.com", perfil: "optometrista", loja: "oticas TGT Enseada" });
  try {
    const response = await fetch(baseUrl + "/api/agendamentos", { headers: { cookie: `tgt_session=${token}` } });
    assert.equal(response.status, 200);
    assert.match(capturedSql, /TRANSLATE\(LOWER/);
    assert.deepEqual(capturedParams, ["oticas TGT Enseada"]);
    assert.equal((await response.json()).total, 1);
  } finally {
    pool.query = originalQuery;
  }
});

test("financeiro autorizado deriva valores e descontos dos agendamentos", async () => {
  const originalQuery = pool.query;
  let capturedSql = "";
  pool.query = async (sql) => {
    capturedSql = sql;
    return { rows: [{ id: 20, cliente_nome: "Cliente", valor_total: "300.00", desconto: "25.00" }] };
  };
  const token = signSession({ id: "4", email: "gerente@example.com", perfil: "gerente de loja", loja: "Óticas TGT Enseada" });
  try {
    const response = await fetch(baseUrl + "/api/faturamentos", { headers: { cookie: `tgt_session=${token}` } });
    assert.equal(response.status, 200);
    assert.match(capturedSql, /FROM agendamentos/);
    assert.doesNotMatch(capturedSql, /FROM faturamentos/);
    const body = await response.json();
    assert.equal(body.faturamentos[0].desconto, "25.00");
  } finally {
    pool.query = originalQuery;
  }
});

test("comprador acessa apenas o financeiro da própria loja", async () => {
  const originalQuery = pool.query;
  let capturedSql = "";
  let capturedParams = [];
  pool.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [{ id: 30, valor_total: "150.00", desconto: "10.00", loja: "Óticas TGT Gonzaga" }] };
  };
  const token = signSession({ id: "5", email: "comprador@example.com", perfil: "comprador", loja: "Óticas TGT Gonzaga" });
  try {
    const response = await fetch(baseUrl + "/api/faturamentos", { headers: { cookie: `tgt_session=${token}` } });
    assert.equal(response.status, 200);
    assert.match(capturedSql, /TRANSLATE\(LOWER/);
    assert.deepEqual(capturedParams, ["Óticas TGT Gonzaga"]);
  } finally {
    pool.query = originalQuery;
  }
});

test("painel contem farol, quatro datas da OS e valores visiveis", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /AtendimentoSemaforo: semaforo/);
  assert.match(html, /Compareceu e comprou/);
  assert.match(html, /Abertura:.*DataAberturaOS/);
  assert.match(html, /money\(r\.ValorVenda \|\| 0\)/);
  assert.doesNotMatch(html, /canFinance\(\) \? money\(r\.ValorVenda/);
  assert.doesNotMatch(html, /if \(isOpto\(\) && !date30\(r\)\)/);
});

test("financeiro geral agrupa vendas e subtotais por loja", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /permissions\.canViewAll/);
  assert.match(html, /storeRows\.length/);
  assert.match(html, /venda\(s\)/);
  assert.match(html, /Total: ' \+ money\(storeTotal\)/);
  assert.match(html, /Descontos: ' \+ money\(storeDiscount\)/);
});
