const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");

process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.SESSION_TTL_HOURS = "1";
process.env.SALESBOT_SECRET = "test-salesbot-secret";
process.env.KOMMO_WEBHOOK_SECRET = "test-webhook-secret";
process.env.KOMMO_USE_SALESBOT = "true";
process.env.BOT_ENABLED = "true";
process.env.ADANALYZER_SYNC_KEY = "test-adanalyzer-sync-key";

const { app, pool, signSession } = require("../server");
const mailingboss = require("../mailingboss");

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

test("health do Salesbot e Kommo ficam disponiveis sem sessao", async () => {
  const salesbot = await fetch(baseUrl + "/api/salesbot/health");
  assert.equal(salesbot.status, 200);
  const salesbotBody = await salesbot.json();
  assert.equal(salesbotBody.ok, true);
  assert.equal(salesbotBody.secret_configured, true);

  const kommo = await fetch(baseUrl + "/kommo/health");
  assert.equal(kommo.status, 200);
  const kommoBody = await kommo.json();
  assert.equal(kommoBody.ok, true);
  assert.equal(kommoBody.salesbot_mode, true);
  assert.equal(kommoBody.webhook_secret_configured, true);
});

test("Salesbot bloqueia chamada sem segredo proprio", async () => {
  const response = await fetch(baseUrl + "/api/salesbot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lead_id: "123", message: "oi" })
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.text, "");
});

test("webhook Kommo bloqueia chamada sem segredo proprio", async () => {
  const response = await fetch(baseUrl + "/webhook/kommo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leads: { add: [{ id: 123 }] } })
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

  // vendedor NÃO acessa lixeira (requireAdmin)
  const lixeira = await fetch(baseUrl + "/api/lixeira", { headers });
  assert.equal(lixeira.status, 403);

  // vendedor NÃO acessa financeiro
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

test("marketing performance requires a key and returns aggregates only", async () => {
  const denied = await fetch(baseUrl + "/api/internal/marketing-performance?start=2026-07-01&end=2026-07-31");
  assert.equal(denied.status, 401);
  const originalQuery = pool.query;
  pool.query = async (sql, params) => {
    assert.match(String(sql), /FROM agendamentos/);
    assert.deepEqual(params, ["2026-07-01", "2026-07-31"]);
    return { rows: [{ loja: "Loja A", agendamentos: 10, comparecimentos: 7, vendas: 3, faturamento: "4500.50", descontos: "120.00" }] };
  };
  try {
    const response = await fetch(baseUrl + "/api/internal/marketing-performance?start=2026-07-01&end=2026-07-31", {
      headers: { "x-api-key": "test-adanalyzer-sync-key" }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.fonte, "postgresql");
    assert.equal(body.lojas[0].faturamento, 4500.5);
    assert.equal(body.totais.agendamentos, 10);
    assert.equal(body.lojas[0].nome, undefined);
  } finally {
    pool.query = originalQuery;
  }
});

test("respostas incluem cabeçalhos básicos de segurança", async () => {
  const response = await fetch(baseUrl + "/");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-powered-by"), null);
});

test("index.html nunca fica em cache no navegador (todo o painel vive nesse arquivo, sem hash de build)", async () => {
  const response = await fetch(baseUrl + "/");
  assert.match(response.headers.get("cache-control") || "", /no-store/, "GET / precisa impedir cache para refletir deploys imediatamente");
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

test("interface usa a permissão financeira assinada pelo servidor", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /window\.tgtPodeVerFinanceiro = function\(\)/);
  assert.match(html, /return p\.canViewFinance === true/);
  assert.doesNotMatch(html, /if \(r === 'admin' \|\| r === 'gerente de loja'\) return true/);
});

test("painel atualiza imediatamente e ignora respostas antigas após edição", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /cache:\s*'no-store'/);
  assert.match(html, /aplicarRespostaAgendamentoAtualizado\(data\)/);
  assert.match(html, /requestSeq !== window\._agendaRequestSeq/);
  assert.match(html, /recarregarComFiltros\(true\)/);
  assert.doesNotMatch(html, /agendarAtualizacaoAposAcao\(1500\)/);
});

test("criação de agendamento grava backup com perfil na mesma transação", async () => {
  const originalConnect = pool.connect;
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("INSERT INTO agendamentos")) {
        return { rows: [{ id: 99, nome: "Cliente Real", loja: "Loja A", status: "Agendado" }] };
      }
      return { rows: [] };
    },
    release: () => {}
  };
  pool.connect = async () => client;
  const token = signSession({ id: "1", nome: "Admin", email: "admin@example.com", perfil: "admin", loja: "Todas" });
  try {
    const response = await fetch(baseUrl + "/api/agendamentos", {
      method: "POST",
      headers: { cookie: `tgt_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ nome: "Cliente Real", loja: "Loja A", data_agendamento: "2026-06-20", horario: "10:00" })
    });
    assert.equal(response.status, 200);
    assert.equal(queries[0].sql, "BEGIN");
    assert.ok(queries.some((q) => q.sql.includes("app.audit_managed")));
    const backup = queries.find((q) => q.sql.includes("INSERT INTO historico_alteracoes_agendamentos"));
    assert.ok(backup);
    assert.equal(backup.params[7], "admin");
    assert.equal(queries.at(-1).sql, "COMMIT");
  } finally {
    pool.connect = originalConnect;
  }
});

test("criação de agendamento pelo painel dispara sincronização com o Mailingboss (Builderall)", async () => {
  const originalConnect = pool.connect;
  const originalSincronizar = mailingboss.sincronizarLead;
  const client = {
    query: async (sql) => {
      if (String(sql).includes("INSERT INTO agendamentos")) {
        return { rows: [{ id: 101, nome: "Cliente Mailingboss", email: "cliente@example.com", loja: "Loja A", status: "Agendado" }] };
      }
      return { rows: [] };
    },
    release: () => {}
  };
  pool.connect = async () => client;
  const token = signSession({ id: "1", nome: "Admin", email: "admin@example.com", perfil: "admin", loja: "Todas" });
  // Drena qualquer setImmediate pendente de um teste anterior (ex: a criação
  // do teste "grava backup" acima, que não aguarda a sincronização em
  // background) antes de instalar o mock -- senão essa chamada tardia acaba
  // batendo no mock deste teste, inflando a contagem.
  await new Promise((resolve) => setImmediate(resolve));
  const chamadas = [];
  mailingboss.sincronizarLead = async (ag, origem) => { chamadas.push({ ag, origem }); };
  try {
    const response = await fetch(baseUrl + "/api/agendamentos", {
      method: "POST",
      headers: { cookie: `tgt_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ nome: "Cliente Mailingboss", email: "cliente@example.com", loja: "Loja A", data_agendamento: "2026-06-20", horario: "10:00" })
    });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(chamadas.length, 1, "criar um agendamento pelo painel deve disparar a sincronização com o Mailingboss");
    assert.equal(chamadas[0].ag.id, 101);
    assert.equal(chamadas[0].origem, "painel");
  } finally {
    pool.connect = originalConnect;
    mailingboss.sincronizarLead = originalSincronizar;
  }
});

test("alteração guarda versões anterior e nova com o perfil responsável", async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const queries = [];
  pool.query = async () => ({ rows: [{ id: 77, nome: "Cliente", loja: "Loja A", status: "Agendado" }] });
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).includes("UPDATE agendamentos SET")) {
        return { rows: [{ id: 77, nome: "Cliente", loja: "Loja A", status: "Confirmado" }] };
      }
      return { rows: [] };
    },
    release: () => {}
  });
  const token = signSession({ id: "9", nome: "Gerente", email: "gerente@example.com", perfil: "gerente de loja", loja: "Loja A" });
  try {
    const response = await fetch(baseUrl + "/api/agendamentos/77", {
      method: "PATCH",
      headers: { cookie: `tgt_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "Confirmado" })
    });
    assert.equal(response.status, 200);
    const backup = queries.find((q) => q.sql.includes("INSERT INTO historico_alteracoes_agendamentos"));
    assert.ok(backup);
    assert.equal(backup.params[7], "gerente de loja");
    assert.equal(JSON.parse(backup.params[9]).status, "Agendado");
    assert.equal(JSON.parse(backup.params[10]).status, "Confirmado");
    assert.equal(queries.at(-1).sql, "COMMIT");
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test("gerente consulta backups somente da própria loja", async () => {
  const originalQuery = pool.query;
  let capturedSql = "";
  let capturedParams = [];
  pool.query = async (sql, params) => {
    capturedSql = String(sql);
    capturedParams = params;
    return { rows: [{ id: 1, agendamento_id: 77, loja: "Loja A", acao: "ALTERACAO" }] };
  };
  const token = signSession({ id: "9", nome: "Gerente", email: "gerente@example.com", perfil: "gerente de loja", loja: "Loja A" });
  try {
    const response = await fetch(baseUrl + "/api/historico-agendamentos", { headers: { cookie: `tgt_session=${token}` } });
    assert.equal(response.status, 200);
    assert.match(capturedSql, /TRANSLATE\(LOWER/);
    assert.equal(capturedParams[0], "Loja A");
  } finally {
    pool.query = originalQuery;
  }
});

test("vendedor não acessa backups operacionais", async () => {
  const token = signSession({ id: "10", email: "vendedor@example.com", perfil: "vendedor", loja: "Loja A" });
  const response = await fetch(baseUrl + "/api/historico-agendamentos", { headers: { cookie: `tgt_session=${token}` } });
  assert.equal(response.status, 403);
});

test("exclusão permanente grava no histórico quem apagou (era a única ação sem rastro)", async () => {
  // Bug real: DELETE /api/agendamentos/:id (exclusão definitiva) apagava a
  // linha direto, sem nenhuma chamada a saveAppointmentBackup -- era a única
  // ação do sistema sem histórico, então não dava pra saber quem excluiu um
  // registro permanentemente.
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const queries = [];
  pool.query = async () => ({
    rows: [{ id: 88, nome: "Cliente Excluído", loja: "Loja A", excluido_em: "2026-07-20T10:00:00.000Z" }]
  });
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      return { rows: [] };
    },
    release: () => {}
  });
  const token = signSession({ id: "1", nome: "Admin", email: "admin@example.com", perfil: "admin" });
  try {
    const response = await fetch(baseUrl + "/api/agendamentos/88", {
      method: "DELETE", headers: { cookie: `tgt_session=${token}` }
    });
    assert.equal(response.status, 200);
    const backup = queries.find((q) => q.sql.includes("INSERT INTO historico_alteracoes_agendamentos"));
    assert.ok(backup, "a exclusão permanente precisa gravar no histórico antes de apagar");
    assert.match(queries.find((q) => q.sql.includes("DELETE FROM agendamentos")).sql, /DELETE FROM agendamentos/);
    const indiceBackup = queries.indexOf(backup);
    const indiceDelete = queries.findIndex((q) => q.sql.includes("DELETE FROM agendamentos"));
    assert.ok(indiceBackup < indiceDelete, "o registro no histórico precisa acontecer antes do DELETE de verdade");
    assert.equal(backup.params[3], "EXCLUSAO_PERMANENTE");
    assert.equal(backup.params[6], "admin@example.com");
    assert.equal(JSON.parse(backup.params[9]).nome, "Cliente Excluído");
    assert.equal(queries.at(-1).sql, "COMMIT");
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});

test("toda ação de escrita fica registrada no log de auditoria (quem, o quê, quando, resultado)", async () => {
  const originalLog = console.log;
  const linhas = [];
  console.log = (...args) => { linhas.push(args); };
  const token = signSession({ id: "20", nome: "Vendedor Teste", email: "vendedor.audit@example.com", perfil: "vendedor", loja: "Loja A" });
  try {
    const response = await fetch(baseUrl + "/api/usuarios", {
      method: "POST",
      headers: { cookie: `tgt_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ nome: "X", email: "x@x.com", cargo: "vendedor" })
    });
    assert.equal(response.status, 403, "vendedor não pode criar usuário -- a ação em si continua bloqueada normalmente");
    const linhaAudit = linhas.find((l) => l[0] === "[AUDIT]");
    assert.ok(linhaAudit, "toda escrita (mesmo bloqueada) precisa aparecer no log de auditoria");
    const registro = JSON.parse(linhaAudit[1]);
    assert.equal(registro.metodo, "POST");
    assert.equal(registro.rota, "/api/usuarios");
    assert.equal(registro.status, 403);
    assert.equal(registro.email, "vendedor.audit@example.com");
    assert.equal(registro.perfil, "vendedor");
    assert.equal(registro.loja, "Loja A");
    assert.ok(registro.em, "precisa ter timestamp");
  } finally {
    console.log = originalLog;
  }
});

test("leitura (GET) não é registrada no log de auditoria (só ações de escrita)", async () => {
  const originalLog = console.log;
  const linhas = [];
  console.log = (...args) => { linhas.push(args); };
  const token = signSession({ id: "21", nome: "Vendedor Teste", email: "vendedor.audit2@example.com", perfil: "vendedor", loja: "Loja A" });
  const originalQuery = pool.query;
  pool.query = async () => ({ rows: [] });
  try {
    await fetch(baseUrl + "/api/agendamentos", { headers: { cookie: `tgt_session=${token}` } });
    const linhaAudit = linhas.find((l) => l[0] === "[AUDIT]");
    assert.ok(!linhaAudit, "GET não deve gerar linha de auditoria -- só ações de escrita");
  } finally {
    console.log = originalLog;
    pool.query = originalQuery;
  }
});
