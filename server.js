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
      senha TEXT NOT NULL,
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
}

app.get("/health", async (req, res) => {
  try {
    const db = await pool.query("SELECT NOW() as agora");

    res.json({
      ok: true,
      service: "Agendamento System",
      database: true,
      databaseTime: db.rows[0].agora,
      routes: {
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

app.get("/health", async (req, res) => {
  try {
    const db = await pool.query("SELECT NOW() as agora");

    res.json({
      ok: true,
      service: "Agendamento System",
      database: true,
      databaseTime: db.rows[0].agora,
      routes: {
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

// ===============================
// PROXY GAS - LOGIN E DADOS BASE
// ===============================

const GAS_URL =
  process.env.GAS_URL ||
  process.env.GAS_WEBAPP_URL ||
  process.env.URL_GAS ||
  process.env.URL_DE_IMPLANTACAO_DE_GAS ||
  process.env.URL_DE_IMPLANTACAO_GAS;

app.post("/api/gas", async (req, res) => {
  try {
    if (!GAS_URL) {
      return res.status(500).json({
        ok: false,
        message: "URL do GAS não configurada no Railway."
      });
    }

    const response = await fetch(GAS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(req.body)
    });

    const text = await response.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = {
        ok: false,
        message: "Resposta do GAS não veio em JSON.",
        raw: text
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
app.post("/api/agendamentos", async (req, res) => {
  try {
    const {
      nome,
      whatsapp,
      email,
      loja,
      optometrista,
      origem,
      data_agendamento,
      data,
      horario,
      observacao,
      status
    } = req.body;

    if (!nome) {
      return res.status(400).json({
        ok: false,
        message: "Nome é obrigatório."
      });
    }

    const result = await pool.query(
      `
      INSERT INTO agendamentos (
        nome, whatsapp, email, loja, optometrista, origem,
        data_agendamento, horario, observacao, status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING *
      `,
      [
        nome,
        whatsapp || null,
        email || null,
        loja || null,
        optometrista || null,
        origem || null,
        data_agendamento || data || null,
        horario || null,
        observacao || null,
        status || "Agendado"
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
      LIMIT 300
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

app.post("/api/clientes", async (req, res) => {
  try {
    const {
      nome,
      whatsapp,
      email,
      cpf,
      data_nascimento,
      origem,
      loja_origem,
      observacoes
    } = req.body;

    if (!nome) {
      return res.status(400).json({
        ok: false,
        message: "Nome do cliente é obrigatório."
      });
    }

    const result = await pool.query(
      `
      INSERT INTO clientes (
        nome, whatsapp, email, cpf, data_nascimento,
        origem, loja_origem, observacoes
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
      `,
      [
        nome,
        whatsapp || null,
        email || null,
        cpf || null,
        data_nascimento || null,
        origem || null,
        loja_origem || null,
        observacoes || null
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
      LIMIT 300
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
    const {
      cliente_id,
      agendamento_id,
      loja,
      vendedor,
      valor_total,
      forma_pagamento,
      status_pagamento,
      data_venda,
      observacao
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO faturamentos (
        cliente_id, agendamento_id, loja, vendedor,
        valor_total, forma_pagamento, status_pagamento,
        data_venda, observacao
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
      `,
      [
        cliente_id || null,
        agendamento_id || null,
        loja || null,
        vendedor || null,
        valor_total || 0,
        forma_pagamento || null,
        status_pagamento || "Pendente",
        data_venda || null,
        observacao || null
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
      LIMIT 300
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
    const { usuario_id, usuario_nome, acao, modulo, descricao } = req.body;
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

    if (!acao) {
      return res.status(400).json({
        ok: false,
        message: "Ação é obrigatória."
      });
    }

    const result = await pool.query(
      `
      INSERT INTO historico_usuarios (
        usuario_id, usuario_nome, acao, modulo, descricao, ip
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
      `,
      [
        usuario_id || null,
        usuario_nome || null,
        acao,
        modulo || null,
        descricao || null,
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

app.get("/api/historico/usuarios", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM historico_usuarios
      ORDER BY id DESC
      LIMIT 300
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      historico: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/historico/agendamentos", async (req, res) => {
  try {
    const {
      agendamento_id,
      usuario_id,
      usuario_nome,
      acao,
      status_anterior,
      status_novo,
      observacao
    } = req.body;

    if (!acao) {
      return res.status(400).json({
        ok: false,
        message: "Ação é obrigatória."
      });
    }

    const result = await pool.query(
      `
      INSERT INTO historico_agendamentos (
        agendamento_id, usuario_id, usuario_nome, acao,
        status_anterior, status_novo, observacao
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
      `,
      [
        agendamento_id || null,
        usuario_id || null,
        usuario_nome || null,
        acao,
        status_anterior || null,
        status_novo || null,
        observacao || null
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

app.get("/api/historico/agendamentos", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM historico_agendamentos
      ORDER BY id DESC
      LIMIT 300
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      historico: result.rows
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
    const { tipo, origem, mensagem, detalhes } = req.body;

    const result = await pool.query(
      `
      INSERT INTO logs_sistema (
        tipo, origem, mensagem, detalhes
      )
      VALUES ($1,$2,$3,$4)
      RETURNING *
      `,
      [
        tipo || "info",
        origem || null,
        mensagem || null,
        detalhes ? JSON.stringify(detalhes) : null
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

app.get("/api/logs", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT *
      FROM logs_sistema
      ORDER BY id DESC
      LIMIT 300
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      logs: result.rows
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
    message: "Servidor rodando com PostgreSQL.",
    routes: [
      "GET /health",
      "GET /api/agendamentos",
      "POST /api/agendamentos",
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
    });
  })
  .catch((error) => {
    console.error("Erro ao iniciar banco:", error);
    process.exit(1);
  });
