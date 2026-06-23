const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 8080;
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_COOKIE = "tgt_session";
const SESSION_TTL_HOURS = Math.max(1, Number(process.env.SESSION_TTL_HOURS || 12));
const ALLOWED_ORIGINS = new Set(
  String(process.env.ALLOWED_ORIGINS || "https://sistema.oticastgt.com.br,https://sistema-production-cd20.up.railway.app")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
);

app.disable("x-powered-by");
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
    return callback(null, false);
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

const publicPath = path.join(__dirname, "public");
if (fs.existsSync(publicPath)) app.use(express.static(publicPath));
// ===============================
// SEGURANÇA DAS LANDING PAGES
// ===============================

const LANDING_API_KEY =
  process.env.LANDING_API_KEY ||
  process.env.API_KEY ||
  "";

function validarLandingApiKey(req, res, next) {
  const recebida =
    req.headers["x-api-key"] ||
    req.headers["x-landing-api-key"] ||
    req.query.key ||
    "";

  if (!LANDING_API_KEY) {
    return res.status(500).json({
      ok: false,
      message: "LANDING_API_KEY não configurada no Railway."
    });
  }

  if (!safeEqual(recebida, LANDING_API_KEY)) {
    return res.status(401).json({
      ok: false,
      message: "Chave da landing page inválida."
    });
  }

  next();
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const GAS_URL =
  process.env.GAS_URL ||
  process.env.GAS_DEPLOY_URL ||
  process.env.GAS_WEBAPP_URL ||
  process.env.URL_GAS ||
  process.env.URL_DE_IMPLANTACAO_DE_GAS ||
  process.env.URL_DE_IMPLANTACAO_GAS ||
  "";

const GAS_API_KEY =
  process.env.GAS_API_KEY ||
  process.env.API_KEY ||
  "";

function safeEqual(value, expected) {
  const left = crypto.createHash("sha256").update(String(value || "")).digest();
  const right = crypto.createHash("sha256").update(String(expected || "")).digest();
  return crypto.timingSafeEqual(left, right);
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const index = item.indexOf("=");
      if (index > 0) cookies[item.slice(0, index)] = decodeURIComponent(item.slice(index + 1));
      return cookies;
    }, {});
}

function signSession(user) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    sub: String(user.id || user.user_id || user.email || ""),
    email: String(user.email || "").toLowerCase(),
    nome: String(user.nome || ""),
    perfil: String(user.perfil || user.cargo || ""),
    loja: String(user.loja || ""),
    canViewFinance: Boolean(user.permissions?.canViewFinance || user.can_view_finance),
    iat: now,
    exp: now + SESSION_TTL_HOURS * 60 * 60 * 1000
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(token) {
  if (!SESSION_SECRET || !token) return null;
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra) return null;
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  if (!safeEqual(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!session.exp || session.exp <= Date.now() || !session.email) return null;
    return session;
  } catch {
    return null;
  }
}

function sessionCookie(token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token || "")}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

function requireSession(req, res, next) {
  if (!SESSION_SECRET) {
    return res.status(503).json({ ok: false, message: "SESSION_SECRET não configurado." });
  }
  const session = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) {
    return res.status(401).json({ ok: false, message: "Sessão ausente ou expirada." });
  }
  req.session = session;
  next();
}

function roleOf(session) {
  return clean(session?.perfil).toLowerCase();
}

function hasRole(session, roles) {
  return roles.includes(roleOf(session));
}

function isAdmin(session) {
  return hasRole(session, ["admin"]);
}

function canViewAllStores(session) {
  return hasRole(session, ["admin", "atendimento central"]);
}

function canViewFinanceSession(session) {
  return Boolean(session?.canViewFinance) || hasRole(session, ["admin", "gerente de loja", "comprador"]);
}

function normalizeStoreKey(value) {
  return clean(value).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function storeSql(column, parameter = "$1") {
  return `TRANSLATE(LOWER(TRIM(COALESCE(${column},''))), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') = TRANSLATE(LOWER(TRIM(${parameter})), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
}

function buildPermissions(user) {
  const role = clean(user?.cargo || user?.perfil).toLowerCase();
  const admin = role === "admin";
  const central = role === "atendimento central";
  const manager = role === "gerente de loja";
  const buyer = role === "comprador";
  const seller = ["consultor de vendas", "vendedor"].includes(role);
  const canViewFinance = admin || manager || buyer || Boolean(user?.can_view_finance);

  return {
    isAdmin: admin,
    canViewAll: admin || central,
    canCreateAgendamento: admin || central || manager || buyer || seller,
    canManageOS: admin || manager || buyer,
    canViewFinance,
    canExportFinance: canViewFinance
  };
}

function publicUser(user) {
  const permissions = buildPermissions(user);
  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    perfil: user.cargo,
    cargo: user.cargo,
    loja: user.loja || "",
    accessTags: clean(user.access_tags).split(/[;,|]/).map((tag) => tag.trim()).filter(Boolean),
    permissions,
    can_view_finance: permissions.canViewFinance
  };
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req.session)) {
    return res.status(403).json({ ok: false, message: "Acesso restrito ao administrador." });
  }
  next();
}

function ensureStoreAccess(session, store) {
  if (canViewAllStores(session)) return true;
  return Boolean(session?.loja && store && normalizeStoreKey(session.loja) === normalizeStoreKey(store));
}

async function saveAppointmentBackup(db, { before = null, after = null, action, session = {} }) {
  const record = after || before || {};
  await db.query(
    `INSERT INTO historico_alteracoes_agendamentos (
       agendamento_id, loja, cliente_nome, acao, payload,
       feito_por_nome, feito_por_email, feito_por_perfil, feito_por_loja,
       registro_anterior, registro_novo
     ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
    [
      record.id || null,
      record.loja || null,
      record.nome || null,
      action,
      JSON.stringify({ anterior: before, novo: after }),
      clean(session.nome || "Sistema"),
      clean(session.email),
      clean(session.perfil || "sistema").toLowerCase(),
      clean(session.loja || record.loja),
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null
    ]
  );
}

// ===============================
// CONFIGURAÇÃO PÚBLICA — LANDING PAGES
// ===============================

const PUBLIC_BLOCKING_STATUSES = [
  "Agendado",
  "Confirmado",
  "Compareceu",
  "OS em Andamento"
];

function normalizeLojaPublica(loja) {
  const raw = clean(loja);
  const key = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Valores canônicos = nomes EXATOS da tabela lojas no banco de dados
  const mapa = {
    // Gonzaga (DB: "óticas TGT - Gonzaga")
    "gonzaga":                       "óticas TGT - Gonzaga",
    "gonzaga & santos":              "óticas TGT - Gonzaga",
    "gonzaga · santos":              "óticas TGT - Gonzaga",
    "oticas tgt gonzaga":            "óticas TGT - Gonzaga",
    "oticas tgt gonzaga santos":     "óticas TGT - Gonzaga",
    "oticas tgt gonzaga · santos":   "óticas TGT - Gonzaga",
    "oticas tgt - gonzaga":          "óticas TGT - Gonzaga",
    "óticas tgt gonzaga":            "óticas TGT - Gonzaga",
    "óticas tgt - gonzaga":          "óticas TGT - Gonzaga",

    // Enseada (DB: "óticas TGT Enseada")
    "enseada":                       "óticas TGT Enseada",
    "oticas tgt enseada":            "óticas TGT Enseada",
    "oticas tgt enseada guaruja":    "óticas TGT Enseada",
    "oticas tgt enseada guarujá":    "óticas TGT Enseada",
    "óticas tgt enseada":            "óticas TGT Enseada",
    "óticas tgt enseada guaruja":    "óticas TGT Enseada",
    "óticas tgt enseada guarujá":    "óticas TGT Enseada",

    // Pitangueiras (DB: "óticas TGT Pitangueiras")
    "pitangueiras":                        "óticas TGT Pitangueiras",
    "oticas tgt pitangueiras":             "óticas TGT Pitangueiras",
    "oticas tgt pitangueiras guaruja":     "óticas TGT Pitangueiras",
    "oticas tgt pitangueiras guarujá":     "óticas TGT Pitangueiras",
    "óticas tgt pitangueiras":             "óticas TGT Pitangueiras",
    "óticas tgt pitangueiras guaruja":     "óticas TGT Pitangueiras",
    "óticas tgt pitangueiras guarujá":     "óticas TGT Pitangueiras",

    // Ademar (DB: "óticas Target - Ademar de Barros")
    "ademar":                              "óticas Target - Ademar de Barros",
    "ademar de barros":                    "óticas Target - Ademar de Barros",
    "oticas target ademar de barros":      "óticas Target - Ademar de Barros",
    "oticas target - ademar de barros":    "óticas Target - Ademar de Barros",
    "óticas target - ademar de barros":    "óticas Target - Ademar de Barros",
    "óticas target ademar de barros":      "óticas Target - Ademar de Barros",

    // Santos / Gonzaga (mesma unidade — DB: "óticas TGT - Gonzaga", end: Av. Marechal Floriano Peixoto, 27, Santos/SP)
    "santos":                        "óticas TGT - Gonzaga",
    "gonzaga santos":                "óticas TGT - Gonzaga",
    "oticas tgt santos":             "óticas TGT - Gonzaga",
    "óticas tgt santos":             "óticas TGT - Gonzaga",
    "floriano":                      "óticas TGT - Gonzaga",
    "marechal floriano":             "óticas TGT - Gonzaga",

    // Ademar de Barros — também conhecido como "Sto. Antônio" na landing page
    // (4º card: Av. Ademar de Barros, 1450 — Santa Rosa, Guarujá SP)
    "santo antonio":                       "óticas Target - Ademar de Barros",
    "santo antônio":                       "óticas Target - Ademar de Barros",
    "sto. antonio":                        "óticas Target - Ademar de Barros",
    "sto. antônio":                        "óticas Target - Ademar de Barros",
    "target sto. antonio":                 "óticas Target - Ademar de Barros",
    "target · sto. antonio":              "óticas Target - Ademar de Barros",
    "target sto. antônio":                "óticas Target - Ademar de Barros",
    "target · sto. antônio":             "óticas Target - Ademar de Barros",
    "oticas tgt santo antonio":           "óticas Target - Ademar de Barros",
    "oticas tgt santo antônio":          "óticas Target - Ademar de Barros",
    "óticas tgt santo antonio":          "óticas Target - Ademar de Barros",
    "óticas tgt santo antônio":         "óticas Target - Ademar de Barros",
    "oticas target santo antonio":        "óticas Target - Ademar de Barros",
    "oticas target santo antônio":       "óticas Target - Ademar de Barros"
  };

  return mapa[key] || raw;
}

function normalizeWhatsappPublico(v) {
  return clean(v).replace(/\D/g, "");
}

function horarioValidoPorRegra(data, horario) {
  const dt = toPgDate(data);
  const hr = clean(horario);

  if (!dt || !/^\d{2}:\d{2}$/.test(hr)) {
    return { ok: true };
  }

  const d = new Date(dt + "T12:00:00");
  const dia = d.getDay();
  const [hh, mm] = hr.split(":").map(Number);
  const minutos = hh * 60 + mm;

  if (dia === 0) {
    return { ok: false, message: "Domingo não está disponível para agendamento." };
  }

  if (dia >= 1 && dia <= 5 && (minutos < 600 || minutos > 1080)) {
    return { ok: false, message: "De segunda a sexta, escolha entre 10:00 e 18:00." };
  }

  if (dia === 6 && (minutos < 600 || minutos > 960)) {
    return { ok: false, message: "Aos sábados, escolha entre 10:00 e 16:00." };
  }

  if (hr === "13:00" || hr === "13:30") {
    return { ok: false, message: "Horário de almoço não disponível. Escolha um horário fora do intervalo 13:00–13:30." };
  }

  return { ok: true };
}

function gerarHorariosBase(data) {
  const dt = toPgDate(data);
  if (!dt) return [];

  const d = new Date(dt + "T12:00:00");
  const dia = d.getDay();

  if (dia === 0) return [];

  const inicio = 10 * 60;
  const fim = dia === 6 ? 16 * 60 : 18 * 60;
  const horarios = [];

  for (let m = inicio; m <= fim; m += 30) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const h = `${hh}:${mm}`;
    if (h !== "13:00" && h !== "13:30") horarios.push(h);
  }

  return horarios;
}

async function buscarOptometristasAtivosPorLoja(client, loja) {
  const result = await client.query(
    `SELECT nome
     FROM optometristas
     WHERE ativo = true
       AND LOWER(REGEXP_REPLACE(loja, '\\s*-\\s*', ' ', 'g')) = LOWER(REGEXP_REPLACE($1, '\\s*-\\s*', ' ', 'g'))
     ORDER BY nome ASC`,
    [loja]
  );

  return result.rows.map((r) => r.nome).filter(Boolean);
}

async function buscarPrimeiroOptometristaLivre(client, loja, data, horario, optometristaPreferido) {
  const optometristas = await buscarOptometristasAtivosPorLoja(client, loja);
  const candidatos = [];

  if (clean(optometristaPreferido)) candidatos.push(clean(optometristaPreferido));

  optometristas.forEach((o) => {
    if (!candidatos.some((x) => x.toLowerCase() === String(o).toLowerCase())) {
      candidatos.push(o);
    }
  });

  if (!candidatos.length) candidatos.push("A definir");

  for (const optometrista of candidatos) {
    const ocupado = await client.query(
      `SELECT id
       FROM agendamentos
       WHERE LOWER(REGEXP_REPLACE(COALESCE(loja,''), '\\s*-\\s*', ' ', 'g')) = LOWER(REGEXP_REPLACE($1, '\\s*-\\s*', ' ', 'g'))
         AND LOWER(COALESCE(optometrista,'')) = LOWER($2)
         AND data_agendamento = $3
         AND horario = $4
         AND status = ANY($5::text[])
         AND excluido_em IS NULL
       LIMIT 1`,
      [loja, optometrista, data, horario, PUBLIC_BLOCKING_STATUSES]
    );

    if (!ocupado.rows.length) return optometrista;
  }

  return "";
}

function extrairUtm(req) {
  return {
    utm_source: clean(req.body?.utm_source || req.query?.utm_source),
    utm_medium: clean(req.body?.utm_medium || req.query?.utm_medium),
    utm_campaign: clean(req.body?.utm_campaign || req.query?.utm_campaign),
    utm_content: clean(req.body?.utm_content || req.query?.utm_content),
    utm_term: clean(req.body?.utm_term || req.query?.utm_term)
  };
}

function montarObservacaoPublica(b, req) {
  const partes = [];

  if (clean(b.observacao || b.obs)) partes.push(clean(b.observacao || b.obs));
  if (clean(b.servico)) partes.push("Serviço: " + clean(b.servico));
  if (clean(b.campanha)) partes.push("Campanha: " + clean(b.campanha));
  if (clean(b.landing_page || b.landingPage)) partes.push("Landing page: " + clean(b.landing_page || b.landingPage));
  if (clean(b.canal)) partes.push("Canal: " + clean(b.canal));

  const utm = extrairUtm(req);
  const utmTxt = Object.entries(utm)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

  if (utmTxt) partes.push("UTM: " + utmTxt);

  return partes.join(" | ");
}


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
  await addColumnIfMissing("agendamentos", "agendado_por_nome", "TEXT");
  await addColumnIfMissing("agendamentos", "agendado_por_email", "TEXT");
  await addColumnIfMissing("agendamentos", "vendedor_atendeu_nome", "TEXT");
  await addColumnIfMissing("agendamentos", "vendedor_atendeu_email", "TEXT");
  await addColumnIfMissing("agendamentos", "ultima_alteracao_por_nome", "TEXT");
  await addColumnIfMissing("agendamentos", "ultima_alteracao_por_email", "TEXT");
  await addColumnIfMissing("agendamentos", "ultima_alteracao_em", "TIMESTAMP");
  await addColumnIfMissing("agendamentos", "excluido_em", "TIMESTAMP");

  await addColumnIfMissing("clientes", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("clientes", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("faturamentos", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("faturamentos", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("usuarios", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("usuarios", "senha", "TEXT");
  await addColumnIfMissing("usuarios", "password_changed_at", "TIMESTAMP");
  await addColumnIfMissing("usuarios", "access_tags", "TEXT");
  await addColumnIfMissing("usuarios", "can_view_finance", "BOOLEAN DEFAULT false");
  await addColumnIfMissing("usuarios", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("lojas", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("lojas", "cidade", "TEXT");
  await addColumnIfMissing("lojas", "endereco", "TEXT");
  await addColumnIfMissing("lojas", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("optometristas", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("optometristas", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("origens", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("origens", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("feriados", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("feriados", "origem_sync", "TEXT DEFAULT 'postgres'");

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_data ON agendamentos(data_agendamento);`);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_agendamento_ativo_slot
    ON agendamentos (
      (LOWER(COALESCE(loja,''))),
      (LOWER(COALESCE(optometrista,''))),
      data_agendamento,
      horario
    )
    WHERE status IN ('Agendado','Confirmado','Compareceu','OS em Andamento')
      AND data_agendamento IS NOT NULL
      AND horario IS NOT NULL
      AND horario <> ''
      AND optometrista IS NOT NULL
      AND optometrista <> '';
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_gas_id ON agendamentos(gas_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientes_whatsapp ON clientes(whatsapp);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_faturamentos_data ON faturamentos(data_venda);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS historico_alteracoes_agendamentos (
      id SERIAL PRIMARY KEY,
      agendamento_id INTEGER,
      loja TEXT,
      cliente_nome TEXT,
      acao TEXT,
      payload JSONB,
      feito_por_nome TEXT,
      feito_por_email TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await addColumnIfMissing("historico_alteracoes_agendamentos", "feito_por_perfil", "TEXT");
  await addColumnIfMissing("historico_alteracoes_agendamentos", "feito_por_loja", "TEXT");
  await addColumnIfMissing("historico_alteracoes_agendamentos", "registro_anterior", "JSONB");
  await addColumnIfMissing("historico_alteracoes_agendamentos", "registro_novo", "JSONB");
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_hist_agendamento_data ON historico_alteracoes_agendamentos(agendamento_id, criado_em DESC);`);
  await pool.query(`
    INSERT INTO historico_alteracoes_agendamentos (
      agendamento_id, loja, cliente_nome, acao, payload,
      feito_por_nome, feito_por_perfil, feito_por_loja, registro_novo
    )
    SELECT a.id, a.loja, a.nome, 'BACKUP_INICIAL',
      jsonb_build_object('anterior', NULL, 'novo', to_jsonb(a)),
      'Sistema', 'sistema', a.loja, to_jsonb(a)
    FROM agendamentos a
    WHERE NOT EXISTS (
      SELECT 1 FROM historico_alteracoes_agendamentos h
      WHERE h.agendamento_id = a.id AND h.acao = 'BACKUP_INICIAL'
    );
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION backup_agendamento_tgt()
    RETURNS trigger AS $$
    DECLARE
      anterior JSONB;
      novo JSONB;
      registro JSONB;
    BEGIN
      IF current_setting('app.audit_managed', true) = 'true' THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END IF;
      anterior := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
      novo := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
      registro := COALESCE(novo, anterior);
      INSERT INTO historico_alteracoes_agendamentos (
        agendamento_id, loja, cliente_nome, acao, payload,
        feito_por_nome, feito_por_perfil, feito_por_loja,
        registro_anterior, registro_novo
      ) VALUES (
        (registro->>'id')::integer, registro->>'loja', registro->>'nome',
        'SISTEMA_' || TG_OP, jsonb_build_object('anterior', anterior, 'novo', novo),
        'Sistema/Integração', 'sistema', registro->>'loja', anterior, novo
      );
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_backup_agendamento_tgt ON agendamentos;
    CREATE TRIGGER trg_backup_agendamento_tgt
    AFTER INSERT OR UPDATE OR DELETE ON agendamentos
    FOR EACH ROW EXECUTE FUNCTION backup_agendamento_tgt();
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS historico_os (
      id SERIAL PRIMARY KEY,
      agendamento_id INTEGER,
      numero_os TEXT,
      cliente_nome TEXT,
      loja TEXT,
      acao TEXT NOT NULL,
      campo TEXT,
      valor_anterior TEXT,
      valor_novo TEXT,
      usuario_nome TEXT,
      usuario_email TEXT,
      usuario_cargo TEXT,
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION validar_agendamento_tgt()
    RETURNS trigger AS $$
    DECLARE
      j JSONB;
      nome_cliente TEXT;
      responsavel_registro TEXT;
    BEGIN
      j := to_jsonb(NEW);
      nome_cliente := COALESCE(j->>'nome', j->>'nome_completo', j->>'nomecompleto', j->>'cliente_nome', '');
      IF nome_cliente ILIKE '%teste%' THEN
        RAISE EXCEPTION 'Nome de cliente inválido. Não é permitido cadastrar registros com nome TESTE.';
      END IF;
      responsavel_registro := COALESCE(NULLIF(NEW.agendado_por_nome, ''), NULLIF(j->>'responsavel', ''), NULLIF(j->>'proprietario_nome', ''), NULLIF(j->>'criado_por_nome', ''), NULLIF(NEW.ultima_alteracao_por_nome, ''), 'Sistema/Landing');
      NEW.agendado_por_nome := COALESCE(NULLIF(NEW.agendado_por_nome, ''), responsavel_registro);
      NEW.ultima_alteracao_por_nome := responsavel_registro;
      NEW.ultima_alteracao_em := NOW();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_validar_agendamento_tgt ON agendamentos;
    CREATE TRIGGER trg_validar_agendamento_tgt
    BEFORE INSERT OR UPDATE ON agendamentos
    FOR EACH ROW EXECUTE FUNCTION validar_agendamento_tgt();
  `);

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

const loginAttempts = new Map();

function loginAttemptKey(req, email) {
  return `${req.ip || "unknown"}|${String(email || "").toLowerCase()}`;
}

function isLoginBlocked(key) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const current = loginAttempts.get(key);
  if (!current) return false;
  if (current.resetAt <= now) {
    loginAttempts.delete(key);
    return false;
  }
  return current.count >= 5;
}

function recordFailedLogin(key) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const current = loginAttempts.get(key) || { count: 0, resetAt: now + windowMs };
  current.count += 1;
  loginAttempts.set(key, current);
}

app.post("/api/auth/login", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (!SESSION_SECRET) {
    return res.status(503).json({
      ok: false,
      message: "Autenticação ainda não configurada no servidor."
    });
  }

  const email = clean(req.body?.email).toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    return res.status(400).json({ ok: false, message: "Informe e-mail e senha." });
  }
  const attemptKey = loginAttemptKey(req, email);
  if (isLoginBlocked(attemptKey)) {
    return res.status(429).json({ ok: false, message: "Muitas tentativas para esta conta. Aguarde 15 minutos." });
  }

  try {
    const result = await pool.query(
      `SELECT id, nome, email, senha, cargo, loja, access_tags, can_view_finance, ativo
       FROM usuarios
       WHERE LOWER(email) = LOWER($1) AND ativo = true
       LIMIT 1`,
      [email]
    );
    const dbUser = result.rows[0];
    const passwordOk = Boolean(dbUser?.senha) && await bcrypt.compare(password, dbUser.senha);
    if (!dbUser || !passwordOk) {
      recordFailedLogin(attemptKey);
      return res.status(401).json({ ok: false, message: "Credenciais inválidas." });
    }

    loginAttempts.delete(attemptKey);
    const user = publicUser(dbUser);
    const token = signSession(user);
    res.setHeader("Set-Cookie", sessionCookie(token, SESSION_TTL_HOURS * 60 * 60));
    return res.json({
      ok: true,
      user,
      session: { resolvedEmail: user.email },
      serverVersion: "7.3.0-auth-individual"
    });
  } catch (error) {
    console.error("Erro no login seguro:", error.message);
    return res.status(500).json({ ok: false, message: "Não foi possível autenticar agora." });
  }
});

app.get("/api/auth/session", requireSession, (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, session: req.session });
});

app.post("/api/auth/logout", (req, res) => {
  res.setHeader("Set-Cookie", sessionCookie("", 0));
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/auth/login" || req.path === "/auth/logout") return next();
  if (req.path.startsWith("/public/")) return next();
  return requireSession(req, res, next);
});

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
        publicLandingPages: true,
        publicLojas: true,
        publicOptometristas: true,
        publicHorariosDisponiveis: true,
        publicAgendamentos: true,
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
    const fn = clean(req.body?.fn || req.body?.action);
    const incomingArgs = Array.isArray(req.body?.args) ? req.body.args : [];
    const allowedByRole = {
      getInfoInicial: () => true,
      gerarRelatorioCSV: () => true,
      getLeadTimeReport: () => hasRole(req.session, ["admin", "atendimento central", "gerente de loja"]),
      getHistoricoOperacional: () => hasRole(req.session, ["admin", "gerente de loja"]),
      exportFinanceCSV: () => canViewFinanceSession(req.session),
      atualizarPlanilhaSistemaCompleto: () => isAdmin(req.session),
      testarBackend: () => isAdmin(req.session)
    };

    if (!allowedByRole[fn] || !allowedByRole[fn]()) {
      return res.status(403).json({ ok: false, message: "Função GAS não permitida para este perfil." });
    }

    const currentLogin = await callGas("loginSeguro", [req.session.email], 90000);
    if (!currentLogin?.ok || !currentLogin?.user) {
      return res.status(401).json({ ok: false, message: "Usuário da sessão não está mais ativo." });
    }

    const trustedUser = currentLogin.user;
    let args;
    if (fn === "getInfoInicial") args = [req.session.email];
    else if (["getLeadTimeReport", "getHistoricoOperacional"].includes(fn)) args = [trustedUser, incomingArgs[1] || {}];
    else if (["gerarRelatorioCSV", "exportFinanceCSV"].includes(fn)) args = [incomingArgs[0] || {}, trustedUser];
    else args = [];

    const result = await callGas(fn, args, 90000);
    res.json({
      ok: true,
      action: fn,
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
    if (!isAdmin(req.session)) {
      return res.status(403).json({ ok: false, message: "Sincronização restrita ao administrador." });
    }
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


// ===============================
// API PÚBLICA — LANDING PAGES
// ===============================

app.get("/api/public/lojas", validarLandingApiKey, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, nome, cidade, endereco, ativo
      FROM lojas
      WHERE ativo = true
      ORDER BY nome ASC
    `);

    res.json({
      ok: true,
      lojas: result.rows.map((l) => ({
        id: l.id,
        nome: l.nome,
        slug: clean(l.nome).toLowerCase()
          .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
        cidade: l.cidade,
        endereco: l.endereco
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao listar lojas.", error: error.message });
  }
});

app.get("/api/public/optometristas", validarLandingApiKey, async (req, res) => {
  try {
    const loja = normalizeLojaPublica(req.query.loja || "");

    if (!loja) {
      return res.status(400).json({ ok: false, message: "Informe a loja." });
    }

    const result = await pool.query(`
      SELECT id, nome, loja
      FROM optometristas
      WHERE ativo = true AND LOWER(loja) = LOWER($1)
      ORDER BY nome ASC
    `, [loja]);

    res.json({ ok: true, loja, optometristas: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao listar optometristas.", error: error.message });
  }
});

app.get("/api/public/horarios-disponiveis", validarLandingApiKey, async (req, res) => {
  const client = await pool.connect();

  try {
    const loja = normalizeLojaPublica(req.query.loja || "");
    const data = toPgDate(req.query.data || req.query.data_agendamento || "");
    const optometristaPreferido = clean(req.query.optometrista || "");

    if (!loja) {
      return res.status(400).json({ ok: false, message: "Informe a loja." });
    }

    if (!data) {
      return res.status(400).json({ ok: false, message: "Informe uma data válida." });
    }

    let horariosBase = gerarHorariosBase(data);

    // Unidade Santos/Gonzaga tem almoço 14:00-14:30 em dias úteis (seg-sex)
    const diaRef = new Date(data + "T12:00:00").getDay();
    const lojaKey = loja.toLowerCase().replace(/[^a-z]/g, "");
    const isGonzagaSantos = lojaKey.includes("gonzaga") || lojaKey.includes("santos");
    if (isGonzagaSantos && diaRef >= 1 && diaRef <= 5) {
      horariosBase = horariosBase.filter(h => h !== "14:00" && h !== "14:30");
    }

    if (!horariosBase.length) {
      return res.json({
        ok: true,
        loja,
        data,
        horarios: [],
        message: "Não há horários disponíveis para esta data."
      });
    }

    const optometristas = await buscarOptometristasAtivosPorLoja(client, loja);
    const candidatos = optometristaPreferido
      ? [optometristaPreferido, ...optometristas.filter((o) => o.toLowerCase() !== optometristaPreferido.toLowerCase())]
      : optometristas;

    const listaOptos = candidatos.length ? candidatos : ["A definir"];
    const horarios = [];

    for (const horario of horariosBase) {
      let optometristaLivre = "";

      for (const optometrista of listaOptos) {
        const ocupado = await client.query(
          `SELECT id
           FROM agendamentos
           WHERE LOWER(REGEXP_REPLACE(COALESCE(loja,''), '\\s*-\\s*', ' ', 'g')) = LOWER(REGEXP_REPLACE($1, '\\s*-\\s*', ' ', 'g'))
             AND LOWER(COALESCE(optometrista,'')) = LOWER($2)
             AND data_agendamento = $3
             AND horario = $4
             AND status = ANY($5::text[])
             AND excluido_em IS NULL
           LIMIT 1`,
          [loja, optometrista, data, horario, PUBLIC_BLOCKING_STATUSES]
        );

        if (!ocupado.rows.length) {
          optometristaLivre = optometrista;
          break;
        }
      }

      horarios.push({
        horario,
        disponivel: !!optometristaLivre,
        optometrista: optometristaLivre || null
      });
    }

    res.json({ ok: true, loja, data, horarios });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao buscar horários disponíveis.", error: error.message });
  } finally {
    client.release();
  }
});

app.post("/api/public/agendamentos", validarLandingApiKey, async (req, res) => {
  const client = await pool.connect();

  try {
    const b = req.body || {};

    const nome = clean(b.nome || b.nomeCompleto);
    const whatsapp = normalizeWhatsappPublico(b.whatsapp || b.whatsApp || b.telefone || b.tel);
    const email = clean(b.email);
    const loja = normalizeLojaPublica(b.loja);
    const dataAgendamento = toPgDate(b.data_agendamento || b.dataAgendamento || b.data);
    const horario = clean(b.horario || b.hor || b.periodo || "A definir");
    const origem = clean(b.origem || "Landing Page");
    const status = clean(b.status || b.statusAgenda || "Agendado");
    const observacao = montarObservacaoPublica(b, req);
    const accessTags = clean(b.access_tags || b.accessTags || "origem:site;origem:trafego-pago;fluxo:pendente-confirmacao");
    const campanha = clean(b.campanha || "");
    const landingPage = clean(b.landing_page || b.landingPage || "");

    if (!nome || nome.length < 3) {
      return res.status(400).json({ ok: false, message: "Nome completo é obrigatório." });
    }

    if (!whatsapp || whatsapp.length < 10) {
      return res.status(400).json({ ok: false, message: "WhatsApp válido é obrigatório." });
    }

    if (!loja) {
      return res.status(400).json({ ok: false, message: "Loja é obrigatória." });
    }

    if (!dataAgendamento) {
      return res.status(400).json({ ok: false, message: "Data do agendamento é obrigatória." });
    }

    const regraHorario = horarioValidoPorRegra(dataAgendamento, horario);
    if (!regraHorario.ok) {
      return res.status(400).json(regraHorario);
    }

    // Unidade Santos/Gonzaga: almoço 14:00-14:30 em dias úteis
    if (horario === "14:00" || horario === "14:30") {
      const lojaKeyPost = loja.toLowerCase().replace(/[^a-z]/g, "");
      if (lojaKeyPost.includes("gonzaga") || lojaKeyPost.includes("santos")) {
        const diaPost = new Date(dataAgendamento + "T12:00:00").getDay();
        if (diaPost >= 1 && diaPost <= 5) {
          return res.status(400).json({ ok: false, message: "Horário de almoço não disponível para esta unidade." });
        }
      }
    }

    await client.query("BEGIN");

    const optometrista = /^\d{2}:\d{2}$/.test(horario)
      ? await buscarPrimeiroOptometristaLivre(client, loja, dataAgendamento, horario, b.optometrista)
      : clean(b.optometrista || "A definir");

    if (!optometrista) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        ok: false,
        message: "Esse horário acabou de ser reservado. Escolha outro horário."
      });
    }

    if (/^\d{2}:\d{2}$/.test(horario)) {
      const conflito = await client.query(
        `SELECT id
         FROM agendamentos
         WHERE LOWER(REGEXP_REPLACE(COALESCE(loja,''), '\\s*-\\s*', ' ', 'g')) = LOWER(REGEXP_REPLACE($1, '\\s*-\\s*', ' ', 'g'))
           AND LOWER(COALESCE(optometrista,'')) = LOWER($2)
           AND data_agendamento = $3
           AND horario = $4
           AND status = ANY($5::text[])
           AND excluido_em IS NULL
         LIMIT 1`,
        [loja, optometrista, dataAgendamento, horario, PUBLIC_BLOCKING_STATUSES]
      );

      if (conflito.rows.length) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: "Esse horário acabou de ser reservado. Escolha outro horário."
        });
      }
    }

    const clienteGasId = makeGasId("cliente", (whatsapp || email || nome).toLowerCase());

    const cliente = await client.query(
      `INSERT INTO clientes (gas_id, nome, whatsapp, email, origem, loja_origem, observacoes, origem_sync, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'landing_page',CURRENT_TIMESTAMP)
       ON CONFLICT (gas_id) DO UPDATE SET
         nome = EXCLUDED.nome,
         whatsapp = EXCLUDED.whatsapp,
         email = EXCLUDED.email,
         origem = EXCLUDED.origem,
         loja_origem = EXCLUDED.loja_origem,
         observacoes = EXCLUDED.observacoes,
         origem_sync = 'landing_page',
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING id`,
      [clienteGasId, nome, whatsapp, email || null, origem, loja, observacao]
    );

    const gasId = clean(b.gas_id) || makeGasId(
      "lp",
      stableHash({
        nome,
        whatsapp,
        loja,
        dataAgendamento,
        horario,
        campanha,
        landingPage,
        ts: Date.now()
      })
    );

    const agendamento = await client.query(
      `INSERT INTO agendamentos (
        gas_id, nome, whatsapp, email, loja, optometrista, origem,
        data_agendamento, horario, observacao, status, compareceu,
        responsavel, criado_por_email, proprietario_id, proprietario_nome,
        access_tags, origem_sync, criado_em, atualizado_em
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,
        $8,$9,$10,$11,'Pendente',
        'Landing Page','landingpage@sistema.local','landing-page','Landing Page',
        $12,'landing_page',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
      )
      RETURNING *`,
      [
        gasId,
        nome,
        whatsapp,
        email || null,
        loja,
        optometrista,
        origem,
        dataAgendamento,
        horario,
        observacao,
        status,
        accessTags
      ]
    );

    await client.query(
      `INSERT INTO logs_sistema (tipo, origem, mensagem, detalhes)
       VALUES ('landing_page','api_public','Agendamento recebido pela landing page',$1)`,
      [JSON.stringify({
        agendamento_id: agendamento.rows[0].id,
        cliente_id: cliente.rows[0].id,
        loja,
        data_agendamento: dataAgendamento,
        horario,
        optometrista,
        campanha,
        landing_page: landingPage,
        ip: req.ip
      })]
    );

    await client.query("COMMIT");

    res.status(201).json({
      ok: true,
      message: "Agendamento criado com sucesso.",
      id: agendamento.rows[0].id,
      agendamentoId: agendamento.rows[0].id,
      agendamento: agendamento.rows[0],
      cliente_id: cliente.rows[0].id
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);

    if (String(error.message || "").includes("uniq_agendamento_ativo_slot")) {
      return res.status(409).json({
        ok: false,
        message: "Esse horário acabou de ser reservado. Escolha outro horário."
      });
    }

    console.error("Erro em /api/public/agendamentos:", error);

    res.status(500).json({
      ok: false,
      message: "Erro ao criar agendamento pela landing page.",
      error: error.message
    });
  } finally {
    client.release();
  }
});

app.post("/api/agendamentos", async (req, res) => {
  try {
    const b = req.body || {};
    if (!hasRole(req.session, ["admin", "atendimento central", "gerente de loja", "consultor de vendas", "vendedor", "comprador"])) {
      return res.status(403).json({ ok: false, message: "Perfil sem permissão para criar agendamentos." });
    }
    if (!ensureStoreAccess(req.session, b.loja)) {
      return res.status(403).json({ ok: false, message: "Sem permissão para operar esta loja." });
    }
    const nomeCliente = clean(b.nome || b.nomeCompleto || b.NomeCompleto);
    if (!nomeCliente) return res.status(400).json({ ok: false, message: "Nome do cliente é obrigatório." });
    if (nomeCliente.toLowerCase().includes("teste")) return res.status(400).json({ ok: false, message: "Não é permitido cadastrar cliente com nome TESTE." });

    const actorNome = clean(req.session.nome || "Usuário autenticado");
    const actorEmail = clean(req.session.email);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.audit_managed', 'true', true)`);
      const result = await client.query(
        `INSERT INTO agendamentos (
        gas_id, nome, whatsapp, email, loja, optometrista, origem,
        data_agendamento, horario, observacao, status, compareceu,
        responsavel, criado_por_email, proprietario_id, proprietario_nome,
        agendado_por_nome, agendado_por_email, vendedor_atendeu_nome, vendedor_atendeu_email,
        ultima_alteracao_por_nome, ultima_alteracao_por_email, ultima_alteracao_em,
        access_tags, origem_sync
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,CURRENT_TIMESTAMP,$23,'postgres')
        RETURNING *`,
        [
        b.gas_id || null,
        nomeCliente,
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
        actorNome,
        actorEmail || null,
        b.proprietario_id || b.proprietarioId || null,
        b.proprietario_nome || b.proprietarioNome || actorNome,
        actorNome,
        actorEmail || null,
        b.vendedor_atendeu_nome || b.vendedorAtendeuNome || b.vendedor_nome || b.vendedorNome || b.consultor_responsavel || null,
        b.vendedor_atendeu_email || null,
        actorNome,
        actorEmail || null,
        b.access_tags || b.accessTags || null
        ]
      );
      await saveAppointmentBackup(client, {
        action: "CRIACAO",
        after: result.rows[0],
        session: req.session
      });
      await client.query("COMMIT");
      res.json({ ok: true, message: "Agendamento salvo no PostgreSQL.", agendamento: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao salvar agendamento.", error: error.message });
  }
});

app.get("/api/agendamentos", async (req, res) => {
  try {
    const result = canViewAllStores(req.session)
      ? await pool.query(`SELECT * FROM agendamentos WHERE excluido_em IS NULL ORDER BY id DESC LIMIT 1000`)
      : req.session.loja
        ? await pool.query(`SELECT * FROM agendamentos WHERE excluido_em IS NULL AND ${storeSql("loja")} ORDER BY id DESC LIMIT 1000`, [req.session.loja])
        : { rows: [] };
    res.json({ ok: true, total: result.rows.length, agendamentos: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch("/api/agendamentos/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const current = await pool.query(`SELECT * FROM agendamentos WHERE id = $1`, [id]);
    if (!current.rows.length) return res.status(404).json({ ok: false, message: "Agendamento não encontrado." });
    if (!ensureStoreAccess(req.session, current.rows[0].loja)) {
      return res.status(403).json({ ok: false, message: "Sem permissão para operar esta loja." });
    }
    if (b.loja && !ensureStoreAccess(req.session, b.loja)) {
      return res.status(403).json({ ok: false, message: "Sem permissão para mover o registro para esta loja." });
    }
    if (!hasRole(req.session, ["admin", "atendimento central", "gerente de loja", "consultor de vendas", "vendedor", "comprador", "optometrista"])) {
      return res.status(403).json({ ok: false, message: "Perfil sem permissão para alterar agendamentos." });
    }
    if ((b.excluir_lead || b.restaurar_lead) && !isAdmin(req.session)) {
      return res.status(403).json({ ok: false, message: "Apenas admin pode mover leads para a lixeira." });
    }
    if (roleOf(req.session) === "optometrista") {
      const allowed = new Set([
        "compareceu", "status", "statusAgenda", "atendimento_realizado", "atendimentoRealizado",
        "observacao", "ultima_alteracao_por_nome", "ultima_alteracao_por_email", "ultima_alteracao_em"
      ]);
      const forbidden = Object.keys(b).filter((key) => !allowed.has(key));
      if (forbidden.length) {
        return res.status(403).json({ ok: false, message: "Optometrista só pode atualizar presença, status e observação." });
      }
    }
    if (["consultor de vendas", "vendedor"].includes(roleOf(req.session))) {
      const blocked = [
        "numero_os", "numeroOS", "status_os", "statusOS", "valor_venda", "valorVenda", "desconto",
        "vendedor_nome", "vendedorNome", "data_abertura_os", "dataAberturaOS", "data_entrada_os",
        "dataEntradaOS", "data_finalizacao_os", "dataFinalizacaoOS", "data_entrega_os", "dataEntregaOS"
      ];
      if (blocked.some((key) => Object.prototype.hasOwnProperty.call(b, key))) {
        return res.status(403).json({ ok: false, message: "Este perfil não pode alterar OS ou valores financeiros." });
      }
    }
    if (String(b.nome || b.nomeCompleto || "").toLowerCase().includes("teste")) {
      return res.status(400).json({ ok: false, message: "Não é permitido cadastrar cliente com nome TESTE." });
    }
    const actorNome = clean(req.session.nome || "Usuário autenticado");
    const actorEmail = clean(req.session.email);

    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.audit_managed', 'true', true)`);
      result = await client.query(
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
        vendedor_atendeu_nome = COALESCE($17, vendedor_atendeu_nome),
        vendedor_atendeu_email = COALESCE($18, vendedor_atendeu_email),
        data_abertura_os = COALESCE($24, data_abertura_os),
        data_entrada_os = COALESCE($25, data_entrada_os),
        data_finalizacao_os = COALESCE($26, data_finalizacao_os),
        data_entrega_os = COALESCE($27, data_entrega_os),
        agendado_por_nome = COALESCE(NULLIF(agendado_por_nome,''), $19, agendado_por_nome),
        agendado_por_email = COALESCE(NULLIF(agendado_por_email,''), $20, agendado_por_email),
        ultima_alteracao_por_nome = $21,
        ultima_alteracao_por_email = $22,
        ultima_alteracao_em = CURRENT_TIMESTAMP,
        excluido_em = CASE WHEN $28::text = 'LIXEIRA' THEN CURRENT_TIMESTAMP WHEN $28::text = 'RESTAURAR' THEN NULL ELSE excluido_em END,
        atualizado_em = CURRENT_TIMESTAMP
      WHERE id = $23
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
        (v => (v === '' || v === undefined || v === null) ? null : v)(b.valor_venda !== undefined ? b.valor_venda : b.valorVenda),
        (v => (v === '' || v === undefined || v === null) ? null : v)(b.desconto),
        b.vendedor_atendeu_nome || b.vendedorAtendeuNome || b.vendedor_nome || b.vendedorNome || b.consultor_responsavel || null,
        b.vendedor_atendeu_email || null,
        actorNome,
        actorEmail || null,
        actorNome,
        actorEmail || null,
        id,
        b.data_abertura_os || b.dataAberturaOS || null,
        b.data_entrada_os || b.dataEntradaOS || null,
        b.data_finalizacao_os || b.dataFinalizacaoOS || null,
        b.data_entrega_os || b.dataEntregaOS || null,
        b.excluir_lead ? 'LIXEIRA' : (b.restaurar_lead ? 'RESTAURAR' : null)
        ]
      );
      if (!result.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ ok: false, message: "Agendamento não encontrado." });
      }
      await saveAppointmentBackup(client, {
        action: "ALTERACAO",
        before: current.rows[0],
        after: result.rows[0],
        session: req.session
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    res.json({ ok: true, agendamento: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/lixeira", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, whatsapp, email, loja, status, status_os, data_agendamento,
              ultima_alteracao_por_nome, excluido_em
       FROM agendamentos WHERE excluido_em IS NOT NULL ORDER BY excluido_em DESC LIMIT 500`
    );
    res.json({ ok: true, agendamentos: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.delete("/api/agendamentos/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query('SELECT id, excluido_em FROM agendamentos WHERE id = $1', [id]);
    if (!check.rows.length) return res.status(404).json({ ok: false, message: "Agendamento não encontrado." });
    if (!check.rows[0].excluido_em) {
      return res.status(400).json({ ok: false, message: "Mova o lead para a lixeira antes de excluir permanentemente." });
    }
    await pool.query('DELETE FROM agendamentos WHERE id = $1', [id]);
    res.json({ ok: true, message: "Lead excluído permanentemente." });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao excluir lead.", error: error.message });
  }
});

app.get("/api/lead-time", async (req, res) => {
  try {
    if (!hasRole(req.session, ["admin", "atendimento central", "gerente de loja"])) {
      return res.status(403).json({ ok: false, message: "Acesso restrito." });
    }
    const scoped = !canViewAllStores(req.session);
    const whereStore = scoped && req.session.loja ? `AND ${storeSql("loja")}` : '';
    const params = scoped && req.session.loja ? [req.session.loja] : [];
    const result = await pool.query(
      `SELECT id, nome AS cliente_nome, loja, vendedor_nome, numero_os,
              data_abertura_os, data_finalizacao_os,
              (data_finalizacao_os - data_abertura_os) AS lead_time_dias
       FROM agendamentos
       WHERE excluido_em IS NULL
         AND data_abertura_os IS NOT NULL AND data_finalizacao_os IS NOT NULL
         ${whereStore}
       ORDER BY data_finalizacao_os DESC LIMIT 500`,
      params
    );
    const rows = result.rows;
    const total = rows.length;
    const media = total > 0 ? rows.reduce((s, r) => s + (Number(r.lead_time_dias) || 0), 0) / total : 0;
    res.json({ ok: true, rows, mediaLeadTime: media.toFixed(1), totalLinhas: total });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/clientes", async (req, res) => {
  try {
    const b = req.body || {};
    if (!hasRole(req.session, ["admin", "atendimento central", "gerente de loja", "consultor de vendas", "vendedor", "comprador"])) {
      return res.status(403).json({ ok: false, message: "Perfil sem permissão para cadastrar clientes." });
    }
    if (!ensureStoreAccess(req.session, b.loja_origem || req.session.loja)) {
      return res.status(403).json({ ok: false, message: "Sem permissão para operar esta loja." });
    }
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
    const result = canViewAllStores(req.session)
      ? await pool.query(`SELECT * FROM clientes ORDER BY id DESC LIMIT 1000`)
      : req.session.loja
        ? await pool.query(`SELECT * FROM clientes WHERE LOWER(COALESCE(loja_origem,'')) = LOWER($1) ORDER BY id DESC LIMIT 1000`, [req.session.loja])
        : { rows: [] };
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
    let loja = clean(req.query.loja || "");
    if (!canViewAllStores(req.session)) {
      if (loja && !ensureStoreAccess(req.session, loja)) {
        return res.status(403).json({ ok: false, message: "Sem permissão para consultar esta loja." });
      }
      loja = clean(req.session.loja);
    }
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
    if (!canViewFinanceSession(req.session)) {
      return res.status(403).json({ ok: false, message: "Perfil sem acesso ao financeiro." });
    }
    const b = req.body || {};
    if (!ensureStoreAccess(req.session, b.loja || req.session.loja)) {
      return res.status(403).json({ ok: false, message: "Sem permissão para operar esta loja." });
    }
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
    if (!canViewFinanceSession(req.session)) {
      return res.status(403).json({ ok: false, message: "Perfil sem acesso ao financeiro." });
    }
    const query = `SELECT id, id AS agendamento_id, nome AS cliente_nome, numero_os, status_os, loja,
        COALESCE(NULLIF(vendedor_nome, ''), NULLIF(consultor_responsavel, ''), NULLIF(vendedor_atendeu_nome, ''), proprietario_nome, responsavel, '') AS vendedor,
        COALESCE(valor_venda, 0)::numeric AS valor_total, COALESCE(desconto, 0)::numeric AS desconto,
        CASE WHEN COALESCE(valor_venda, 0) > 0 THEN 'Venda registrada' ELSE 'Sem venda' END AS status_pagamento,
        COALESCE(data_finalizacao_os, data_entrega_os, data_entrada_os, data_agendamento, criado_em::date) AS data_venda
      FROM agendamentos
      WHERE nome NOT ILIKE '%teste%' AND COALESCE(loja, '') NOT ILIKE '%teste%'
        AND (COALESCE(valor_venda, 0) > 0 OR COALESCE(desconto, 0) > 0)
        ${canViewAllStores(req.session) ? "" : `AND ${storeSql("loja")}`}
      ORDER BY COALESCE(data_finalizacao_os, data_entrega_os, data_entrada_os, data_agendamento, criado_em::date) DESC, id DESC LIMIT 1000`;
    const result = canViewAllStores(req.session)
      ? await pool.query(query)
      : req.session.loja
        ? await pool.query(query, [req.session.loja])
        : { rows: [] };
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


app.get("/api/usuarios", requireAdmin, async (req, res) => {
  try {
    const todos = req.query.todos === 'true';
    const result = await pool.query(`
      SELECT id, gas_id, nome, email, cargo, loja, access_tags, can_view_finance, ativo,
             criado_em, atualizado_em
      FROM usuarios
      ${todos ? '' : 'WHERE ativo = true'}
      ORDER BY loja ASC, nome ASC
      LIMIT 1000
    `);
    res.json({ ok: true, usuarios: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/usuarios", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const nome = clean(b.nome);
    const email = clean(b.email).toLowerCase();
    const cargo = clean(b.cargo);
    const password = String(b.password || b.senha || "");
    if (!nome || !email || !cargo) {
      return res.status(400).json({ ok: false, message: "Nome, e-mail e perfil são obrigatórios." });
    }
    if (password && password.length < 12) {
      return res.status(400).json({ ok: false, message: "A senha deve ter pelo menos 12 caracteres." });
    }
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const gasId = makeGasId("usuario", email);
    const result = await pool.query(
      `INSERT INTO usuarios (gas_id, nome, email, senha, cargo, loja, can_view_finance, ativo, origem_sync, password_changed_at, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'postgres',CASE WHEN $4::text IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,CURRENT_TIMESTAMP)
       ON CONFLICT (email) DO UPDATE SET
         nome = EXCLUDED.nome,
         senha = COALESCE(EXCLUDED.senha, usuarios.senha),
         cargo = EXCLUDED.cargo,
         loja = EXCLUDED.loja,
         can_view_finance = EXCLUDED.can_view_finance,
         ativo = EXCLUDED.ativo,
         origem_sync = 'postgres',
         password_changed_at = CASE WHEN EXCLUDED.senha IS NULL THEN usuarios.password_changed_at ELSE CURRENT_TIMESTAMP END,
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING id, gas_id, nome, email, cargo, loja, access_tags, can_view_finance, ativo, criado_em, atualizado_em`,
      [gasId, nome, email, passwordHash, cargo, b.loja || null, !!b.can_view_finance, b.ativo !== false]
    );
    res.json({ ok: true, message: "Usuário salvo com sucesso.", usuario: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ ok: false, message: "E-mail já cadastrado no sistema." });
    }
    res.status(500).json({ ok: false, message: "Erro ao salvar usuário.", error: error.message });
  }
});

app.patch("/api/usuarios/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const b = req.body || {};
    const password = String(b.password || b.senha || "");
    if (password && password.length < 12) {
      return res.status(400).json({ ok: false, message: "A senha deve ter pelo menos 12 caracteres." });
    }
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    const result = await pool.query(
      `UPDATE usuarios SET
        nome = COALESCE($1, nome),
        cargo = COALESCE($2, cargo),
        loja = COALESCE($3, loja),
        can_view_finance = COALESCE($4, can_view_finance),
        ativo = COALESCE($5, ativo),
        senha = COALESCE($6, senha),
        password_changed_at = CASE WHEN $6::text IS NULL THEN password_changed_at ELSE CURRENT_TIMESTAMP END,
        atualizado_em = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING id, gas_id, nome, email, cargo, loja, access_tags, can_view_finance, ativo, criado_em, atualizado_em`,
      [
        b.nome ? clean(b.nome) : null,
        b.cargo ? clean(b.cargo) : null,
        b.loja !== undefined ? (b.loja || null) : null,
        b.can_view_finance !== undefined ? !!b.can_view_finance : null,
        b.ativo !== undefined ? !!b.ativo : null,
        passwordHash,
        id
      ]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, message: "Usuário não encontrado." });
    res.json({ ok: true, message: "Usuário atualizado.", usuario: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao atualizar usuário.", error: error.message });
  }
});

app.delete("/api/usuarios/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await pool.query('SELECT id, email FROM usuarios WHERE id = $1', [id]);
    if (!check.rows.length) return res.status(404).json({ ok: false, message: "Usuário não encontrado." });
    if (check.rows[0].email === (req.session && req.session.email)) {
      return res.status(400).json({ ok: false, message: "Você não pode excluir sua própria conta." });
    }
    await pool.query('DELETE FROM usuarios WHERE id = $1', [id]);
    res.json({ ok: true, message: "Usuário excluído com sucesso." });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao excluir usuário.", error: error.message });
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

app.get("/api/historico-agendamentos", async (req, res) => {
  try {
    if (!hasRole(req.session, ["admin", "gerente de loja"])) {
      return res.status(403).json({ ok: false, message: "Histórico restrito à administração e gerência." });
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 250), 1), 1000);
    const scoped = !canViewAllStores(req.session);
    const result = scoped && !req.session.loja
      ? { rows: [] }
      : await pool.query(
        `SELECT id, agendamento_id, loja, cliente_nome, acao,
                feito_por_nome, feito_por_email, feito_por_perfil, feito_por_loja,
                registro_anterior, registro_novo, criado_em
         FROM historico_alteracoes_agendamentos
         ${scoped ? `WHERE ${storeSql("loja")}` : ""}
         ORDER BY criado_em DESC, id DESC
         LIMIT ${limit}`,
        scoped ? [req.session.loja] : []
      );
    res.json({ ok: true, total: result.rows.length, historicos: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar histórico.", error: error.message });
  }
});


app.get("/api/dashboard", async (req, res) => {
  try {
    const scoped = !canViewAllStores(req.session);
    if (scoped && !req.session.loja) {
      return res.json({
        ok: true,
        dashboard: { total_clientes: 0, total_agendamentos: 0, total_vendas: 0, faturamento_total: 0, desconto_total: 0 }
      });
    }
    const params = scoped ? [req.session.loja] : [];
    const clientes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM clientes
       WHERE nome NOT ILIKE '%teste%'
       ${scoped ? `AND ${storeSql("loja_origem")}` : ""}`,
      params
    );
    const resumo = await pool.query(`
      SELECT
        COUNT(*)::int AS total_agendamentos,
        COUNT(*) FILTER (WHERE COALESCE(valor_venda,0) > 0)::int AS os_com_valor,
        COALESCE(SUM(valor_venda),0)::numeric AS faturamento_total,
        COALESCE(SUM(desconto),0)::numeric AS desconto_total
      FROM agendamentos
      WHERE nome NOT ILIKE '%teste%' AND COALESCE(loja,'') NOT ILIKE '%teste%'
      ${scoped ? `AND ${storeSql("loja")}` : ""}
    `, params);
    const showFinance = canViewFinanceSession(req.session);
    res.json({
      ok: true,
      dashboard: {
        total_clientes: clientes.rows[0].total,
        total_agendamentos: resumo.rows[0].total_agendamentos,
        total_vendas: showFinance ? resumo.rows[0].os_com_valor : 0,
        faturamento_total: showFinance ? resumo.rows[0].faturamento_total : 0,
        desconto_total: showFinance ? resumo.rows[0].desconto_total : 0
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
      "GET /api/public/lojas",
      "GET /api/public/optometristas",
      "GET /api/public/horarios-disponiveis",
      "POST /api/public/agendamentos",
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

async function startServer() {
  await initDatabase();
  return new Promise((resolve) => {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Sistema rodando na porta ${PORT}`);
      console.log("PostgreSQL conectado e tabelas verificadas.");
      console.log("GAS configurado:", !!GAS_URL);
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Erro ao iniciar banco:", error);
    process.exit(1);
  });
}

module.exports = {
  app,
  pool,
  startServer,
  signSession,
  verifySession,
  requireSession,
  buildPermissions,
  publicUser
};
