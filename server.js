const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

const publicPath = path.join(__dirname, "public");
if (fs.existsSync(publicPath)) app.use(express.static(publicPath));

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

function clean(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function boolFromPt(v) {
  const s = clean(v).toLowerCase();
  return ["sim", "s", "yes", "true", "1", "ativo", "active"].includes(s);
}

function numberFromBR(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function toPgDate(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function toPgTimestamp(v) {
  const s = clean(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.replace("T", " ").slice(0, 19);
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) return `${br[3]}-${br[2]}-${br[1]} ${br[4] || "00"}:${br[5] || "00"}:${br[6] || "00"}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().replace("T", " ").slice(0, 19);
  return null;
}

function makeGasId(prefix, value) {
  const base = clean(value);
  if (base) return `${prefix}:${base}`;
  return `${prefix}:hash:${crypto.randomBytes(8).toString("hex")}`;
}

function stableHash(obj) {
  return crypto.createHash("sha1").update(JSON.stringify(obj || {})).digest("hex");
}

async function addColumnIfMissing(table, column, definition) {
  await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
}

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agendamentos (
      id SERIAL PRIMARY KEY,
      gas_id TEXT UNIQUE,
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
      responsavel TEXT,
      atendimento_realizado TEXT,
      venda_gerada TEXT,
      valor_venda NUMERIC(12,2) DEFAULT 0,
      desconto NUMERIC(12,2) DEFAULT 0,
      motivo_perda TEXT,
      consultor_responsavel TEXT,
      criado_por_email TEXT,
      proprietario_id TEXT,
      proprietario_nome TEXT,
      numero_os TEXT,
      data_abertura_os DATE,
      data_entrada_os DATE,
      data_finalizacao_os DATE,
      data_entrega_os DATE,
      status_os TEXT,
      access_tags TEXT,
      lead_time_dias INTEGER,
      vendedor_nome TEXT,
      kommo_lead_id TEXT,
      origem_sync TEXT DEFAULT 'postgres',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      gas_id TEXT UNIQUE,
      nome TEXT NOT NULL,
      whatsapp TEXT,
      email TEXT,
      cpf TEXT,
      data_nascimento DATE,
      origem TEXT,
      loja_origem TEXT,
      observacoes TEXT,
      origem_sync TEXT DEFAULT 'postgres',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS faturamentos (
      id SERIAL PRIMARY KEY,
      gas_id TEXT UNIQUE,
      cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
      agendamento_id INTEGER REFERENCES agendamentos(id) ON DELETE SET NULL,
      loja TEXT,
      vendedor TEXT,
      valor_total NUMERIC(12,2) DEFAULT 0,
      forma_pagamento TEXT,
      status_pagamento TEXT DEFAULT 'Pendente',
      data_venda DATE,
      observacao TEXT,
      origem_sync TEXT DEFAULT 'postgres',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      gas_id TEXT UNIQUE,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT,
      cargo TEXT,
      loja TEXT,
      access_tags TEXT,
      can_view_finance BOOLEAN DEFAULT false,
      ativo BOOLEAN DEFAULT true,
      origem_sync TEXT DEFAULT 'postgres',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS lojas (
      id SERIAL PRIMARY KEY,
      gas_id TEXT UNIQUE,
      nome TEXT NOT NULL,
      cidade TEXT,
      endereco TEXT,
      ativo BOOLEAN DEFAULT true,
      origem_sync TEXT DEFAULT 'postgres',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS optometristas (
      id SERIAL PRIMARY KEY,
      gas_id TEXT UNIQUE,
      nome TEXT NOT NULL,
      loja TEXT,
      ativo BOOLEAN DEFAULT true,
      origem_sync TEXT DEFAULT 'postgres',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS origens (
      id SERIAL PRIMARY KEY,
      gas_id TEXT UNIQUE,
      nome TEXT NOT NULL,
      ativo BOOLEAN DEFAULT true,
      origem_sync TEXT DEFAULT 'postgres',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS feriados (
      id SERIAL PRIMARY KEY,
      gas_id TEXT UNIQUE,
      data DATE NOT NULL,
      descricao TEXT,
      ativo BOOLEAN DEFAULT true,
      origem_sync TEXT DEFAULT 'postgres',
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

  await addColumnIfMissing("agendamentos", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("agendamentos", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("clientes", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("clientes", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("faturamentos", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("faturamentos", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("usuarios", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("usuarios", "access_tags", "TEXT");
  await addColumnIfMissing("usuarios", "can_view_finance", "BOOLEAN DEFAULT false");
  await addColumnIfMissing("usuarios", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("lojas", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("lojas", "cidade", "TEXT");
  await addColumnIfMissing("lojas", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("optometristas", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("optometristas", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("origens", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("origens", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("feriados", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("feriados", "origem_sync", "TEXT DEFAULT 'postgres'");

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(data_agendamento);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_gas_id ON agendamentos(gas_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientes_whatsapp ON clientes(whatsapp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturamentos_data ON faturamentos(data_venda);`);
}

function buildGasPayload(body) {
  body = body || {};
  const fn = clean(body.fn || body.action || body.acao);
  const args = Array.isArray(body.args) ? body.args : [];
  const payload = { ...body };

  if (!fn) {
    if (GAS_API_KEY && !payload.apiKey && !payload.token && !payload.secret) payload.apiKey = GAS_API_KEY;
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
    case "getOptometristasPorLoja":
      payload.action = "getOptometristasPorLoja";
      payload.loja = args[0] || body.loja || "";
      break;
    case "syncPostgres":
      payload.action = "syncPostgres";
      payload.payload = args[0] || body.payload || {};
      break;
    default:
      payload.action = fn;
      if (args[0] !== undefined && payload.payload === undefined) payload.payload = args[0];
      if (args[1] !== undefined && payload.user === undefined) payload.user = args[1];
      break;
  }

  if (GAS_API_KEY && !payload.apiKey && !payload.token && !payload.secret) payload.apiKey = GAS_API_KEY;
  delete payload.fn;
  delete payload.args;
  return payload;
}

async function callGas(fn, args = [], timeoutMs = 120000) {
  if (!GAS_URL) {
    throw new Error("GAS_URL não configurada no Railway.");
  }

  const payload = buildGasPayload({ fn, args });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const response = await fetch(GAS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal
  }).finally(() => clearTimeout(timeout));

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("GAS não retornou JSON: " + text.slice(0, 300));
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || `GAS HTTP ${response.status}`);
  }

  if (data.ok === false) {
    throw new Error(data.message || data.error || data.erro || "Erro retornado pelo GAS.");
  }

  return data.result !== undefined ? data.result : data;
}

async function upsertUsuarios(client, rows) {
  let count = 0;
  for (const r of rows || []) {
    const email = clean(r.Email || r.email);
    if (!email) continue;
    const gasId = makeGasId("usuario", r.IdUsuario || email);
    await client.query(
      `INSERT INTO usuarios (gas_id, nome, email, cargo, loja, access_tags, can_view_finance, ativo, origem_sync, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'gas',CURRENT_TIMESTAMP)
       ON CONFLICT (email) DO UPDATE SET
         gas_id = EXCLUDED.gas_id,
         nome = EXCLUDED.nome,
         cargo = EXCLUDED.cargo,
         loja = EXCLUDED.loja,
         access_tags = EXCLUDED.access_tags,
         can_view_finance = EXCLUDED.can_view_finance,
         ativo = EXCLUDED.ativo,
         origem_sync = 'gas',
         atualizado_em = CURRENT_TIMESTAMP`,
      [
        gasId,
        clean(r.Nome || r.nome || email),
        email.toLowerCase(),
        clean(r.Perfil || r.cargo || r.perfil),
        clean(r.Loja || r.loja),
        clean(r.AccessTags || r.access_tags),
        boolFromPt(r.CanViewFinance),
        boolFromPt(r.Ativo || "Sim")
      ]
    );
    count++;
  }
  return count;
}

async function upsertLojas(client, rows) {
  let count = 0;
  for (const r of rows || []) {
    const nome = clean(r.Loja || r.nome || r.Nome);
    if (!nome) continue;
    const gasId = makeGasId("loja", nome);
    await client.query(
      `INSERT INTO lojas (gas_id, nome, cidade, ativo, origem_sync, atualizado_em)
       VALUES ($1,$2,$3,$4,'gas',CURRENT_TIMESTAMP)
       ON CONFLICT (gas_id) DO UPDATE SET
         nome = EXCLUDED.nome,
         cidade = EXCLUDED.cidade,
         ativo = EXCLUDED.ativo,
         origem_sync = 'gas',
         atualizado_em = CURRENT_TIMESTAMP`,
      [gasId, nome, clean(r.Cidade || r.cidade), boolFromPt(r.Ativa || r.ativo || "Sim")]
    );
    count++;
  }
  return count;
}

async function upsertOptometristas(client, rows) {
  let count = 0;
  for (const r of rows || []) {
    const nome = clean(r.Optometrista || r.nome || r.Nome);
    const loja = clean(r.Loja || r.loja);
    if (!nome) continue;
    const gasId = makeGasId("opto", `${loja}|${nome}`);
    await client.query(
      `INSERT INTO optometristas (gas_id, nome, loja, ativo, origem_sync, atualizado_em)
       VALUES ($1,$2,$3,$4,'gas',CURRENT_TIMESTAMP)
       ON CONFLICT (gas_id) DO UPDATE SET
         nome = EXCLUDED.nome,
         loja = EXCLUDED.loja,
         ativo = EXCLUDED.ativo,
         origem_sync = 'gas',
         atualizado_em = CURRENT_TIMESTAMP`,
      [gasId, nome, loja, boolFromPt(r.Ativo || r.ativo || "Sim")]
    );
    count++;
  }
  return count;
}

async function upsertOrigens(client, rows) {
  let count = 0;
  for (const r of rows || []) {
    const nome = clean(r.Origem || r.nome || r.Nome);
    if (!nome) continue;
    const gasId = makeGasId("origem", nome);
    await client.query(
      `INSERT INTO origens (gas_id, nome, ativo, origem_sync, atualizado_em)
       VALUES ($1,$2,$3,'gas',CURRENT_TIMESTAMP)
       ON CONFLICT (gas_id) DO UPDATE SET
         nome = EXCLUDED.nome,
         ativo = EXCLUDED.ativo,
         origem_sync = 'gas',
         atualizado_em = CURRENT_TIMESTAMP`,
      [gasId, nome, boolFromPt(r.Ativa || r.ativo || "Sim")]
    );
    count++;
  }
  return count;
}

async function upsertFeriados(client, rows) {
  let count = 0;
  for (const r of rows || []) {
    const data = toPgDate(r.Data || r.data);
    if (!data) continue;
    const gasId = makeGasId("feriado", data);
    await client.query(
      `INSERT INTO feriados (gas_id, data, descricao, ativo, origem_sync, atualizado_em)
       VALUES ($1,$2,$3,true,'gas',CURRENT_TIMESTAMP)
       ON CONFLICT (gas_id) DO UPDATE SET
         data = EXCLUDED.data,
         descricao = EXCLUDED.descricao,
         ativo = true,
         origem_sync = 'gas',
         atualizado_em = CURRENT_TIMESTAMP`,
      [gasId, data, clean(r.Descricao || r.descricao)]
    );
    count++;
  }
  return count;
}

async function upsertClienteDerivado(client, r) {
  const nome = clean(r.NomeCompleto || r.nome);
  const whatsapp = clean(r.WhatsApp || r.whatsapp);
  const email = clean(r.Email || r.email);
  if (!nome || (!whatsapp && !email)) return null;

  const key = whatsapp || email || nome;
  const gasId = makeGasId("cliente", key.toLowerCase());

  const result = await client.query(
    `INSERT INTO clientes (gas_id, nome, whatsapp, email, origem, loja_origem, observacoes, origem_sync, atualizado_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'gas',CURRENT_TIMESTAMP)
     ON CONFLICT (gas_id) DO UPDATE SET
       nome = EXCLUDED.nome,
       whatsapp = EXCLUDED.whatsapp,
       email = EXCLUDED.email,
       origem = COALESCE(EXCLUDED.origem, clientes.origem),
       loja_origem = COALESCE(EXCLUDED.loja_origem, clientes.loja_origem),
       observacoes = COALESCE(EXCLUDED.observacoes, clientes.observacoes),
       origem_sync = 'gas',
       atualizado_em = CURRENT_TIMESTAMP
     RETURNING id`,
    [
      gasId,
      nome,
      whatsapp || null,
      email || null,
      clean(r.Origem),
      clean(r.Loja),
      clean(r.Observacao)
    ]
  );

  return result.rows[0]?.id || null;
}

async function upsertAgendamentos(client, rows) {
  let count = 0;
  let clientes = 0;
  let faturamentos = 0;

  for (const r of rows || []) {
    const nome = clean(r.NomeCompleto || r.nome);
    if (!nome) continue;

    const gasId = makeGasId("agendamento", r.ID || stableHash(r));
    const clienteId = await upsertClienteDerivado(client, r);
    if (clienteId) clientes++;

    const result = await client.query(
      `INSERT INTO agendamentos (
        gas_id, nome, whatsapp, email, loja, optometrista, origem, data_agendamento, horario, observacao,
        status, compareceu, responsavel, atendimento_realizado, venda_gerada, valor_venda, desconto,
        motivo_perda, consultor_responsavel, criado_por_email, proprietario_id, proprietario_nome,
        numero_os, data_abertura_os, data_entrada_os, data_finalizacao_os, data_entrega_os, status_os,
        access_tags, lead_time_dias, vendedor_nome, kommo_lead_id, origem_sync, criado_em, atualizado_em
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,
        $23,$24,$25,$26,$27,$28,
        $29,$30,$31,$32,'gas',COALESCE($33,CURRENT_TIMESTAMP),CURRENT_TIMESTAMP
      )
      ON CONFLICT (gas_id) DO UPDATE SET
        nome = EXCLUDED.nome,
        whatsapp = EXCLUDED.whatsapp,
        email = EXCLUDED.email,
        loja = EXCLUDED.loja,
        optometrista = EXCLUDED.optometrista,
        origem = EXCLUDED.origem,
        data_agendamento = EXCLUDED.data_agendamento,
        horario = EXCLUDED.horario,
        observacao = EXCLUDED.observacao,
        status = EXCLUDED.status,
        compareceu = EXCLUDED.compareceu,
        responsavel = EXCLUDED.responsavel,
        atendimento_realizado = EXCLUDED.atendimento_realizado,
        venda_gerada = EXCLUDED.venda_gerada,
        valor_venda = EXCLUDED.valor_venda,
        desconto = EXCLUDED.desconto,
        motivo_perda = EXCLUDED.motivo_perda,
        consultor_responsavel = EXCLUDED.consultor_responsavel,
        criado_por_email = EXCLUDED.criado_por_email,
        proprietario_id = EXCLUDED.proprietario_id,
        proprietario_nome = EXCLUDED.proprietario_nome,
        numero_os = EXCLUDED.numero_os,
        data_abertura_os = EXCLUDED.data_abertura_os,
        data_entrada_os = EXCLUDED.data_entrada_os,
        data_finalizacao_os = EXCLUDED.data_finalizacao_os,
        data_entrega_os = EXCLUDED.data_entrega_os,
        status_os = EXCLUDED.status_os,
        access_tags = EXCLUDED.access_tags,
        lead_time_dias = EXCLUDED.lead_time_dias,
        vendedor_nome = EXCLUDED.vendedor_nome,
        kommo_lead_id = EXCLUDED.kommo_lead_id,
        origem_sync = 'gas',
        atualizado_em = CURRENT_TIMESTAMP
      RETURNING id`,
      [
        gasId,
        nome,
        clean(r.WhatsApp) || null,
        clean(r.Email) || null,
        clean(r.Loja) || null,
        clean(r.Optometrista) || null,
        clean(r.Origem) || null,
        toPgDate(r.DataAgendamento),
        clean(r.Horario) || null,
        clean(r.Observacao) || null,
        clean(r.StatusAgenda) || "Agendado",
        clean(r.Compareceu) || "Pendente",
        clean(r.Responsavel) || null,
        clean(r.AtendimentoRealizado) || null,
        clean(r.VendaGerada) || null,
        numberFromBR(r.ValorVenda),
        numberFromBR(r.Desconto),
        clean(r.MotivoPerda) || null,
        clean(r.ConsultorResponsavel) || null,
        clean(r.CriadoPorEmail) || null,
        clean(r.ProprietarioId) || null,
        clean(r.ProprietarioNome) || null,
        clean(r.NumeroOS) || null,
        toPgDate(r.DataAberturaOS),
        toPgDate(r.DataEntradaOS),
        toPgDate(r.DataFinalizacaoOS),
        toPgDate(r.DataEntregaOS),
        clean(r.StatusOS) || null,
        clean(r.AccessTags) || null,
        Number.parseInt(r.LeadTimeDias || "0", 10) || null,
        clean(r.VendedorNome) || null,
        clean(r.KommoLeadId) || null,
        toPgTimestamp(r.DataCadastro)
      ]
    );

    const agendamentoId = result.rows[0]?.id;
    const valor = numberFromBR(r.ValorVenda);
    if (valor > 0 && agendamentoId) {
      const fatGasId = makeGasId("faturamento", r.ID || gasId);
      await client.query(
        `INSERT INTO faturamentos (
          gas_id, cliente_id, agendamento_id, loja, vendedor, valor_total, forma_pagamento,
          status_pagamento, data_venda, observacao, origem_sync, atualizado_em
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'gas',CURRENT_TIMESTAMP)
        ON CONFLICT (gas_id) DO UPDATE SET
          cliente_id = EXCLUDED.cliente_id,
          agendamento_id = EXCLUDED.agendamento_id,
          loja = EXCLUDED.loja,
          vendedor = EXCLUDED.vendedor,
          valor_total = EXCLUDED.valor_total,
          status_pagamento = EXCLUDED.status_pagamento,
          data_venda = EXCLUDED.data_venda,
          observacao = EXCLUDED.observacao,
          origem_sync = 'gas',
          atualizado_em = CURRENT_TIMESTAMP`,
        [
          fatGasId,
          clienteId,
          agendamentoId,
          clean(r.Loja),
          clean(r.VendedorNome || r.ProprietarioNome || r.Responsavel),
          valor,
          null,
          "Pago",
          toPgDate(r.DataFinalizacaoOS || r.DataAgendamento || r.DataCadastro),
          "Importado automaticamente do GAS/Sheets"
        ]
      );
      faturamentos++;
    }

    count++;
  }

  return { agendamentos: count, clientes_derivados: clientes, faturamentos_derivados: faturamentos };
}

async function syncGasToPostgres(options = {}) {
  const gas = await callGas("syncPostgres", [options], 180000);
  const payload = gas && gas.data ? gas.data : null;

  if (!payload) {
    throw new Error("Resposta do GAS sem data para sincronizar.");
  }

  const client = await pool.connect();
  const summary = {};

  try {
    await client.query("BEGIN");

    summary.usuarios = await upsertUsuarios(client, payload.usuarios);
    summary.lojas = await upsertLojas(client, payload.lojas);
    summary.optometristas = await upsertOptometristas(client, payload.optometristas);
    summary.origens = await upsertOrigens(client, payload.origens);
    summary.feriados = await upsertFeriados(client, payload.feriados);

    const ag = await upsertAgendamentos(client, payload.agendamentos);
    summary.agendamentos = ag.agendamentos;
    summary.clientes_derivados = ag.clientes_derivados;
    summary.faturamentos_derivados = ag.faturamentos_derivados;

    await client.query(
      `INSERT INTO logs_sistema (tipo, origem, mensagem, detalhes)
       VALUES ('sync','gas','Sincronização GAS para PostgreSQL concluída',$1)`,
      [JSON.stringify({ summary, gasTs: gas.ts || null })]
    );

    await client.query("COMMIT");

    return {
      ok: true,
      message: "Sincronização GAS → PostgreSQL concluída.",
      summary,
      gasTs: gas.ts || null
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
        syncGasToPostgres: true,
        agendamentos: true,
        clientes: true,
        faturamentos: true,
        dashboard: true
      },
      ts: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ ok: false, database: false, error: error.message });
  }
});

app.post("/api/gas", async (req, res) => {
  try {
    const result = await callGas(req.body?.fn || req.body?.action || "", req.body?.args || [], 90000);
    res.json({
      ok: true,
      action: req.body?.fn || req.body?.action || "",
      result
    });
  } catch (error) {
    console.error("Erro no proxy /api/gas:", error);
    res.status(502).json({
      ok: false,
      message: "Falha ao comunicar com o Google Apps Script.",
      error: error.message
    });
  }
});

app.post("/api/sync/gas-to-postgres", async (req, res) => {
  try {
    const result = await syncGasToPostgres(req.body || {});
    res.json(result);
  } catch (error) {
    console.error("Erro na sincronização GAS → PostgreSQL:", error);
    res.status(500).json({
      ok: false,
      message: "Erro na sincronização GAS → PostgreSQL.",
      error: error.message
    });
  }
});

app.post("/api/agendamentos", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await pool.query(
      `INSERT INTO agendamentos (
        gas_id, nome, whatsapp, email, loja, optometrista, origem,
        data_agendamento, horario, observacao, status, compareceu,
        responsavel, criado_por_email, proprietario_id, proprietario_nome, access_tags, origem_sync
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'postgres')
      RETURNING *`,
      [
        b.gas_id || null,
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
    res.json({ ok: true, message: "Agendamento salvo no PostgreSQL.", agendamento: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao salvar agendamento.", error: error.message });
  }
});

app.get("/api/agendamentos", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM agendamentos ORDER BY id DESC LIMIT 1000`);
    res.json({ ok: true, total: result.rows.length, agendamentos: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch("/api/agendamentos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const result = await pool.query(
      `UPDATE agendamentos SET
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
      RETURNING *`,
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

    if (!result.rows.length) return res.status(404).json({ ok: false, message: "Agendamento não encontrado." });
    res.json({ ok: true, agendamento: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/clientes", async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.nome) return res.status(400).json({ ok: false, message: "Nome do cliente é obrigatório." });

    const gasId = b.gas_id || (b.whatsapp || b.email ? makeGasId("cliente", (b.whatsapp || b.email).toLowerCase()) : null);

    const result = await pool.query(
      `INSERT INTO clientes (gas_id, nome, whatsapp, email, cpf, data_nascimento, origem, loja_origem, observacoes, origem_sync, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'postgres',CURRENT_TIMESTAMP)
       ON CONFLICT (gas_id) DO UPDATE SET
         nome = EXCLUDED.nome,
         whatsapp = EXCLUDED.whatsapp,
         email = EXCLUDED.email,
         cpf = EXCLUDED.cpf,
         data_nascimento = EXCLUDED.data_nascimento,
         origem = EXCLUDED.origem,
         loja_origem = EXCLUDED.loja_origem,
         observacoes = EXCLUDED.observacoes,
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        gasId,
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

    res.json({ ok: true, message: "Cliente salvo no banco.", cliente: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao salvar cliente.", error: error.message });
  }
});

app.get("/api/clientes", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM clientes ORDER BY id DESC LIMIT 1000`);
    res.json({ ok: true, total: result.rows.length, clientes: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/lojas", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM lojas WHERE ativo = true ORDER BY nome ASC`);
    res.json({ ok: true, lojas: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/origens", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM origens WHERE ativo = true ORDER BY nome ASC`);
    res.json({ ok: true, origens: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/optometristas", async (req, res) => {
  try {
    const loja = clean(req.query.loja || "");
    const result = loja
      ? await pool.query(`SELECT * FROM optometristas WHERE ativo = true AND loja = $1 ORDER BY nome ASC`, [loja])
      : await pool.query(`SELECT * FROM optometristas WHERE ativo = true ORDER BY loja ASC, nome ASC`);
    res.json({ ok: true, optometristas: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/faturamentos", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await pool.query(
      `INSERT INTO faturamentos (
        gas_id, cliente_id, agendamento_id, loja, vendedor, valor_total,
        forma_pagamento, status_pagamento, data_venda, observacao, origem_sync
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'postgres')
      RETURNING *`,
      [
        b.gas_id || null,
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
    res.json({ ok: true, message: "Faturamento salvo no banco.", faturamento: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao salvar faturamento.", error: error.message });
  }
});

app.get("/api/faturamentos", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM faturamentos ORDER BY id DESC LIMIT 1000`);
    res.json({ ok: true, total: result.rows.length, faturamentos: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/logs", async (req, res) => {
  try {
    const b = req.body || {};
    const result = await pool.query(
      `INSERT INTO logs_sistema (tipo, origem, mensagem, detalhes) VALUES ($1,$2,$3,$4) RETURNING *`,
      [b.tipo || "info", b.origem || null, b.mensagem || null, b.detalhes ? JSON.stringify(b.detalhes) : null]
    );
    res.json({ ok: true, log: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.get("/api/usuarios", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, gas_id, nome, email, cargo, loja, access_tags, can_view_finance, ativo
      FROM usuarios
      WHERE ativo = true
      ORDER BY loja ASC, nome ASC
      LIMIT 1000
    `);
    res.json({ ok: true, usuarios: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/access-tags", async (req, res) => {
  try {
    const baseTags = [
      'origem:google','origem:instagram','origem:facebook','origem:indicacao',
      'origem:whatsapp','origem:trafego-pago','origem:organico','origem:site',
      'perfil:primeira-compra','perfil:cliente-recorrente','perfil:alto-ticket',
      'prioridade:alta','prioridade:media','prioridade:baixa',
      'fluxo:agendamento-confirmado','fluxo:precisa-retorno','fluxo:nao-atendeu',
      'fluxo:reagendar','fluxo:os-aberta','fluxo:os-em-andamento','fluxo:os-atrasada',
      'fluxo:os-pronta','fluxo:os-entregue','comercial:potencial-venda',
      'comercial:venda-fechada','comercial:pos-venda','loja:gonzaga','loja:target',
      'loja:pitangueiras','loja:enseada','operacao:laboratorio','operacao:central',
      'operacao:optometria'
    ];

    const ag = await pool.query(`SELECT access_tags FROM agendamentos WHERE access_tags IS NOT NULL AND access_tags <> '' LIMIT 1000`);
    const us = await pool.query(`SELECT access_tags FROM usuarios WHERE access_tags IS NOT NULL AND access_tags <> '' LIMIT 1000`);

    const set = new Set(baseTags);
    [...ag.rows, ...us.rows].forEach((r) => {
      String(r.access_tags || '').split(/[;,|]/).map((x) => x.trim().toLowerCase()).filter(Boolean).forEach((x) => set.add(x));
    });

    const tags = Array.from(set).sort().map((t) => ({ id: t, nome: t }));
    res.json({ ok: true, accessTags: tags });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.get("/api/dashboard", async (req, res) => {
  try {
    const clientes = await pool.query(`SELECT COUNT(*)::int AS total FROM clientes`);
    const agendamentos = await pool.query(`SELECT COUNT(*)::int AS total FROM agendamentos`);
    const faturamentos = await pool.query(`
      SELECT COUNT(*)::int AS total_vendas, COALESCE(SUM(valor_total), 0)::numeric AS faturamento_total
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
    res.status(500).json({ ok: false, message: "Erro ao carregar dashboard.", error: error.message });
  }
});

app.get("/", (req, res) => {
  const indexPath = path.join(publicPath, "index.html");
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.json({
    ok: true,
    service: "Agendamento System",
    message: "Servidor rodando com PostgreSQL + GAS sync.",
    routes: [
      "GET /health",
      "POST /api/gas",
      "POST /api/sync/gas-to-postgres",
      "GET /api/agendamentos",
      "POST /api/agendamentos",
      "PATCH /api/agendamentos/:id",
      "GET /api/clientes",
      "POST /api/clientes",
      "GET /api/lojas",
      "GET /api/origens",
      "GET /api/optometristas",
      "GET /api/usuarios",
      "GET /api/access-tags",
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
