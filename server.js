const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config();

const { startRecoveryCron } = require("./kommo/recovery");
const { startReminderCron } = require("./kommo/reminder");

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

// Rotas públicas (landing pages) — abertas para qualquer origem, protegidas por API Key
app.use('/api/public', cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Landing-API-Key']
}));

// Rotas privadas — restritas às origens autorizadas
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
app.use(require("./kommo/salesbot"));
app.use(require("./kommo/webhook"));
const negociacaoRoutes = require("./negociacao-routes");
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

// ===============================
// SEGURANÇA — INTEGRAÇÃO DE ANÚNCIOS (AdAnalyzer / fase2)
// ===============================

const ADANALYZER_SYNC_KEY = process.env.ADANALYZER_SYNC_KEY || "";
const FASE2_API_KEY = process.env.FASE2_API_KEY || "";

function validarAdAnalyzerKey(req, res, next) {
  const recebida = req.headers["x-api-key"] || "";
  if (!ADANALYZER_SYNC_KEY) {
    return res.status(500).json({ ok: false, message: "ADANALYZER_SYNC_KEY não configurada no Railway." });
  }
  if (!safeEqual(recebida, ADANALYZER_SYNC_KEY)) {
    return res.status(401).json({ ok: false, message: "Chave de sincronismo inválida." });
  }
  next();
}

// Aceita sessão de usuário logado (github-sistema) OU a chave do fase2 (server-to-server)
function requireSessionOuFase2Key(req, res, next) {
  const recebida = req.headers["x-api-key"] || "";
  if (FASE2_API_KEY && safeEqual(recebida, FASE2_API_KEY)) {
    req.session = { perfil: "admin", loja: "" }; // chamada server-to-server vê todas as lojas
    return next();
  }
  return requireSession(req, res, next);
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

  // Datas com encerramento antecipado — todas as lojas
  const ENCERRAMENTO_ANTECIPADO = { "2026-06-29": 12 * 60 + 30 };
  if (ENCERRAMENTO_ANTECIPADO[dt] !== undefined && minutos > ENCERRAMENTO_ANTECIPADO[dt]) {
    return { ok: false, message: "Neste dia o atendimento encerra às 13:00. Escolha um horário até 12:30." };
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

  // Encerramento antecipado em datas especiais — todas as lojas
  const ENCERRAMENTO_ANTECIPADO = { "2026-06-29": 12 * 60 + 30 }; // último slot: 12:30
  if (ENCERRAMENTO_ANTECIPADO[dt] !== undefined) {
    const corte = ENCERRAMENTO_ANTECIPADO[dt];
    return horarios.filter(h => {
      const [hh2, mm2] = h.split(":").map(Number);
      return hh2 * 60 + mm2 <= corte;
    });
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

  await negociacaoRoutes.initNegociacaoTables(pool);
  await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS lembrete_24h_em TIMESTAMPTZ`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kommo_bot_states (
      lead_id    TEXT PRIMARY KEY,
      state      JSONB        NOT NULL,
      etapa      TEXT,
      loja       TEXT,
      bot_active BOOLEAN      DEFAULT false,
      updated_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kommo_bot_states_updated ON kommo_bot_states(updated_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_kommo_bot_states_etapa   ON kommo_bot_states(etapa);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS desempenho_anuncios (
      id SERIAL PRIMARY KEY,
      loja TEXT,
      categoria TEXT,
      data_referencia DATE NOT NULL,
      plataforma TEXT NOT NULL DEFAULT 'meta',
      spend NUMERIC(12,2) DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      actions INTEGER DEFAULT 0,
      ctr NUMERIC(6,2) DEFAULT 0,
      cpc NUMERIC(10,4) DEFAULT 0,
      cpa NUMERIC(10,4) DEFAULT 0,
      criado_em TIMESTAMPTZ DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Índice único por expressão: loja/categoria podem ser NULL (linhas "Multi Lojas"/"Outros"),
  // e o Postgres não deduplica NULLs numa UNIQUE comum — por isso usamos COALESCE aqui,
  // permitindo reenviar o mesmo dia (upsert) sem duplicar.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_desempenho_anuncios
    ON desempenho_anuncios (COALESCE(loja,''), COALESCE(categoria,''), data_referencia, plataforma);
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_desempenho_anuncios_data ON desempenho_anuncios(data_referencia);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_desempenho_anuncios_loja ON desempenho_anuncios(loja);`);
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
        kommoHealth: true,
        kommoWebhook: true,
        salesbot: true,
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

    // Verifica bloqueio administrativo (ex: falta de optometrista)
    const bloqueio = await client.query(
      `SELECT motivo FROM bloqueios_disponibilidade
       WHERE LOWER(loja) = LOWER($1) AND data = $2 LIMIT 1`,
      [loja, data]
    ).catch(() => ({ rows: [] }));
    if (bloqueio.rows.length) {
      return res.json({
        ok: true, loja, data, horarios: [],
        message: `Sem disponibilidade nesta data. ${bloqueio.rows[0].motivo || ""}`.trim(),
        bloqueado: true,
      });
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
      // Sync não-bloqueante para o Kommo
      setImmediate(() => sincronizarAgendamentoKommo(result.rows[0]));
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
    const q = req.query;
    const params = [];
    const conditions = ["excluido_em IS NULL"];

    // Loja: session-enforced for store-scoped roles; query param only for admin/central
    if (!canViewAllStores(req.session)) {
      if (!req.session.loja) return res.json({ ok: true, total: 0, agendamentos: [] });
      params.push(req.session.loja);
      conditions.push(storeSql("loja", `$${params.length}`));
    } else if (q.loja) {
      params.push(q.loja);
      conditions.push(storeSql("loja", `$${params.length}`));
    }

    // Date range — push to SQL so records beyond LIMIT are reachable
    const periodoDias = Number(q.periodoDias || 0);
    let dataDe = String(q.de || q.dataDe || "").trim();
    let dataAte = String(q.ate || q.dataAte || "").trim();

    if (periodoDias > 0 && !dataDe && !dataAte) {
      const hoje = new Date().toISOString().slice(0, 10);
      const inicio = new Date(hoje + "T12:00:00");
      inicio.setDate(inicio.getDate() - (periodoDias - 1));
      dataDe = inicio.toISOString().slice(0, 10);
      dataAte = hoje;
    }

    if (dataDe) { params.push(dataDe); conditions.push(`data_agendamento >= $${params.length}`); }
    if (dataAte) { params.push(dataAte); conditions.push(`data_agendamento <= $${params.length}`); }

    if (q.status) { params.push(q.status); conditions.push(`LOWER(COALESCE(status,'')) = LOWER($${params.length})`); }
    if (q.statusOS) { params.push(q.statusOS); conditions.push(`LOWER(COALESCE(status_os,'')) = LOWER($${params.length})`); }

    // Sem filtro de data: LIMIT 1000 (carga inicial rápida). Com filtro: até 5000.
    const temFiltroData = !!(dataDe || dataAte);
    const limite = Math.min(Number(q.limit || 0) || (temFiltroData ? 5000 : 1000), 5000);

    const result = await pool.query(
      `SELECT * FROM agendamentos WHERE ${conditions.join(" AND ")} ORDER BY id DESC LIMIT ${limite}`,
      params
    );
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
    // Restaurar da lixeira: somente admin
    if (b.restaurar_lead && !isAdmin(req.session)) {
      return res.status(403).json({ ok: false, message: "Apenas admin pode restaurar leads da lixeira." });
    }
    // Soft delete: admin, atendimento central e gerente de loja (só da própria loja — já verificado acima)
    if (b.excluir_lead && !hasRole(req.session, ["admin", "atendimento central", "gerente de loja"])) {
      return res.status(403).json({ ok: false, message: "Sem permissão para excluir este agendamento." });
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

    // ── Notificações automáticas de resultado de visita ──────────────────────
    setImmediate(async () => {
      try {
        const before = current.rows[0];
        const after  = result.rows[0];
        const nc = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
        const bComp = nc(before.compareceu);
        const aComp = nc(after.compareceu);

        const dtBR = v => {
          if (!v) return '';
          const s = String(v).slice(0, 10).split('-');
          return s.length === 3 ? s[2]+'/'+s[1]+'/'+s[0] : String(v).slice(0,10);
        };

        // "Não compareceu" — transição para Não (evita duplicata por agendamento)
        if (aComp === 'nao' && bComp !== 'nao') {
          await pool.query(`
            INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios)
            SELECT 'nao_compareceu', $1, $2, $3, $4
            WHERE NOT EXISTS (
              SELECT 1 FROM notificacoes WHERE agendamento_id = $3 AND tipo = 'nao_compareceu'
            )
          `, [
            'Não compareceu — ' + after.nome,
            (after.nome || '?') + ' não compareceu ao agendamento de ' + dtBR(after.data_agendamento) +
              ' às ' + (after.horario || '') + ' | Loja: ' + (after.loja || '?') + '.',
            after.id,
            ['admin', 'atendimento central', 'gerente de loja', after.loja || ''].filter(Boolean)
          ]);
        }

        // "Compareceu sem compra" — compareceu=Sim e sem OS/valor
        if (aComp === 'sim' && bComp !== 'sim') {
          const temVenda = Number(after.valor_venda || 0) > 0 || after.numero_os;
          if (!temVenda) {
            await pool.query(`
              INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios)
              SELECT 'sem_compra', $1, $2, $3, $4
              WHERE NOT EXISTS (
                SELECT 1 FROM notificacoes WHERE agendamento_id = $3 AND tipo = 'sem_compra'
              )
            `, [
              'Compareceu sem compra — ' + after.nome,
              (after.nome || '?') + ' compareceu em ' + dtBR(after.data_agendamento) +
                ' mas não houve venda registrada. | Loja: ' + (after.loja || '?') + '.',
              after.id,
              ['admin', 'atendimento central', 'gerente de loja', after.loja || ''].filter(Boolean)
            ]);
          }
        }
      } catch (nErr) {
        console.error('[notif-visita]', nErr.message);
      }
    });

    // Auto-resolução de notificações quando situação é corrigida
    setImmediate(async () => {
      try {
        const after = result.rows[0];
        const nc3 = v => String(v||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
        const aComp = nc3(after.compareceu);
        const aSt   = nc3(after.status);

        // "Não compareceu" resolvido → reagendou ou marcou compareceu=Sim
        if (aComp === 'sim' || aComp === 'pendente' || ['agendado','confirmado'].includes(aSt)) {
          await pool.query(
            `DELETE FROM notificacoes WHERE agendamento_id = $1 AND tipo = 'nao_compareceu'`,
            [after.id]
          );
        }

        // "Compareceu sem compra" resolvido → OS aberta ou venda registrada
        if (Number(after.valor_venda || 0) > 0 || (after.numero_os && after.numero_os !== '')) {
          await pool.query(
            `DELETE FROM notificacoes WHERE agendamento_id = $1 AND tipo = 'sem_compra'`,
            [after.id]
          );
        }
      } catch (_) {}
    });

    // Nota no Kommo sobre mudanças relevantes
    setImmediate(async () => {
      try {
        const before = current.rows[0];
        const after  = result.rows[0];
        const leadId = after.kommo_lead_id;

        // Se não tem lead vinculado e tem WhatsApp, tenta vincular agora
        if (!leadId && after.whatsapp) { await sincronizarAgendamentoKommo(after); return; }
        if (!leadId) return;

        const mudancas = [];
        if (before.status !== after.status) mudancas.push(`Status: ${before.status || '—'} → ${after.status || '—'}`);
        const nc2 = v => String(v||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
        if (nc2(before.compareceu) !== nc2(after.compareceu)) mudancas.push(`Compareceu: ${before.compareceu || '—'} → ${after.compareceu || '—'}`);
        if (!before.numero_os && after.numero_os) mudancas.push(`OS aberta: ${after.numero_os}`);
        if (before.status_os !== after.status_os && after.status_os) mudancas.push(`Status OS: ${after.status_os}`);
        if (before.data_agendamento !== after.data_agendamento || before.horario !== after.horario)
          mudancas.push(`Reagendado: ${dtBR(after.data_agendamento)} às ${after.horario || ''}`);

        if (!mudancas.length) return;
        await adicionarNotaKommo(leadId, `📋 Atualização — ${after.nome || ''}:\n` + mudancas.map(m => `• ${m}`).join('\n'));
      } catch (_) {}
    });

    res.json({ ok: true, agendamento: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Gera notificações retroativas para agendamentos existentes com resultado de visita
app.post("/api/admin/notificacoes/gerar-retroativo", requireAdmin, async (req, res) => {
  try {
    const nc = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim();
    const dtBR = v => {
      if (!v) return '';
      const s = String(v).slice(0,10).split('-');
      return s.length === 3 ? s[2]+'/'+s[1]+'/'+s[0] : String(v).slice(0,10);
    };

    const trl = col => `TRANSLATE(LOWER(TRIM(COALESCE(${col},''))),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')`;

    // Não compareceu — sem notificação ainda
    const naoComp = await pool.query(`
      SELECT a.id, a.nome, a.data_agendamento, a.horario, a.loja
      FROM agendamentos a
      WHERE a.excluido_em IS NULL
        AND (${trl('a.compareceu')} = 'nao' OR LOWER(a.status) ILIKE '%nao comparec%')
        AND NOT EXISTS (SELECT 1 FROM notificacoes n WHERE n.agendamento_id = a.id AND n.tipo = 'nao_compareceu')
      ORDER BY a.data_agendamento DESC
      LIMIT 500
    `);

    // Compareceu sem compra — sem notificação ainda
    const semCompra = await pool.query(`
      SELECT a.id, a.nome, a.data_agendamento, a.horario, a.loja
      FROM agendamentos a
      WHERE a.excluido_em IS NULL
        AND ${trl('a.compareceu')} = 'sim'
        AND COALESCE(a.valor_venda, 0) = 0
        AND (a.numero_os IS NULL OR a.numero_os = '')
        AND NOT EXISTS (SELECT 1 FROM notificacoes n WHERE n.agendamento_id = a.id AND n.tipo = 'sem_compra')
      ORDER BY a.data_agendamento DESC
      LIMIT 500
    `);

    let criadas = 0;
    for (const r of naoComp.rows) {
      await pool.query(
        `INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios) VALUES ($1,$2,$3,$4,$5)`,
        ['nao_compareceu', 'Não compareceu — ' + r.nome,
         (r.nome||'?') + ' não compareceu ao agendamento de ' + dtBR(r.data_agendamento) + ' às ' + (r.horario||'') + ' | Loja: ' + (r.loja||'?') + '.',
         r.id, ['admin', 'atendimento central', 'gerente de loja', r.loja || ''].filter(Boolean)]
      ).catch(() => null);
      criadas++;
    }
    for (const r of semCompra.rows) {
      await pool.query(
        `INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios) VALUES ($1,$2,$3,$4,$5)`,
        ['sem_compra', 'Compareceu sem compra — ' + r.nome,
         (r.nome||'?') + ' compareceu em ' + dtBR(r.data_agendamento) + ' mas não houve venda registrada. | Loja: ' + (r.loja||'?') + '.',
         r.id, ['admin', 'atendimento central', 'gerente de loja', r.loja || ''].filter(Boolean)]
      ).catch(() => null);
      criadas++;
    }

    res.json({ ok: true, criadas, nao_compareceu: naoComp.rows.length, sem_compra: semCompra.rows.length });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
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
        COALESCE(NULLIF(proprietario_nome, ''), NULLIF(agendado_por_nome, ''), NULLIF(responsavel, ''), '') AS proprietario_nome,
        COALESCE(valor_venda, 0)::numeric AS valor_total, COALESCE(desconto, 0)::numeric AS desconto,
        CASE WHEN COALESCE(valor_venda, 0) > 0 THEN 'Venda registrada' ELSE 'Sem venda' END AS status_pagamento,
        COALESCE(data_finalizacao_os, data_entrega_os, data_entrada_os, data_agendamento, criado_em::date) AS data_venda
      FROM agendamentos
      WHERE excluido_em IS NULL
        AND nome NOT ILIKE '%teste%' AND COALESCE(loja, '') NOT ILIKE '%teste%'
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


app.get("/api/usuarios", requireSession, async (req, res) => {
  try {
    const role = roleOf(req.session);
    const isAdminOrCentral = hasRole(req.session, ["admin", "atendimento central"]);
    const todos = isAdminOrCentral && req.query.todos === 'true';

    let query, params;
    if (isAdminOrCentral) {
      query = `
        SELECT id, gas_id, nome, email, cargo, loja, access_tags, can_view_finance, ativo,
               criado_em, atualizado_em
        FROM usuarios
        ${todos ? '' : 'WHERE ativo = true'}
        ORDER BY loja ASC, nome ASC
        LIMIT 1000
      `;
      params = [];
    } else if (hasRole(req.session, ["gerente de loja", "comprador", "consultor de vendas", "vendedor"])) {
      // Perfis de loja: retorna somente usuários ativos da própria loja
      const loja = req.session.loja;
      if (!loja) return res.json({ ok: true, usuarios: [] });
      query = `
        SELECT id, gas_id, nome, cargo, loja, ativo
        FROM usuarios
        WHERE ativo = true AND ${storeSql("loja")}
        ORDER BY nome ASC
        LIMIT 200
      `;
      params = [loja];
    } else {
      return res.json({ ok: true, usuarios: [] });
    }

    const result = await pool.query(query, params);
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

    const pagina  = Math.max(1, parseInt(req.query.pagina || 1));
    const limite  = Math.min(Math.max(Number(req.query.limite || req.query.limit || 80), 1), 500);
    const offset  = (pagina - 1) * limite;
    const scoped  = !canViewAllStores(req.session);

    if (scoped && !req.session.loja) {
      return res.json({ ok: true, total: 0, pagina, limite, historicos: [] });
    }

    const conds  = ["acao != 'BACKUP_INICIAL'"];
    const params = [];

    if (scoped) {
      params.push(req.session.loja);
      conds.push(storeSql("loja", `$${params.length}`));
    }
    if (req.query.acao) {
      params.push(req.query.acao);
      conds.push(`acao = $${params.length}`);
    }
    if (req.query.perfil) {
      params.push(req.query.perfil.toLowerCase());
      conds.push(`LOWER(COALESCE(feito_por_perfil,'')) = $${params.length}`);
    }
    if (req.query.dataDe) {
      params.push(req.query.dataDe);
      conds.push(`criado_em::date >= $${params.length}::date`);
    }
    if (req.query.dataAte) {
      params.push(req.query.dataAte);
      conds.push(`criado_em::date <= $${params.length}::date`);
    }

    const where = `WHERE ${conds.join(" AND ")}`;

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM historico_alteracoes_agendamentos ${where}`,
      params
    );

    params.push(limite, offset);
    const result = await pool.query(
      `SELECT id, agendamento_id, loja, cliente_nome, acao,
              feito_por_nome, feito_por_email, feito_por_perfil, feito_por_loja,
              registro_anterior, registro_novo, criado_em
       FROM historico_alteracoes_agendamentos ${where}
       ORDER BY criado_em DESC, id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ ok: true, total: countRes.rows[0].total, pagina, limite, historicos: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar histórico.", error: error.message });
  }
});


app.get("/api/dashboard/kommo", requireSession, async (req, res) => {
  if (!canViewAllStores(req.session)) {
    return res.json({ ok: true, kommo: { leads_hoje: 0, leads_7d: 0, tempo_medio_resposta_min: null } });
  }
  try {
    const kommoClient = require('./kommo/client');
    const agora = Math.floor(Date.now() / 1000);
    const meiaNoit = new Date(); meiaNoit.setHours(0, 0, 0, 0);
    const inicioHoje = Math.floor(meiaNoit.getTime() / 1000);
    const inicio7d = agora - 7 * 86400;

    const [resHoje, res7d, resTalks] = await Promise.all([
      kommoClient.request('GET', `/leads?filter[created_at][from]=${inicioHoje}&filter[created_at][to]=${agora}&limit=500`).catch(() => null),
      kommoClient.request('GET', `/leads?filter[created_at][from]=${inicio7d}&filter[created_at][to]=${agora}&limit=500`).catch(() => null),
      kommoClient.request('GET', `/talks?limit=15&order[id]=desc`).catch(() => null)
    ]);

    const leads_hoje = resHoje?._total_items ?? (resHoje?._embedded?.leads?.length ?? 0);
    const leads_7d   = res7d?._total_items  ?? (res7d?._embedded?.leads?.length  ?? 0);

    let tempo_medio_resposta_min = null;
    const talks = resTalks?._embedded?.talks || [];
    if (talks.length > 0) {
      let totalMin = 0, count = 0;
      for (const talk of talks.slice(0, 8)) {
        try {
          const resMsgs = await kommoClient.request('GET', `/talks/${talk.id}/messages?limit=50`).catch(() => null);
          const msgs = (resMsgs?._embedded?.messages || [])
            .slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
          let firstIn = null, firstOut = null;
          for (const m of msgs) {
            const tp = (m.type || '').toLowerCase();
            const authorType = ((m.author || {}).type || '').toLowerCase();
            const isIn  = tp === 'incoming' || tp === 'inbound'  || authorType === 'contact';
            const isOut = tp === 'outgoing' || tp === 'outbound' || authorType === 'user';
            if (!firstIn && isIn) firstIn = m;
            if (firstIn && !firstOut && isOut && m.created_at > firstIn.created_at) firstOut = m;
          }
          if (firstIn && firstOut) {
            const diff = Math.round((firstOut.created_at - firstIn.created_at) / 60);
            if (diff >= 0 && diff < 1440) { totalMin += diff; count++; }
          }
        } catch (_) { /* pula esta talk */ }
      }
      if (count > 0) tempo_medio_resposta_min = Math.round(totalMin / count);
    }

    res.json({ ok: true, kommo: { leads_hoje, leads_7d, tempo_medio_resposta_min } });
  } catch (e) {
    console.error('[dashboard/kommo]', e.message);
    res.json({ ok: true, kommo: null, warning: e.message });
  }
});

// ── Helpers Kommo ──────────────────────────────────────────────────────────────
function normalizarTelefoneKommo(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  let num = digits.startsWith('55') ? digits.slice(2) : digits;
  // Normaliza 11→10 dígitos (remove o 9 após DDD para unificar duplicatas de WhatsApp Cloud/Lite)
  if (num.length === 11 && num[2] === '9') num = num.slice(0, 2) + num.slice(3);
  return num.length >= 8 ? num : '';
}

async function obterTodosContatosKommo(kommoClient) {
  const todos = [];
  let page = 1;
  while (true) {
    const data = await kommoClient.request('GET', `/contacts?limit=250&page=${page}&with=leads`).catch(() => null);
    const lista = data?._embedded?.contacts || [];
    todos.push(...lista);
    if (lista.length < 250 || page >= 20) break;
    page++;
  }
  return todos;
}

// ── GET /api/admin/kommo/diagnostico ─────────────────────────────────────────
// Mostra: duplicatas, leads novos com mensagem, tempo médio de resposta
app.get("/api/admin/kommo/diagnostico", requireAdmin, async (req, res) => {
  try {
    const kommoClient = require('./kommo/client');
    const agora = Math.floor(Date.now() / 1000);
    const inicio7d = agora - 7 * 86400;
    const inicio30d = agora - 30 * 86400;

    // 1. Buscar contatos e detectar duplicatas por telefone
    const contatos = await obterTodosKommo(kommoClient);
    const mapaFone = {};
    for (const c of contatos) {
      const phones = (c.custom_fields_values || [])
        .find(f => f.field_code === 'PHONE')?.values?.map(v => normalizarTelefoneKommo(v.value)) || [];
      for (const ph of phones) {
        if (!ph) continue;
        if (!mapaFone[ph]) mapaFone[ph] = [];
        mapaFone[ph].push({ id: c.id, nome: c.name || '(sem nome)', leads: c._embedded?.leads?.length || 0, criado_em: c.created_at });
      }
    }
    const duplicatas = Object.entries(mapaFone)
      .filter(([, cs]) => cs.length > 1)
      .map(([fone, cs]) => ({ fone, contatos: cs.sort((a, b) => b.leads - a.leads) }));

    // 2. Leads novos com mensagem (7 e 30 dias)
    const [leadsNovos7d, leadsNovos30d, talksRecentes] = await Promise.all([
      kommoClient.request('GET', `/leads?filter[created_at][from]=${inicio7d}&filter[created_at][to]=${agora}&limit=500`).catch(() => null),
      kommoClient.request('GET', `/leads?filter[created_at][from]=${inicio30d}&filter[created_at][to]=${agora}&limit=500`).catch(() => null),
      kommoClient.request('GET', `/talks?limit=250&order[id]=desc`).catch(() => null)
    ]);

    const ids7d  = new Set((leadsNovos7d?._embedded?.leads  || []).map(l => String(l.id)));
    const ids30d = new Set((leadsNovos30d?._embedded?.leads || []).map(l => String(l.id)));
    const idsComTalk = new Set((talksRecentes?._embedded?.talks || [])
      .map(t => String(t.entity_id || t.lead_id || '')).filter(Boolean));

    const leadsComMensagem7d  = [...ids7d ].filter(id => idsComTalk.has(id)).length;
    const leadsComMensagem30d = [...ids30d].filter(id => idsComTalk.has(id)).length;

    // 3. Tempo médio de primeira resposta (amostra das últimas 10 talks)
    const talks = talksRecentes?._embedded?.talks || [];
    let totalMin = 0, countResp = 0;
    for (const talk of talks.slice(0, 10)) {
      try {
        const resMsgs = await kommoClient.request('GET', `/talks/${talk.id}/messages?limit=50`).catch(() => null);
        const msgs = (resMsgs?._embedded?.messages || [])
          .slice().sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        let firstIn = null, firstOut = null;
        for (const m of msgs) {
          const tp = (m.type || '').toLowerCase();
          const atp = ((m.author || {}).type || '').toLowerCase();
          const isIn  = tp === 'incoming' || tp === 'inbound'  || atp === 'contact';
          const isOut = tp === 'outgoing' || tp === 'outbound' || atp === 'user';
          if (!firstIn && isIn) firstIn = m;
          if (firstIn && !firstOut && isOut && m.created_at > firstIn.created_at) firstOut = m;
        }
        if (firstIn && firstOut) {
          const diff = Math.round((firstOut.created_at - firstIn.created_at) / 60);
          if (diff >= 0 && diff < 1440) { totalMin += diff; countResp++; }
        }
      } catch (_) {}
    }
    const tempo_medio_resposta_min = countResp > 0 ? Math.round(totalMin / countResp) : null;

    res.json({
      ok: true,
      total_contatos: contatos.length,
      duplicatas: {
        total_grupos: duplicatas.length,
        total_extras: duplicatas.reduce((s, d) => s + d.contatos.length - 1, 0),
        grupos: duplicatas.slice(0, 50)
      },
      leads_com_mensagem: {
        '7d':  leadsComMensagem7d,
        '30d': leadsComMensagem30d,
        total_novos_7d:  ids7d.size,
        total_novos_30d: ids30d.size
      },
      tempo_medio_resposta_min
    });
  } catch (e) {
    console.error('[kommo/diagnostico]', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

async function obterTodosKommo(kommoClient) {
  const todos = [];
  let page = 1;
  while (true) {
    const data = await kommoClient.request('GET', `/contacts?limit=250&page=${page}&with=leads`).catch(() => null);
    const lista = data?._embedded?.contacts || [];
    todos.push(...lista);
    if (lista.length < 250 || page >= 20) break;
    page++;
  }
  return todos;
}

// ── POST /api/admin/kommo/dedup ───────────────────────────────────────────────
// Mescla contatos duplicados: move leads para o contato principal e exclui os extras
app.post("/api/admin/kommo/dedup", requireAdmin, async (req, res) => {
  try {
    const kommoClient = require('./kommo/client');
    const contatos = await obterTodosKommo(kommoClient);
    const mapaFone = {};
    for (const c of contatos) {
      const phones = (c.custom_fields_values || [])
        .find(f => f.field_code === 'PHONE')?.values?.map(v => normalizarTelefoneKommo(v.value)) || [];
      for (const ph of phones) {
        if (!ph) continue;
        if (!mapaFone[ph]) mapaFone[ph] = [];
        mapaFone[ph].push(c);
      }
    }
    const grupos = Object.values(mapaFone).filter(cs => cs.length > 1);

    let mesclados = 0, erros = 0;
    const log = [];

    for (const grupo of grupos) {
      // Principal = quem tem mais leads; empate = criado antes
      const ordenado = grupo.slice().sort((a, b) => {
        const la = a._embedded?.leads?.length || 0;
        const lb = b._embedded?.leads?.length || 0;
        if (lb !== la) return lb - la;
        return (a.created_at || 0) - (b.created_at || 0);
      });
      const principal = ordenado[0];
      const extras = ordenado.slice(1);

      for (const dup of extras) {
        try {
          // Mover leads do duplicado para o principal
          const leadsDosDup = dup._embedded?.leads || [];
          for (const lead of leadsDosDup) {
            await kommoClient.request('PATCH', `/leads/${lead.id}`, {
              _embedded: { contacts: [{ id: principal.id, is_main: true }] }
            }).catch(() => null);
          }
          // Excluir contato duplicado (só funciona se ficar vazio)
          await kommoClient.request('DELETE', `/contacts`, [{ id: dup.id }]).catch(() => null);
          log.push({ acao: 'mesclado', duplicata_id: dup.id, duplicata_nome: dup.name, principal_id: principal.id, leads_movidos: leadsDosDup.length });
          mesclados++;
        } catch (e) {
          erros++;
          log.push({ acao: 'erro', duplicata_id: dup.id, erro: e.message });
        }
      }
    }

    res.json({ ok: true, grupos_processados: grupos.length, contatos_mesclados: mesclados, erros, log: log.slice(0, 100) });
  } catch (e) {
    console.error('[kommo/dedup]', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/admin/kommo/inspect ─────────────────────────────────────────────
// Inspeciona a configuração real do Kommo: pipelines, estágios, webhooks, leads recentes
app.get("/api/admin/kommo/inspect", requireAdmin, async (req, res) => {
  try {
    const kommoClient = require('./kommo/client');
    const PIPELINE_TARGET = 9511355;

    const [pipelinesData, webhooksData, leadsData] = await Promise.all([
      kommoClient.request('GET', '/leads/pipelines?with=statuses').catch(() => null),
      kommoClient.request('GET', '/webhooks').catch(() => null),
      kommoClient.request('GET', `/leads?filter[pipeline_id]=${PIPELINE_TARGET}&limit=5&order[id]=desc&with=contacts,tags,notes`).catch(() => null),
    ]);

    const pipelines = (pipelinesData?._embedded?.pipelines || [])
      .filter(p => [9907903, 12931092, 12931096, 9511355].includes(p.id))
      .map(p => ({
        id: p.id, nome: p.name,
        estagios: (p._embedded?.statuses || [])
          .map(s => ({ id: s.id, nome: s.name, sort: s.sort, tipo: s.type }))
          .sort((a, b) => a.sort - b.sort)
      }));

    const webhooks = (webhooksData?._embedded?.hooks || []).map(h => ({
      id: h.id, url: h.destination, eventos: h.settings
    }));

    const leadsRecentes = (leadsData?._embedded?.leads || []).map(l => ({
      id: l.id,
      nome: l.name,
      status_id: l.status_id,
      pipeline_id: l.pipeline_id,
      tags: (l._embedded?.tags || []).map(t => t.name),
      ultima_nota: (l._embedded?.notes || [])
        .filter(n => n.note_type === 'service_message')
        .sort((a, b) => b.id - a.id)[0]?.params?.text?.slice(0, 200) || null
    }));

    res.json({ ok: true, pipelines, webhooks, leads_recentes_target: leadsRecentes });
  } catch (e) {
    console.error('[kommo/inspect]', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/admin/kommo/bot-states ──────────────────────────────────────────
// Lista os estados do bot salvos no PostgreSQL — útil para debug
app.get("/api/admin/kommo/bot-states", requireAdmin, async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  || 50), 200);
    const etapa  = clean(req.query.etapa  || "");
    const loja   = clean(req.query.loja   || "");
    const leadId = clean(req.query.lead_id || "");

    const conditions = [];
    const params = [];

    if (leadId) { conditions.push(`lead_id = $${params.length + 1}`); params.push(leadId); }
    if (etapa)  { conditions.push(`etapa   = $${params.length + 1}`); params.push(etapa); }
    if (loja)   { conditions.push(`loja ILIKE $${params.length + 1}`); params.push(`%${loja}%`); }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const r = await pool.query(
      `SELECT lead_id, etapa, loja, bot_active, updated_at,
              state->>'nome'       AS nome,
              state->>'talk_id'    AS talk_id,
              state->>'aguardando' AS aguardando
       FROM kommo_bot_states
       ${where}
       ORDER BY updated_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    const totais = await pool.query(`
      SELECT etapa, COUNT(*)::int AS total
      FROM kommo_bot_states
      GROUP BY etapa ORDER BY total DESC
    `);

    res.json({
      ok: true,
      total: r.rowCount,
      por_etapa: totais.rows,
      states: r.rows,
    });
  } catch (e) {
    console.error("[admin/kommo/bot-states]", e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── GET /api/admin/kommo/pipelines ────────────────────────────────────────────
// Retorna todos os pipelines do Kommo com seus estágios atuais
// Diagnóstico: mostra os valores exatos de loja em usuarios e agendamentos
app.get("/api/admin/diag/loja-mismatch", requireAdmin, async (req, res) => {
  try {
    // Valores distintos de loja em agendamentos
    const ag = await pool.query(`
      SELECT COALESCE(loja,'(null)') AS loja, COUNT(*)::int AS total
      FROM agendamentos WHERE excluido_em IS NULL
      GROUP BY loja ORDER BY total DESC LIMIT 30
    `);
    // Valores de loja dos usuários
    const us = await pool.query(`
      SELECT nome, cargo, COALESCE(loja,'(null)') AS loja, ativo
      FROM usuarios ORDER BY loja, nome LIMIT 100
    `);
    // Lojas cadastradas
    const lj = await pool.query(`SELECT nome, ativo FROM lojas ORDER BY nome`);

    // Para cada usuário de loja, verifica quantos agendamentos ele veria
    const checks = [];
    for (const u of us.rows) {
      if (['admin','atendimento central'].includes(u.cargo)) continue;
      if (!u.loja || u.loja === '(null)') continue;
      const r = await pool.query(`
        SELECT COUNT(*)::int AS total FROM agendamentos
        WHERE excluido_em IS NULL
          AND TRANSLATE(LOWER(TRIM(COALESCE(loja,''))),
            'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')
            = TRANSLATE(LOWER(TRIM($1)),
            'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')
      `, [u.loja]);
      checks.push({ usuario: u.nome, cargo: u.cargo, loja_session: u.loja, agendamentos_visiveis: r.rows[0].total });
    }

    res.json({
      ok: true,
      lojas_cadastradas: lj.rows,
      lojas_em_agendamentos: ag.rows,
      usuarios_e_visibilidade: checks
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/api/admin/kommo/pipelines", requireAdmin, async (req, res) => {
  try {
    const kommoClient = require('./kommo/client');
    const data = await kommoClient.request('GET', '/leads/pipelines?with=statuses');
    const pipelines = data?._embedded?.pipelines || [];

    const PIPELINE_IDS = [9907903, 12931092, 12931096, 9511355];
    const resultado = pipelines
      .filter(p => PIPELINE_IDS.includes(p.id))
      .map(p => ({
        id: p.id,
        nome: p.name,
        estagios: (p._embedded?.statuses || [])
          .filter(s => s.type !== 'win' && s.type !== 'lose')
          .map(s => ({ id: s.id, nome: s.name, sort: s.sort, cor: s.color }))
          .sort((a, b) => a.sort - b.sort)
      }));

    res.json({ ok: true, pipelines: resultado });
  } catch (e) {
    console.error('[kommo/pipelines]', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── POST /api/admin/kommo/setup-stages ───────────────────────────────────────
// Cria os estágios padrão do bot em todos os 4 pipelines e retorna o mapa de IDs
app.post("/api/admin/kommo/setup-stages", requireAdmin, async (req, res) => {
  try {
    const kommoClient = require('./kommo/client');

    const PIPELINES = {
      9907903:  'Gonzaga',
      12931092: 'Enseada',
      12931096: 'Pitangueiras',
      9511355:  'Ademar'
    };

    const ESTAGIOS_PADRAO = [
      { key: 'bot_ativo',    nome: '🤖 Bot Ativo',    sort: 10, cor: '#66BEB3' },
      { key: 'informacoes',  nome: 'ℹ️ Informações',  sort: 20, cor: '#FFCC33' },
      { key: 'agendamento',  nome: '📅 Agendamento',  sort: 30, cor: '#FF7E07' },
      { key: 'orcamento',    nome: '💰 Orçamento',    sort: 40, cor: '#4EB7ED' },
      { key: 'atendente',    nome: '👥 Atendente',    sort: 50, cor: '#9166FF' },
      { key: 'agendado',     nome: '✅ Agendado',     sort: 60, cor: '#FDCA55' },
      { key: 'recuperacao',  nome: '📞 Recuperação',  sort: 70, cor: '#832EB5' },
    ];

    const stagesMap = {};
    const log = [];

    for (const [pipelineId, nomeLoja] of Object.entries(PIPELINES)) {
      stagesMap[pipelineId] = {};

      // Busca estágios existentes
      let existentes = [];
      try {
        const d = await kommoClient.request('GET', `/leads/pipelines/${pipelineId}/statuses`);
        existentes = d?._embedded?.statuses || [];
      } catch (e) {
        log.push({ loja: nomeLoja, erro: `Não conseguiu buscar estágios: ${e.message}` });
        continue;
      }

      for (const estagio of ESTAGIOS_PADRAO) {
        // Verifica se já existe pelo nome
        const existente = existentes.find(s => s.name === estagio.nome);
        if (existente) {
          stagesMap[pipelineId][estagio.key] = existente.id;
          log.push({ loja: nomeLoja, estagio: estagio.key, acao: 'existente', id: existente.id });
          continue;
        }

        // Cria o estágio
        try {
          const criado = await kommoClient.request('POST', `/leads/pipelines/${pipelineId}/statuses`, [{
            name: estagio.nome,
            sort: estagio.sort,
            color: estagio.cor
          }]);
          const novo = criado?._embedded?.statuses?.[0];
          if (novo?.id) {
            stagesMap[pipelineId][estagio.key] = novo.id;
            log.push({ loja: nomeLoja, estagio: estagio.key, acao: 'criado', id: novo.id });
          }
        } catch (e) {
          log.push({ loja: nomeLoja, estagio: estagio.key, acao: 'erro', erro: e.message });
        }

        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Gera o env var KOMMO_STAGES_MAP pronto para copiar
    const envVar = `KOMMO_STAGES_MAP=${JSON.stringify(stagesMap)}`;

    res.json({ ok: true, stages_map: stagesMap, env_var: envVar, log });
  } catch (e) {
    console.error('[kommo/setup-stages]', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.post("/api/admin/kommo/update-stage-colors", requireAdmin, async (req, res) => {
  try {
    const kommoClient = require('./kommo/client');

    const PIPELINES = [9511355, 9907903, 12931092, 12931096];

    // Regras de cor por nome de etapa (normalizado, sem acentos, sem emoji, minúsculo)
    const COLOR_RULES = [
      { match: 'gerencia',                      color: '#ff6762' },
      { match: 'pos vendas',                    color: '#f4c449' },
      { match: 'informacoes',                   color: '#67d67c' },
      { match: 'informacao',                    color: '#67d67c' },
      { match: 'orcamento',                     color: '#4280f6' },
      { match: 'agendamento (teste de visao)',   color: '#53d5e0' },
      { match: 'agendamento noshow',             color: '#ff6762' },
      { match: 'exames realizados',              color: '#53d5e0' },
      { match: 'venda fechada',                  color: '#4280f6' },
      { match: 'leads quentes',                  color: '#67d67c' },
      { match: 'leads frios',                    color: '#f4c449' },
      { match: 'leads mortos',                   color: '#ff6762' },
    ];

    function normalize(str) {
      return String(str || '')
        .replace(/[\u{1F300}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/\s+/g, ' ').trim();
    }

    function findColor(stageName) {
      const norm = normalize(stageName);
      for (const rule of COLOR_RULES) {
        if (norm.includes(rule.match)) return rule.color;
      }
      return null;
    }

    const log = [];

    for (const pipelineId of PIPELINES) {
      let statuses = [];
      try {
        const d = await kommoClient.request('GET', `/leads/pipelines/${pipelineId}/statuses`);
        statuses = d?._embedded?.statuses || [];
      } catch (e) {
        log.push({ pipeline_id: pipelineId, erro: `Falha ao buscar etapas: ${e.message}` });
        continue;
      }

      for (const status of statuses) {
        // Ignora etapas fixas do Kommo (Ganhos/Perdidos têm ID especial)
        if (status.type === 'won' || status.type === 'lost') continue;

        const newColor = findColor(status.name);
        if (!newColor) {
          log.push({ pipeline_id: pipelineId, stage: status.name, acao: 'sem_regra' });
          continue;
        }

        try {
          await kommoClient.request('PATCH', `/leads/pipelines/${pipelineId}/statuses/${status.id}`, {
            color: newColor
          });
          log.push({ pipeline_id: pipelineId, stage: status.name, acao: 'atualizado', color: newColor });
        } catch (e) {
          log.push({ pipeline_id: pipelineId, stage: status.name, acao: 'erro', erro: e.message });
        }

        await new Promise(r => setTimeout(r, 250));
      }
    }

    const atualizados = log.filter(l => l.acao === 'atualizado').length;
    const erros       = log.filter(l => l.acao === 'erro').length;
    res.json({ ok: true, atualizados, erros, log });
  } catch (e) {
    console.error('[kommo/update-stage-colors]', e.message);
    res.status(500).json({ ok: false, message: e.message });
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
       WHERE nome NOT ILIKE '%teste%' AND excluido_em IS NULL
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
      WHERE nome NOT ILIKE '%teste%' AND COALESCE(loja,'') NOT ILIKE '%teste%' AND excluido_em IS NULL
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

// ===============================
// DESEMPENHO DE ANÚNCIOS (Meta/Google Ads via AdAnalyzer)
// ===============================

const LOJAS_ANUNCIOS = [
  "óticas TGT - Gonzaga",
  "óticas TGT Enseada",
  "óticas TGT Pitangueiras",
  "óticas Target - Ademar de Barros"
];

function lojaAnunciosValida(loja) {
  return LOJAS_ANUNCIOS.find((l) => normalizeStoreKey(l) === normalizeStoreKey(loja)) || null;
}

// Recebe o push diário do AdAnalyzer (server-to-server, autenticado por chave própria)
app.post("/api/admin/ads-performance/sync", validarAdAnalyzerKey, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) {
    return res.status(400).json({ ok: false, error: "Nenhuma linha enviada." });
  }

  const salvas = [];
  for (const row of rows) {
    const dataReferencia = clean(row.data_referencia);
    if (!dataReferencia) {
      return res.status(400).json({ ok: false, error: "data_referencia é obrigatória em cada linha." });
    }

    let loja = null;
    if (row.loja) {
      loja = lojaAnunciosValida(row.loja);
      if (!loja) {
        return res.status(400).json({ ok: false, error: `Loja desconhecida: "${row.loja}".` });
      }
    } else if (!row.categoria) {
      return res.status(400).json({ ok: false, error: "Linha sem loja precisa informar categoria (ex.: Multi Lojas)." });
    }

    const result = await pool.query(
      `INSERT INTO desempenho_anuncios (
         loja, categoria, data_referencia, plataforma,
         spend, impressions, clicks, actions, ctr, cpc, cpa, atualizado_em
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (COALESCE(loja,''), COALESCE(categoria,''), data_referencia, plataforma)
       DO UPDATE SET
         spend = EXCLUDED.spend,
         impressions = EXCLUDED.impressions,
         clicks = EXCLUDED.clicks,
         actions = EXCLUDED.actions,
         ctr = EXCLUDED.ctr,
         cpc = EXCLUDED.cpc,
         cpa = EXCLUDED.cpa,
         atualizado_em = NOW()
       RETURNING id`,
      [
        loja,
        row.categoria || null,
        dataReferencia,
        clean(row.plataforma) || "meta",
        Number(row.spend || 0),
        Number(row.impressions || 0),
        Number(row.clicks || 0),
        Number(row.actions || 0),
        Number(row.ctr || 0),
        Number(row.cpc || 0),
        Number(row.cpa || 0)
      ]
    );
    salvas.push(result.rows[0].id);
  }

  res.json({ ok: true, salvas: salvas.length });
});

// Leitura para os dashboards (github-sistema e fase2) — sessão de usuário OU chave do fase2
app.get("/api/dashboard/ads-performance", requireSessionOuFase2Key, async (req, res) => {
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const start = clean(req.query.start) || hoje.slice(0, 8) + "01";
    const end = clean(req.query.end) || hoje;

    const scoped = !canViewAllStores(req.session);
    if (scoped && !req.session.loja) {
      return res.json({ ok: true, periodo: { start, end }, lojas: [], semLoja: [] });
    }

    const anuncios = await pool.query(
      `SELECT
         loja, categoria,
         COALESCE(SUM(spend),0)::numeric AS spend,
         COALESCE(SUM(impressions),0)::int AS impressions,
         COALESCE(SUM(clicks),0)::int AS clicks,
         COALESCE(SUM(actions),0)::int AS actions
       FROM desempenho_anuncios
       WHERE data_referencia BETWEEN $1 AND $2
       ${scoped ? `AND ${storeSql("loja", "$3")}` : ""}
       GROUP BY loja, categoria`,
      scoped ? [start, end, req.session.loja] : [start, end]
    );

    const showFinance = canViewFinanceSession(req.session);
    const faturamentoPorLoja = new Map();
    if (showFinance) {
      const params2 = scoped ? [start, end, req.session.loja] : [start, end];
      const faturamento = await pool.query(
        `SELECT loja, COALESCE(SUM(valor_venda),0)::numeric AS faturamento
         FROM agendamentos
         WHERE data_agendamento BETWEEN $1 AND $2
           AND nome NOT ILIKE '%teste%' AND excluido_em IS NULL
           ${scoped ? `AND ${storeSql("loja", "$3")}` : ""}
         GROUP BY loja`,
        params2
      );
      for (const row of faturamento.rows) {
        const lojaCanonica = lojaAnunciosValida(row.loja) || row.loja;
        faturamentoPorLoja.set(normalizeStoreKey(lojaCanonica), Number(row.faturamento));
      }
    }

    const lojas = [];
    const semLoja = [];
    for (const row of anuncios.rows) {
      const spend = Number(row.spend);
      const impressions = Number(row.impressions);
      const clicks = Number(row.clicks);
      const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
      const cpc = clicks > 0 ? Number((spend / clicks).toFixed(2)) : 0;

      if (!row.loja) {
        semLoja.push({ categoria: row.categoria, spend, impressions, clicks, actions: Number(row.actions), ctr, cpc });
        continue;
      }

      const faturamento = showFinance ? (faturamentoPorLoja.get(normalizeStoreKey(row.loja)) || 0) : 0;
      const roas = showFinance && spend > 0 ? Number((faturamento / spend).toFixed(2)) : null;

      lojas.push({
        loja: row.loja,
        spend,
        impressions,
        clicks,
        actions: Number(row.actions),
        ctr,
        cpc,
        faturamento: showFinance ? faturamento : 0,
        roas: showFinance ? roas : null
      });
    }

    res.json({ ok: true, periodo: { start, end }, lojas, semLoja });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar desempenho de anúncios.", error: error.message });
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
      "GET /api/dashboard",
      "GET /api/dashboard/ads-performance",
      "POST /api/admin/ads-performance/sync"
    ]
  });
});

negociacaoRoutes.registerRoutes(app, pool, { requireSession, canViewAllStores });

// ── Sincronização Sistema → Kommo ─────────────────────────────────────────────
const PIPELINE_POR_LOJA = {
  gonzaga:     9907903,
  enseada:     12931092,
  pitangueiras:12931096,
  ademar:      9511355
};

function resolverPipelineId(lojaStr) {
  if (!lojaStr) return null;
  const l = lojaStr.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (l.includes('gonzaga') || l.includes('santos')) return PIPELINE_POR_LOJA.gonzaga;
  if (l.includes('enseada'))                          return PIPELINE_POR_LOJA.enseada;
  if (l.includes('pitangueiras'))                     return PIPELINE_POR_LOJA.pitangueiras;
  if (l.includes('ademar') || l.includes('adhemar')) return PIPELINE_POR_LOJA.ademar;
  return null;
}

async function sincronizarAgendamentoKommo(ag) {
  try {
    const kommoClient = require('./kommo/client');
    if (!ag.whatsapp) return null;

    // 1. Buscar contato existente pelo WhatsApp
    let contact = await kommoClient.findContact(ag.whatsapp).catch(() => null);

    // 2. Se não existe, criar
    if (!contact?.id) {
      contact = await kommoClient.createContact({
        nome: ag.nome,
        whatsapp: ag.whatsapp,
        email: ag.email || ''
      }).catch(() => null);
    }
    if (!contact?.id) return null;

    // 3. Verificar se já tem lead ativo para não duplicar
    const contDetalhado = await kommoClient.request('GET', `/contacts/${contact.id}?with=leads`).catch(() => null);
    const leadsExistentes = contDetalhado?._embedded?.leads || [];

    let leadId = leadsExistentes.length > 0
      ? leadsExistentes[leadsExistentes.length - 1]?.id
      : null;

    // 4. Só cria lead novo se não havia nenhum
    if (!leadId) {
      const pipelineId = resolverPipelineId(ag.loja);
      const body = [{ name: `Agendamento — ${ag.nome}`, _embedded: { contacts: [{ id: contact.id }] }, ...(pipelineId ? { pipeline_id: pipelineId } : {}) }];
      const leadData = await kommoClient.request('POST', '/leads', body).catch(() => null);
      leadId = leadData?._embedded?.leads?.[0]?.id;
    }

    if (!leadId) return null;

    // 5. Nota com detalhes do agendamento
    const nota = [
      `📅 Agendamento registrado no sistema Óticas TGT:`,
      `• Cliente: ${ag.nome || ''}`,
      `• Data: ${dtBR(ag.data_agendamento)} às ${ag.horario || ''}`,
      `• Loja: ${ag.loja || ''}`,
      ag.optometrista ? `• Optometrista: ${ag.optometrista}` : '',
      `• Origem: ${ag.origem || 'Sistema'}`,
      ag.agendado_por_nome ? `• Agendado por: ${ag.agendado_por_nome}` : ''
    ].filter(Boolean).join('\n');
    await kommoClient.addNote(leadId, nota).catch(() => null);

    // 6. Gravar kommo_lead_id no agendamento
    await pool.query(`UPDATE agendamentos SET kommo_lead_id = $1 WHERE id = $2 AND (kommo_lead_id IS NULL OR kommo_lead_id = '')`,
      [String(leadId), ag.id]);

    console.log(`[kommo-sync] ✅ ag.id=${ag.id} → lead=${leadId} (contato=${contact.id})`);
    return leadId;
  } catch (e) {
    console.error(`[kommo-sync] ❌ ag.id=${ag && ag.id}:`, e.message);
    return null;
  }
}

async function adicionarNotaKommo(leadId, texto) {
  if (!leadId) return;
  try {
    const kommoClient = require('./kommo/client');
    await kommoClient.addNote(String(leadId), texto);
  } catch (e) {
    console.error('[kommo-nota]', e.message);
  }
}

// Sync retroativo: vincula agendamentos existentes sem kommo_lead_id ao Kommo
app.post('/api/admin/sync/agendamentos-para-kommo', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, nome, whatsapp, email, loja, optometrista, origem, data_agendamento, horario, agendado_por_nome
      FROM agendamentos
      WHERE (kommo_lead_id IS NULL OR kommo_lead_id = '')
        AND whatsapp IS NOT NULL AND whatsapp <> ''
        AND excluido_em IS NULL
      ORDER BY id DESC
      LIMIT 200
    `);
    let vinculados = 0, erros = 0;
    for (const ag of rows) {
      const leadId = await sincronizarAgendamentoKommo(ag);
      if (leadId) vinculados++; else erros++;
      await new Promise(r => setTimeout(r, 500)); // respeitar rate limit Kommo
    }
    res.json({ ok: true, total: rows.length, vinculados, erros });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

// ── Lembretes automáticos 24h antes do agendamento ───────────────────────────
const LOJAS_INFO = {
  gonzaga: {
    nome: 'Óticas TGT Santos',
    endereco: 'Av. Marechal Floriano Peixoto, 27 (Ao lado da Kallan) - Santos/SP',
    telefone: '(13) 99645-3111'
  },
  enseada: {
    nome: 'Óticas TGT Enseada',
    endereco: 'Av. Dom Pedro 1º, 1461 - Enseada (Em frente ao banco Itaú) - Guarujá/SP',
    telefone: '(13) 99721-4862'
  },
  pitangueiras: {
    nome: 'Óticas TGT Pitangueiras',
    endereco: 'Rua Montenegro, 69 - Pitangueiras, Centro - Guarujá/SP',
    telefone: '(13) 99704-0234'
  },
  ademar: {
    nome: 'Óticas Target Ademar de Barros',
    endereco: 'Av. Adhemar de Barros, 1450 (Ao lado da Sorridents) - Guarujá/SP',
    telefone: '(13) 99785-6493'
  }
};

function resolverInfoLoja(lojaStr) {
  if (!lojaStr) return null;
  const l = lojaStr.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (l.includes('gonzaga') || l.includes('santos')) return LOJAS_INFO.gonzaga;
  if (l.includes('enseada'))                          return LOJAS_INFO.enseada;
  if (l.includes('pitangueiras'))                     return LOJAS_INFO.pitangueiras;
  if (l.includes('ademar') || l.includes('adhemar')) return LOJAS_INFO.ademar;
  return null;
}

function dtBR(v) {
  if (!v) return '';
  const s = String(v).slice(0, 10).split('-');
  return s.length === 3 ? `${s[2]}/${s[1]}/${s[0]}` : String(v).slice(0, 10);
}

async function disparadorLembretes24h() {
  try {
    // Amanhã no fuso de Brasília (UTC-3)
    const brAmanha = new Date(Date.now() - 3 * 3600000);
    brAmanha.setDate(brAmanha.getDate() + 1);
    const amanhaStr = brAmanha.toISOString().slice(0, 10); // YYYY-MM-DD

    const { rows } = await pool.query(`
      SELECT id, nome, data_agendamento, horario, loja, kommo_lead_id
      FROM agendamentos
      WHERE data_agendamento::date = $1::date
        AND kommo_lead_id IS NOT NULL AND kommo_lead_id <> ''
        AND lembrete_24h_em IS NULL
        AND excluido_em IS NULL
        AND LOWER(COALESCE(status,'')) NOT ILIKE '%cancelad%'
        AND LOWER(COALESCE(compareceu,'')) NOT IN ('sim','nao','não')
    `, [amanhaStr]);

    if (!rows.length) {
      console.log(`[lembretes24h] Nenhum lembrete pendente para ${amanhaStr}.`);
      return { enviados: 0, erros: 0 };
    }

    console.log(`[lembretes24h] ${rows.length} agendamento(s) para ${amanhaStr} — iniciando disparos.`);
    const kommoClient = require('./kommo/client');
    let enviados = 0, erros = 0;

    for (const ag of rows) {
      const loja = resolverInfoLoja(ag.loja);
      const nome = (ag.nome || 'cliente').split(' ')[0]; // primeiro nome
      const linhas = [
        `Olá, *${nome}*! 😊`,
        '',
        `Passamos para lembrar do seu agendamento na *Óticas TGT* que está marcado para *amanhã*! ✅`,
        '',
        `📅 *Data:* ${dtBR(ag.data_agendamento)}`,
        `⏰ *Horário:* ${ag.horario || ''}`,
      ];
      if (loja) {
        linhas.push(`📍 *Endereço:* ${loja.endereco}`);
        linhas.push(`📞 *Telefone:* ${loja.telefone}`);
      }
      linhas.push('');
      linhas.push('Caso precise reagendar ou cancelar, é só nos chamar aqui pelo WhatsApp! 😊');
      linhas.push('');
      linhas.push('_Equipe Óticas TGT_ 🕶️');

      const mensagem = linhas.join('\n');

      try {
        await kommoClient.sendMessageToLead(String(ag.kommo_lead_id), mensagem);
        await pool.query(`UPDATE agendamentos SET lembrete_24h_em = NOW() WHERE id = $1`, [ag.id]);
        console.log(`[lembretes24h] ✅ Enviado para ${ag.nome} (id=${ag.id})`);
        enviados++;
      } catch (e) {
        console.error(`[lembretes24h] ❌ Erro no id=${ag.id} (${ag.nome}):`, e.message);
        erros++;
        // Marca mesmo com erro para não re-tentar em loop infinito
        await pool.query(`UPDATE agendamentos SET lembrete_24h_em = NOW() WHERE id = $1`, [ag.id]).catch(() => null);
      }

      // Pequena pausa para não sobrecarregar a API do Kommo
      await new Promise(r => setTimeout(r, 800));
    }

    console.log(`[lembretes24h] Concluído — ${enviados} enviados, ${erros} erros.`);
    return { enviados, erros };
  } catch (e) {
    console.error('[lembretes24h] Erro geral:', e.message);
    return { enviados: 0, erros: 1, mensagem: e.message };
  }
}

// Endpoint para disparar manualmente (admin)
app.post('/api/admin/lembretes/disparar', requireAdmin, async (req, res) => {
  const resultado = await disparadorLembretes24h();
  res.json({ ok: true, ...resultado });
});

async function startServer() {
  await initDatabase();
  startReminderCron();
  startRecoveryCron();
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
  startServer()
    .then(() => {
      // Disparar lembretes 45s após o boot, depois a cada hora
      setTimeout(() => {
        disparadorLembretes24h();
        setInterval(disparadorLembretes24h, 60 * 60 * 1000);
      }, 45000);
    })
    .catch((error) => {
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
