const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});
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
}

app.get("/health", async (req, res) => {
  try {
    const db = await pool.query("SELECT NOW() as agora");

    res.json({
      ok: true,
      service: "Agendamento System",
      database: true,
      databaseTime: db.rows[0].agora,
      ts: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: "Agendamento System",
      database: false,
      error: error.message
    });
  }
});

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

    const dataFinal = data_agendamento || data || null;

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
        status
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
        dataFinal,
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
    console.error("Erro ao salvar agendamento:", error);
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
      LIMIT 200
    `);

    res.json({
      ok: true,
      total: result.rows.length,
      agendamentos: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao buscar agendamentos.",
      error: error.message
    });
  }
});

app.patch("/api/agendamentos/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status, compareceu } = req.body;

    const result = await pool.query(
      `
      UPDATE agendamentos
      SET
        status = COALESCE($1, status),
        compareceu = COALESCE($2, compareceu),
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
      `,
      [status || null, compareceu || null, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        ok: false,
        message: "Agendamento não encontrado."
      });
    }

    res.json({
      ok: true,
      message: "Agendamento atualizado.",
      agendamento: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao atualizar agendamento.",
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
      "PATCH /api/agendamentos/:id/status"
    ]
  });
});
// ===============================
// ROTAS POSTGRESQL - CLIENTES
// ===============================

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
    console.error("Erro ao salvar cliente:", error);
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
      message: "Erro ao buscar clientes.",
      error: error.message
    });
  }
});


// ===============================
// ROTAS POSTGRESQL - FATURAMENTOS
// ===============================

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
    console.error("Erro ao salvar faturamento:", error);
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
      message: "Erro ao buscar faturamentos.",
      error: error.message
    });
  }
});


// ===============================
// ROTAS POSTGRESQL - HISTÓRICO DE USUÁRIOS
// ===============================

app.post("/api/historico/usuarios", async (req, res) => {
  try {
    const {
      usuario_id,
      usuario_nome,
      acao,
      modulo,
      descricao
    } = req.body;

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
      message: "Histórico de usuário salvo.",
      historico: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao salvar histórico de usuário.",
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
      message: "Erro ao buscar histórico de usuários.",
      error: error.message
    });
  }
});


// ===============================
// ROTAS POSTGRESQL - HISTÓRICO DE AGENDAMENTOS
// ===============================

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
        agendamento_id,
        usuario_id,
        usuario_nome,
        acao,
        status_anterior,
        status_novo,
        observacao
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
      message: "Histórico de agendamento salvo.",
      historico: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao salvar histórico de agendamento.",
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
      message: "Erro ao buscar histórico de agendamentos.",
      error: error.message
    });
  }
});


// ===============================
// ROTAS POSTGRESQL - LOGS DO SISTEMA
// ===============================

app.post("/api/logs", async (req, res) => {
  try {
    const {
      tipo,
      origem,
      mensagem,
      detalhes
    } = req.body;

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
        tipo || "info",
        origem || null,
        mensagem || null,
        detalhes ? JSON.stringify(detalhes) : null
      ]
    );

    res.json({
      ok: true,
      message: "Log salvo.",
      log: result.rows[0]
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: "Erro ao salvar log.",
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
      message: "Erro ao buscar logs.",
      error: error.message
    });
  }
});


// ===============================
// DASHBOARD GERAL POSTGRESQL
// ===============================

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
