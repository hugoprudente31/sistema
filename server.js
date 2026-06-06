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
