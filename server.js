const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const publicPath = path.join(__dirname, "public");

if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath));
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const GAS_URL =
  process.env.GAS_URL ||
  process.env.GAS_WEBAPP_URL ||
  process.env.URL_GAS ||
  process.env.URL_DE_IMPLANTACAO_DE_GAS ||
  process.env.URL_DE_IMPLANTACAO_GAS ||
  "";

const GAS_API_KEY =
  process.env.GAS_API_KEY ||
  process.env.API_KEY ||
  process.env.KOMMO_WEBHOOK_SECRET ||
  "";

async function addColumnIfMissing(table, column, definition) {
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agendamentos (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      whatsapp TEXT,
      email TEXT,
      loja TEXT,
      optometrista TEXT,
      origem TEXT,
      data_agendamento DATE,
      horario TEXT,
      observacao TEXT,
      status TEXT DEFAULT 'Agendado',
      compareceu TEXT DEFAULT 'Pendente',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await addColumnIfMissing("agendamentos", "responsavel", "TEXT");
  await addColumnIfMissing("agendamentos", "atendimento_realizado", "TEXT");
  await addColumnIfMissing("agendamentos", "venda_gerada", "TEXT");
  await addColumnIfMissing("agendamentos", "valor_venda", "NUMERIC(12,2) DEFAULT 0");
  await addColumnIfMissing("agendamentos", "desconto", "NUMERIC(12,2) DEFAULT 0");
  await addColumnIfMissing("agendamentos", "motivo_perda", "TEXT");
  await addColumnIfMissing("agendamentos", "consultor_responsavel", "TEXT");
  await addColumnIfMissing("agendamentos", "criado_por_email", "TEXT");
  await addColumnIfMissing("agendamentos", "proprietario_id", "TEXT");
  await addColumnIfMissing("agendamentos", "proprietario_nome", "TEXT");
  await addColumnIfMissing("agendamentos", "numero_os", "TEXT");
  await addColumnIfMissing("agendamentos", "data_abertura_os", "DATE");
  await addColumnIfMissing("agendamentos", "data_entrada_os", "DATE");
  await addColumnIfMissing("agendamentos", "data_finalizacao_os", "DATE");
  await addColumnIfMissing("agendamentos", "data_entrega_os", "DATE");
  await addColumnIfMissing("agendamentos", "status_os", "TEXT");
  await addColumnIfMissing("agendamentos", "access_tags", "TEXT");
  await addColumnIfMissing("agendamentos", "lead_time_dias", "INTEGER");
  await addColumnIfMissing("agendamentos", "vendedor_nome", "TEXT");
  await addColumnIfMissing("agendamentos", "kommo_lead_id", "TEXT");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      whatsapp TEXT,
      email TEXT,
      cpf TEXT,
      data_nascimento DATE,
      origem TEXT,
      loja_origem TEXT,
      observacoes TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS faturamentos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
      agendamento_id INTEGER REFERENCES agendamentos(id) ON DELETE SET NULL,
      loja TEXT,
      vendedor TEXT,
      valor_total NUMERIC(12,2) DEFAULT 0,
      forma_pagamento TEXT,
      status_pagamento TEXT DEFAULT 'Pendente',
      data_venda DATE,
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT,
      cargo TEXT,
      loja TEXT,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lojas (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      endereco TEXT,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS optometristas (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      loja TEXT,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS origens (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feriados (
      id SERIAL PRIMARY KEY,
      data DATE NOT NULL,
      descricao TEXT,
      ativo BOOLEAN DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS historico_usuarios (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      usuario_nome TEXT,
      acao TEXT NOT NULL,
      modulo TEXT,
      descricao TEXT,
      ip TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS historico_agendamentos (
      id SERIAL PRIMARY KEY,
      agendamento_id INTEGER REFERENCES agendamentos(id) ON DELETE CASCADE,
      usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      usuario_nome TEXT,
      acao TEXT NOT NULL,
      status_anterior TEXT,
      status_novo TEXT,
      observacao TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs_sistema (
      id SERIAL PRIMARY KEY,
      tipo TEXT,
      origem TEXT,
      mensagem TEXT,
      detalhes JSONB,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(data_agendamento);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientes_whatsapp ON clientes(whatsapp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturamentos_data ON faturamentos(data_venda);`);
}

function buildGasPayload(body) {
  body = body || {};

  const fn = String(body.fn || body.action || body.acao || "").trim();
  const args = Array.isArray(body.args) ? body.args : [];

  const payload = { ...body };

  if (!fn) {
    if (GAS_API_KEY && !payload.apiKey && !payload.token && !payload.secret) {
      payload.apiKey = GAS_API_KEY;
    }
    return payload;
  }

  payload.action = fn;

  switch (fn) {
    case "loginSeguro":
    case "login":
      payload.action = "login";
      payload.email = args[0] || body.email || body.userEmail || body.loginEmail || "";
      break;

    case "getInfoInicial":
      payload.action = "getInfoInicial";
      payload.email = args[0] || body.email || "";
      break;

    case "getBootstrapSistema":
      payload.action = "getBootstrapSistema";
      payload.user = args[0] || body.user || {};
      payload.filtros = args[1] || body.filtros || {};
      break;

    case "getAgendamentos":
      payload.action = "getAgendamentos";
      payload.user = args[0] || body.user || {};
      payload.filtros = args[1] || body.filtros || {};
      break;

    case "getDashboard":
      payload.action = "getDashboard";
      payload.user = args[0] || body.user || {};
      break;

    case "getFinancePanel":
      payload.action = "getFinancePanel";
      payload.user = args[0] || body.user || {};
      payload.filtros = args[1] || body.filtros || {};
      break;

    case "getLeadTimeReport":
      payload.action = "getLeadTimeReport";
      payload.user = args[0] || body.user || {};
      payload.filtros = args[1] || body.filtros || {};
      break;

    case "gerarRelatorioCSV":
    case "exportFinanceCSV":
      payload.action = fn;
      payload.filtros = args[0] || body.filtros || {};
      payload.user = args[1] || body.user || {};
      break;

    case "getOptometristasPorLoja":
      payload.action = "getOptometristasPorLoja";
      payload.loja = args[0] || body.loja || "";
      break;

    case "salvarAgendamento":
      payload.action = "salvarAgendamento";
      payload.payload = args[0] || body.payload || {};
      payload.user = args[1] || body.user || {};
      break;

    case "updateRow":
    case "salvarOS":
      payload.action = fn;
      payload.payload = args[0] || body.payload || {};
      payload.user = args[1] || body.user || {};
      break;

    case "confirmarAgendamento":
    case "marcarCompareceu":
    case "marcarNaoCompareceu":
    case "cancelarAgendamento":
    case "excluirAgendamento":
      payload.action = fn;
      payload.id = args[0] || body.id || body.agendamentoId || "";
      payload.user = args[1] || body.user || {};
      break;

    case "marcarCompraStatus":
      payload.action = "marcarCompraStatus";
      payload.id = args[0] || body.id || body.agendamentoId || "";
      payload.comprou = args[1];
      payload.user = args[2] || body.user || {};
      break;

    default:
      payload.action = fn;
      if (args[0] !== undefined && payload.payload === undefined) payload.payload = args[0];
      if (args[1] !== undefined && payload.user === undefined) payload.user = args[1];
      break;
  }

  if (GAS_API_KEY && !payload.apiKey && !payload.token && !payload.secret) {
    payload.apiKey = GAS_API_KEY;
  }

  delete payload.fn;
  delete payload.args;

  return payload;
}

app.get("/health", async (req, res) => {
  try {
    const db = await pool.query("SELECT NOW() as agora");

    res.json({
      ok: true,
      service: "Agendamento System",
      database: true,
      databaseTime: db.rows[0].agora,
      gasConfigured: !!GAS_URL,
      routes: {
        gas: true,
        agendamentos: true,
        clientes: true,
        faturamentos: true,
        dashboard: true
      },
      ts: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      database: false,
      error: error.message
    });
  }
});

app.post("/api/gas", async (req, res) => {
  try {
    if (!GAS_URL) {
      return res.status(500).json({
        ok: false,
        message: "URL do GAS não configurada no Railway. Crie a variável GAS_URL com a URL /exec do Google Apps Script."
      });
    }

    const payload = buildGasPayload(req.body);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const response = await fetch(GAS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch (error) {
      data = {
        ok: false,
        message: "Resposta do GAS não veio em JSON.",
        raw: text.slice(0, 1200)
      };
    }

    return res.status(response.status).json(data);
  } catch (error) {
    console.error("Erro no proxy /api/gas:", error);

    return res.status(502).json({
      ok: false,
      message: "Falha ao comunicar com o Google Apps Script.",
      error: error.message
    });
  }
});

app.post("/api/agendamentos", async (req, res) => {
  try {
    const b = req.body || {};

    const result = await pool.query(
      `
      INSERT INTO agendamentos (
        nome,
        whatsapp,
        email,
        loja,
        optometrista,
        origem,
        data_agendamento,
        horario,
        observacao,
        status,
        compareceu,
        responsavel,
        criado_por_email,
        proprietario_id,
        proprietario_nome,
        access_tags
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
      `,
      [
        b.nome || b.nomeCompleto,
        b.whatsapp || b.whatsApp || null,
        b.email || null,
        b.loja || null,
        b.optometrista || null,
        b.origem || null,
        b.data_agendamento || b.dataAgendamento || b.data || null,
        b.horario || null,
        b.observacao || null,
        b.status || b.statusAgenda || "Agendado",
        b.compareceu || "Pendente",
        b.responsavel || b.responsavelTela || null,
        b.criado_por_email || b.userEmail || null,
        b.proprietario_id || b.proprietarioId || null,
        b.proprietario_nome || b.proprietarioNome || null,
        b.access_tags || b.accessTags || null
      ]
    );

    res.json({
      ok: true,
      message: "Agendamento salvo no PostgreSQL.",
      agendamento: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao salvar agendamento.",
      error: error.message
    });
  }
});

app.get("/api/agendamentos", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM agendamentos
      ORDER BY id DESC
      LIMIT 500
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      agendamentos: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.patch("/api/agendamentos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};

    const result = await pool.query(
      `
      UPDATE agendamentos
      SET
        origem = COALESCE($1, origem),
        nome = COALESCE($2, nome),
        whatsapp = COALESCE($3, whatsapp),
        email = COALESCE($4, email),
        loja = COALESCE($5, loja),
        optometrista = COALESCE($6, optometrista),
        data_agendamento = COALESCE($7, data_agendamento),
        horario = COALESCE($8, horario),
        observacao = COALESCE($9, observacao),
        status = COALESCE($10, status),
        compareceu = COALESCE($11, compareceu),
        numero_os = COALESCE($12, numero_os),
        status_os = COALESCE($13, status_os),
        vendedor_nome = COALESCE($14, vendedor_nome),
        valor_venda = COALESCE($15, valor_venda),
        desconto = COALESCE($16, desconto),
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = $17
      RETURNING *
      `,
      [
        b.origem || null,
        b.nome || b.nomeCompleto || null,
        b.whatsapp || b.whatsApp || null,
        b.email || null,
        b.loja || null,
        b.optometrista || null,
        b.data_agendamento || b.dataAgendamento || null,
        b.horario || null,
        b.observacao || null,
        b.status || b.statusAgenda || null,
        b.compareceu || null,
        b.numero_os || b.numeroOS || null,
        b.status_os || b.statusOS || null,
        b.vendedor_nome || b.vendedorNome || null,
        b.valor_venda || b.valorVenda || null,
        b.desconto || null,
        id
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        message: "Agendamento não encontrado."
      });
    }

    res.json({
      ok: true,
      agendamento: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/clientes", async (req, res) => {
  try {
    const b = req.body || {};

    if (!b.nome) {
      return res.status(400).json({
        ok: false,
        message: "Nome do cliente é obrigatório."
      });
    }

    const result = await pool.query(
      `
      INSERT INTO clientes (
        nome,
        whatsapp,
        email,
        cpf,
        data_nascimento,
        origem,
        loja_origem,
        observacoes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        b.nome,
        b.whatsapp || null,
        b.email || null,
        b.cpf || null,
        b.data_nascimento || null,
        b.origem || null,
        b.loja_origem || null,
        b.observacoes || null
      ]
    );

    res.json({
      ok: true,
      message: "Cliente salvo no banco.",
      cliente: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao salvar cliente.",
      error: error.message
    });
  }
});

app.get("/api/clientes", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM clientes
      ORDER BY id DESC
      LIMIT 500
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      clientes: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/faturamentos", async (req, res) => {
  try {
    const b = req.body || {};

    const result = await pool.query(
      `
      INSERT INTO faturamentos (
        cliente_id,
        agendamento_id,
        loja,
        vendedor,
        valor_total,
        forma_pagamento,
        status_pagamento,
        data_venda,
        observacao
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        b.cliente_id || null,
        b.agendamento_id || null,
        b.loja || null,
        b.vendedor || null,
        b.valor_total || 0,
        b.forma_pagamento || null,
        b.status_pagamento || "Pendente",
        b.data_venda || null,
        b.observacao || null
      ]
    );

    res.json({
      ok: true,
      message: "Faturamento salvo no banco.",
      faturamento: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao salvar faturamento.",
      error: error.message
    });
  }
});

app.get("/api/faturamentos", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM faturamentos
      ORDER BY id DESC
      LIMIT 500
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      faturamentos: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/historico/usuarios", async (req, res) => {
  try {
    const b = req.body || {};
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

    const result = await pool.query(
      `
      INSERT INTO historico_usuarios (
        usuario_id,
        usuario_nome,
        acao,
        modulo,
        descricao,
        ip
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        b.usuario_id || null,
        b.usuario_nome || null,
        b.acao || "acao",
        b.modulo || null,
        b.descricao || null,
        ip
      ]
    );

    res.json({
      ok: true,
      historico: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/logs", async (req, res) => {
  try {
    const b = req.body || {};

    const result = await pool.query(
      `
      INSERT INTO logs_sistema (
        tipo,
        origem,
        mensagem,
        detalhes
      )
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        b.tipo || "info",
        b.origem || null,
        b.mensagem || null,
        b.detalhes ? JSON.stringify(b.detalhes) : null
      ]
    );

    res.json({
      ok: true,
      log: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const clientes = await pool.query(`SELECT COUNT(*)::int AS total FROM clientes`);
    const agendamentos = await pool.query(`SELECT COUNT(*)::int AS total FROM agendamentos`);

    const faturamentos = await pool.query(`
      SELECT
        COUNT(*)::int AS total_vendas,
        COALESCE(SUM(valor_total), 0)::numeric AS faturamento_total
      FROM faturamentos
    `);

    res.json({
      ok: true,
      dashboard: {
        total_clientes: clientes.rows[0].total,
        total_agendamentos: agendamentos.rows[0].total,
        total_vendas: faturamentos.rows[0].total_vendas,
        faturamento_total: faturamentos.rows[0].faturamento_total
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao carregar dashboard.",
      error: error.message
    });
  }
});

app.get("/", (req, res) => {
  const indexPath = path.join(publicPath, "index.html");

  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }

  res.json({
    ok: true,
    service: "Agendamento System",
    message: "Servidor rodando com PostgreSQL + GAS proxy.",
    routes: [
      "GET /health",
      "POST /api/gas",
      "GET /api/agendamentos",
      "POST /api/agendamentos",
      "PATCH /api/agendamentos/:id",
      "GET /api/clientes",
      "POST /api/clientes",
      "GET /api/faturamentos",
      "POST /api/faturamentos",
      "GET /api/dashboard"
    ]
  });
});

initDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Sistema rodando na porta ${PORT}`);
      console.log("PostgreSQL conectado e tabelas verificadas.");
      console.log("GAS configurado:", !!GAS_URL);
    });
  })
  .catch((error) => {
    console.error("Erro ao iniciar banco:", error);
    process.exit(1);
  });
