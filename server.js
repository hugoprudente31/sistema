const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config();

const { startRecoveryCron } = require("./kommo/recovery");
const { startReminderCron, runReminders, runTwoHourReminders, scheduleDaily } = require("./kommo/reminder");
const { startFollowupCron } = require("./kommo/followups");
const mailingboss = require("./mailingboss");
const kommoClient = require("./kommo/client");
const { jornadaPadrao, resolverJornadaLoja, estaOptometristaDisponivel, gerarSlotsJornada } = require("./lib/horarios");

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
// Sem build/hash de assets: todo o painel vive em public/index.html. Sem
// cache-control explicito, navegadores (e proxies corporativos) podem servir
// uma copia antiga da pagina indefinidamente apos um deploy, escondendo
// correcoes ja publicadas ate alguem dar um hard-refresh manual. Forcamos
// revalidacao sempre para os arquivos HTML.
if (fs.existsSync(publicPath)) {
  app.use(express.static(publicPath, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    }
  }));
}
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

// ===============================
// SEGURANÇA — INTEGRAÇÃO DE CAPTAÇÃO DE LEADS (captacao-leads-tgt)
// ===============================

const CAPTACAO_SYNC_KEY = process.env.CAPTACAO_SYNC_KEY || "";

function validarCaptacaoKey(req, res, next) {
  const recebida = req.headers["x-api-key"] || "";
  if (!CAPTACAO_SYNC_KEY) {
    return res.status(500).json({ ok: false, message: "CAPTACAO_SYNC_KEY não configurada no Railway." });
  }
  if (!safeEqual(recebida, CAPTACAO_SYNC_KEY)) {
    return res.status(401).json({ ok: false, message: "Chave de sincronismo inválida." });
  }
  next();
}

// ===============================
// SEGURANÇA — ALINHAMENTO DE LOJA (adanalyzer-os)
// ===============================
// Não é um caminho de dados novo: o adanalyzer-os continua lendo
// `agendamentos` direto pelo Postgres (SISTEMA_DATABASE_URL). Isto é só pra
// ele alinhar o texto cru de `loja` contra o nome canônico da tabela `lojas`
// daqui, reaproveitando normalizeLojaPublica() em vez de duplicar o mapa de
// apelidos legados numa segunda base de código (foi exatamente essa
// duplicação/drift que causou o bug da Bruna sumindo do select de
// optometristas — ver histórico de 2026-07-29).

const ADANALYZEROS_LOJAS_KEY = process.env.ADANALYZEROS_LOJAS_KEY || "";

function validarAdAnalyzerOsKey(req, res, next) {
  const recebida = req.headers["x-api-key"] || "";
  if (!ADANALYZEROS_LOJAS_KEY) {
    return res.status(500).json({ ok: false, message: "ADANALYZEROS_LOJAS_KEY não configurada no Railway." });
  }
  if (!safeEqual(recebida, ADANALYZEROS_LOJAS_KEY)) {
    return res.status(401).json({ ok: false, message: "Chave de sincronismo inválida." });
  }
  next();
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// O Postgres gerenciado usa UTC por padrão para CURRENT_TIMESTAMP/NOW().
// Como as colunas de data/hora são TIMESTAMP sem fuso, isso fazia qualquer
// registro após ~21h (horário de Brasília) gravar e exibir a data do dia
// seguinte. Fixamos o fuso da sessão do Postgres para bater com o fuso do
// processo Node (TZ=America/Sao_Paulo), corrigindo isso em todo o sistema
// de uma vez, sem precisar tocar em cada query que usa CURRENT_TIMESTAMP.
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'America/Sao_Paulo'").catch((err) => {
    console.error("[pool] Falha ao definir fuso horário da sessão:", err.message);
  });
});

function safeEqual(value, expected) {
  const left = crypto.createHash("sha256").update(String(value || "")).digest();
  const right = crypto.createHash("sha256").update(String(expected || "")).digest();
  return crypto.timingSafeEqual(left, right);
}

// Criptografia em repouso para segredos de integração salvos em
// configuracoes_integracao (ex.: access token do Kommo). Usa a chave
// CONFIG_ENCRYPTION_KEY (32 bytes) — se ausente, encryptSecret falha de
// forma explícita (fail-closed), no mesmo padrão do SESSION_SECRET.
const CONFIG_ENCRYPTION_KEY = process.env.CONFIG_ENCRYPTION_KEY || "";

function getConfigEncryptionKey() {
  if (!CONFIG_ENCRYPTION_KEY) return null;
  return crypto.createHash("sha256").update(CONFIG_ENCRYPTION_KEY).digest();
}

function encryptSecret(text) {
  const key = getConfigEncryptionKey();
  if (!key) throw new Error("CONFIG_ENCRYPTION_KEY não configurada no Railway.");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text || ""), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decryptSecret(payload) {
  const key = getConfigEncryptionKey();
  if (!key || !payload) return "";
  try {
    const raw = Buffer.from(payload, "base64");
    const iv = raw.subarray(0, 12);
    const authTag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  } catch (error) {
    return "";
  }
}

async function getConfigValor(chave) {
  const result = await pool.query(`SELECT valor, criptografado FROM configuracoes_integracao WHERE chave = $1`, [chave]);
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return row.criptografado ? decryptSecret(row.valor) : row.valor;
}

async function setConfigValor(chave, valor, { criptografado = false, email = null } = {}) {
  const valorGravado = criptografado ? encryptSecret(valor) : String(valor || "");
  await pool.query(
    `INSERT INTO configuracoes_integracao (chave, valor, criptografado, atualizado_por_email, atualizado_em)
     VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)
     ON CONFLICT (chave) DO UPDATE SET
       valor = EXCLUDED.valor,
       criptografado = EXCLUDED.criptografado,
       atualizado_por_email = EXCLUDED.atualizado_por_email,
       atualizado_em = CURRENT_TIMESTAMP`,
    [chave, valorGravado, criptografado, email]
  );
}

async function carregarConfiguracaoKommoDoBanco() {
  try {
    const subdomain = await getConfigValor("kommo_subdomain");
    const accessToken = await getConfigValor("kommo_access_token");
    const webhookSecret = await getConfigValor("kommo_webhook_secret");
    if (subdomain || accessToken) {
      kommoClient.reconfigure({ subdomain: subdomain || undefined, accessToken: accessToken || undefined });
    }
    if (webhookSecret) {
      process.env.KOMMO_WEBHOOK_SECRET = webhookSecret;
    }
  } catch (error) {
    console.error("Não foi possível carregar configuração do Kommo salva no banco:", error.message);
  }
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

// O cookie de sessão carrega perfil/loja/permissão financeira congelados no
// momento do login, válidos por até SESSION_TTL_HOURS. Se um admin corrige a
// loja/cargo de alguém já logado, ou desativa a conta, isso só valeria a
// partir do próximo login -- já causou pelo menos um bug real em produção
// (4 contas com loja errada continuaram usando o valor antigo mesmo depois
// de corrigido no cadastro). Este cache revalida contra o banco no máximo a
// cada SESSION_REFRESH_TTL_MS por usuário -- não a cada requisição -- para
// não adicionar consulta extra em toda chamada da API.
const SESSION_REFRESH_TTL_MS = 60 * 1000;
const SESSION_REFRESH_QUERY_TIMEOUT_MS = 1500;
const sessionRefreshCache = new Map();

// Uma consulta que nunca resolve (ex: pool real inalcançável) não pode travar
// a requisição -- sem isso, "falha vira fallback silencioso" não vale para
// uma conexão pendurada, só para uma que rejeita rápido.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout ao revalidar sessão")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

async function requireSession(req, res, next) {
  if (!SESSION_SECRET) {
    return res.status(503).json({ ok: false, message: "SESSION_SECRET não configurado." });
  }
  const session = verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!session) {
    return res.status(401).json({ ok: false, message: "Sessão ausente ou expirada." });
  }
  req.session = session;

  const cacheKey = clean(session.email).toLowerCase();
  const now = Date.now();
  const cached = cacheKey ? sessionRefreshCache.get(cacheKey) : null;

  if (cached && cached.expiresAt > now) {
    if (cached.ativo === false) {
      return res.status(401).json({ ok: false, message: "Sessão inválida. Faça login novamente." });
    }
    req.session = { ...session, nome: cached.nome, perfil: cached.perfil, loja: cached.loja, canViewFinance: cached.canViewFinance };
    return next();
  }

  // Qualquer falha ou ausência de resultado aqui NÃO bloqueia a requisição:
  // mantemos os dados do cookie (comportamento de hoje) em vez de rejeitar.
  // Só barramos explicitamente quando a conta É encontrada e está inativa.
  try {
    const fresh = await withTimeout(pool.query(
      `SELECT id, nome, email, cargo, loja, access_tags, can_view_finance, ativo FROM usuarios WHERE LOWER(email) = LOWER($1) LIMIT 1`,
      [cacheKey]
    ), SESSION_REFRESH_QUERY_TIMEOUT_MS);
    const dbUser = fresh.rows[0];
    // Confere que a linha realmente é do usuário da sessão -- protege contra
    // um mock de teste (ou qualquer resultado inesperado) de outra consulta
    // ser lido aqui como se fosse o cadastro do usuário.
    if (dbUser && clean(dbUser.email).toLowerCase() === cacheKey) {
      const atual = publicUser(dbUser);
      const ativo = dbUser.ativo !== false;
      sessionRefreshCache.set(cacheKey, {
        nome: atual.nome, perfil: atual.perfil, loja: atual.loja, canViewFinance: atual.can_view_finance,
        ativo, expiresAt: now + SESSION_REFRESH_TTL_MS
      });
      if (!ativo) {
        return res.status(401).json({ ok: false, message: "Sessão inválida. Faça login novamente." });
      }
      req.session = { ...session, nome: atual.nome, perfil: atual.perfil, loja: atual.loja, canViewFinance: atual.can_view_finance };
    }
  } catch (error) {
    // Falha na consulta: segue com os dados do cookie, sem bloquear ninguém.
  }
  next();
}

function roleOf(session) {
  return clean(session?.perfil).toLowerCase();
}

// Identidade reservada do criador. A senha nunca deve existir no código.
const HUGO_SUPER_ADMIN_EMAIL = "hugoprudente.marketing@gmail.com";

function isHugoAccount(user) {
  return clean(user?.email).toLowerCase() === HUGO_SUPER_ADMIN_EMAIL;
}

function isSuperAdmin(session) {
  return isHugoAccount(session) && roleOf(session) === "super_admin";
}

function hasRole(session, roles) {
  const role = roleOf(session);
  return roles.includes(role) || (isSuperAdmin(session) && roles.includes("admin"));
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

function isGonzagaSantosStore(value) {
  return normalizeStoreKey(value).includes("gonzaga");
}

async function carregarConfiguracoesPainelDoBanco() {
  try {
    const permissoes = await getConfigValor("permissoes_perfil");
    const aparencia = await getConfigValor("aparencia_painel");
    rolePermissionsCache = permissoes ? JSON.parse(permissoes) : {};
    appearanceCache = aparencia
      ? { ...appearanceCache, ...JSON.parse(aparencia) }
      : appearanceCache;
  } catch (error) {
    console.error("Não foi possível carregar permissões/aparência:", error.message);
  }
}

const DEFAULT_ROLE_PERMISSIONS = {
  "atendimento central": { canViewAll: true, canCreateAgendamento: true, canManageOS: true, canViewFinance: false },
  "gerente de loja": { canViewAll: false, canCreateAgendamento: true, canManageOS: true, canViewFinance: true },
  "comprador": { canViewAll: false, canCreateAgendamento: true, canManageOS: true, canViewFinance: true },
  "consultor de vendas": { canViewAll: false, canCreateAgendamento: true, canManageOS: false, canViewFinance: false },
  "vendedor": { canViewAll: false, canCreateAgendamento: true, canManageOS: false, canViewFinance: false },
  "optometrista": { canViewAll: false, canCreateAgendamento: false, canManageOS: false, canViewFinance: false }
};
let rolePermissionsCache = {};
let appearanceCache = { primaryColor: "#fc5102", secondaryColor: "#fc7d05", logoDataUrl: "" };

function storeSql(column, parameter = "$1") {
  return `TRANSLATE(LOWER(TRIM(COALESCE(${column},''))), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc') = TRANSLATE(LOWER(TRIM(${parameter})), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
}

// Traduz erros conhecidos de constraint do Postgres em respostas HTTP amigáveis.
// Antes disso, cada rota que podia bater numa trava do banco duplicava seu
// próprio `if (error.message.includes("nome_da_constraint"))` -- funcionava,
// mas era fácil uma rota nova (ou uma trava nova) ficar de fora e vazar um
// 500 genérico pro usuário (foi exatamente o que aconteceu: a rota pública
// de agendamento tratava uniq_agendamento_ativo_slot, o painel interno não).
// Uso: `if (responderErroBanco(res, error)) return;` logo no início do catch,
// antes do fallback genérico de 500. Casa pelo NOME da constraint
// (error.constraint, populado pelo driver `pg` em qualquer violação), não
// pelo texto da mensagem -- mais estável se o Postgres mudar a redação.
const ERROS_BANCO_CONHECIDOS = {
  uniq_agendamento_ativo_slot: {
    status: 409,
    message: "Esse horário já está ocupado com esse optometrista nessa loja. Escolha outro horário ou optometrista."
  }
};
function responderErroBanco(res, error, mensagensPersonalizadas) {
  const constraint = error && error.constraint;
  const info = constraint && ERROS_BANCO_CONHECIDOS[constraint];
  if (!info) return false;
  const mensagem = (mensagensPersonalizadas && mensagensPersonalizadas[constraint]) || info.message;
  res.status(info.status).json({ ok: false, message: mensagem });
  return true;
}

function buildPermissions(user) {
  const storedRole = clean(user?.cargo || user?.perfil).toLowerCase();
  const superAdmin = isHugoAccount(user);
  const role = superAdmin ? "super_admin" : storedRole;
  const admin = role === "admin" || superAdmin;
  const central = role === "atendimento central";
  const manager = role === "gerente de loja";
  const buyer = role === "comprador";
  const seller = ["consultor de vendas", "vendedor"].includes(role);
  const sellerGonzaga = seller && isGonzagaSantosStore(user?.loja);
  const configured = rolePermissionsCache[storedRole] || DEFAULT_ROLE_PERMISSIONS[storedRole] || {};
  const canViewFinance = admin || Boolean(configured.canViewFinance) || Boolean(user?.can_view_finance);

  return {
    isSuperAdmin: superAdmin,
    isAdmin: admin,
    canManageSystem: superAdmin,
    canManageKommo: superAdmin,
    canManageLandingPages: superAdmin,
    canViewAll: admin || Boolean(configured.canViewAll),
    canCreateAgendamento: admin || Boolean(configured.canCreateAgendamento),
    canManageOS: admin || Boolean(configured.canManageOS) || sellerGonzaga,
    canViewFinance,
    canExportFinance: canViewFinance
  };
}

function publicUser(user) {
  const permissions = buildPermissions(user);
  const effectiveRole = permissions.isSuperAdmin ? "super_admin" : user.cargo;
  return {
    id: user.id,
    nome: user.nome,
    email: user.email,
    perfil: effectiveRole,
    cargo: effectiveRole,
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

function requireSuperAdmin(req, res, next) {
  if (!isSuperAdmin(req.session)) {
    return res.status(403).json({ ok: false, message: "Acesso exclusivo do criador do sistema." });
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

// Remove acentos e qualquer pontuacao (hifen, ponto, meia-risca) antes de
// comparar, para que variacoes como "Target - Santo Antonio" e "Target Sto.
// Antonio" cheguem na mesma chave sem precisar cadastrar cada combinacao.
function chaveLojaPublica(valor) {
  return String(valor || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeLojaPublica(loja) {
  const raw = clean(loja);
  const key = chaveLojaPublica(raw);
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

  const mapaPuro = {};
  Object.keys(mapa).forEach((k) => { mapaPuro[chaveLojaPublica(k)] = mapa[k]; });

  // Sem correspondência confiável: melhor rejeitar (ver checagem "if (!loja)"
  // em quem chama esta função) do que aceitar um valor que não bate com
  // nenhuma loja real e criar um agendamento invisível para todo mundo,
  // exceto admin/atendimento central.
  return mapaPuro[key] || null;
}

function normalizeWhatsappPublico(v) {
  return clean(v).replace(/\D/g, "");
}

function isGonzagaSemAlmocoEm29Jul2026(loja, data) {
  const lojaKey = clean(loja).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return toPgDate(data) === "2026-07-29" &&
    (lojaKey.includes("gonzaga") || lojaKey.includes("santos"));
}

function horarioValidoPorRegra(data, horario, loja = "") {
  const dt = toPgDate(data);
  const hr = clean(horario);

  if (!dt || !/^\d{2}:\d{2}$/.test(hr)) {
    return { ok: true };
  }

  const d = new Date(dt + "T12:00:00");
  const dia = d.getDay();
  const [hh, mm] = hr.split(":").map(Number);
  const minutos = hh * 60 + mm;
  const jornadaEspecialGonzaga = isGonzagaSemAlmocoEm29Jul2026(loja, dt);

  if (dia === 0) {
    return { ok: false, message: "Domingo não está disponível para agendamento." };
  }

  if (dia >= 1 && dia <= 5 && (minutos < 600 || minutos > (jornadaEspecialGonzaga ? 1140 : 1080))) {
    return { ok: false, message: "De segunda a sexta, escolha entre 10:00 e 18:00." };
  }

  if (dia === 6 && (minutos < 600 || minutos > 960)) {
    return { ok: false, message: "Aos sábados, escolha entre 10:00 e 16:00." };
  }

  const lojaKey = clean(loja).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const isGonzagaSantos = lojaKey.includes("gonzaga") || lojaKey.includes("santos");

  if (!isGonzagaSantos && (hr === "13:00" || hr === "13:15" || hr === "13:30" || hr === "13:45")) {
    return { ok: false, message: "Horário de almoço não disponível. Escolha um horário fora do intervalo 13:00–14:00." };
  }

  if (isGonzagaSantos && !jornadaEspecialGonzaga && dia >= 1 && dia <= 5 && ["14:00", "14:15", "14:30", "14:45"].includes(hr)) {
    return { ok: false, message: "Horário de almoço não disponível em Gonzaga. Escolha um horário fora do intervalo 14:00–15:00." };
  }

  // Datas com encerramento antecipado — todas as lojas
  const ENCERRAMENTO_ANTECIPADO = { "2026-06-29": 12 * 60 + 30 };
  if (ENCERRAMENTO_ANTECIPADO[dt] !== undefined && minutos > ENCERRAMENTO_ANTECIPADO[dt]) {
    return { ok: false, message: "Neste dia o atendimento encerra às 13:00. Escolha um horário até 12:30." };
  }

  return { ok: true };
}

function gerarHorariosBase(data, loja = "") {
  const dt = toPgDate(data);
  if (!dt) return [];

  const d = new Date(dt + "T12:00:00");
  const dia = d.getDay();

  if (dia === 0) return [];

  const inicio = 10 * 60;
  const jornadaEspecialGonzaga = isGonzagaSemAlmocoEm29Jul2026(loja, dt);
  const fim = dia === 6 ? 16 * 60 : (jornadaEspecialGonzaga ? 19 * 60 : 18 * 60);
  const horarios = [];

  for (let m = inicio; m <= fim; m += 15) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const h = `${hh}:${mm}`;
    // Bloqueia almoço 13:00–13:45 (1 hora, 4 slots de 15 min) para todas as lojas exceto Gonzaga
    const lojaKey = clean(loja).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const isGonzagaSantos = lojaKey.includes("gonzaga") || lojaKey.includes("santos");
    const almocoPadrao = ["13:00", "13:15", "13:30", "13:45"].includes(h);
    const almocoGonzaga = !jornadaEspecialGonzaga && dia >= 1 && dia <= 5 && ["14:00", "14:15", "14:30", "14:45"].includes(h);
    if ((!isGonzagaSantos && !almocoPadrao) || (isGonzagaSantos && !almocoGonzaga)) horarios.push(h);
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

async function buscarBloqueioDisponibilidade(client, loja, data, horario = "") {
  const hr = clean(horario);
  const result = await client.query(
    `SELECT motivo, TO_CHAR(hora_inicio,'HH24:MI') AS hora_inicio, TO_CHAR(hora_fim,'HH24:MI') AS hora_fim
       FROM bloqueios_disponibilidade
      WHERE LOWER(loja) = LOWER($1) AND data = $2
        AND (
          ($3::text = '' AND hora_inicio IS NULL AND hora_fim IS NULL)
          OR ($3::text <> '' AND (hora_inicio IS NULL OR hora_fim IS NULL OR ($3::time >= hora_inicio AND $3::time < hora_fim)))
        )
      LIMIT 1`,
    [loja, data, hr]
  );
  return result.rows[0] || null;
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

  const diaSemanaAgenda = new Date(String(data) + "T12:00:00").getDay();

  for (const optometrista of candidatos) {
    const disponivelNoHorario = await estaOptometristaDisponivel(client, {
      nome: optometrista, loja, diaSemana: diaSemanaAgenda, horario
    });
    if (!disponivelNoHorario) continue;

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

// new Date().toISOString() sempre devolve a data em UTC, ignorando o fuso do
// processo — perto/depois das 21h em Brasília (horário de verão à parte) isso
// já é "amanhã" em UTC, quebrando qualquer filtro de "hoje"/período padrão.
// Use esta função sempre que precisar da data corrente no fuso de Brasília.
function hojeBrasil() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function numberFromBR(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Ano fora dessa faixa nunca é uma data real de agendamento -- é sinal de
// corrupção (já aconteceu em produção: 4 agendamentos gravados com ano 26,
// 2626, 62026 e 72026, provavelmente de uma data mal formada vinda do
// cliente/bot que passou direto para a coluna DATE sem nenhuma validação).
// A janela é generosa o bastante para não travar backdating legítimo nem
// agendamentos futuros distantes.
function anoRazoavel(ano) {
  const atual = new Date().getFullYear();
  return Number.isInteger(ano) && ano >= 2000 && ano <= atual + 5;
}

function toPgDate(v) {
  const s = clean(v);
  if (!s) return null;
  let resultado = null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    resultado = s.slice(0, 10);
  } else {
    const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (br) {
      resultado = `${br[3]}-${br[2]}-${br[1]}`;
    } else {
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) resultado = d.toISOString().slice(0, 10);
    }
  }
  if (!resultado) return null;
  return anoRazoavel(Number(resultado.slice(0, 4))) ? resultado : null;
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

// ÚNICA fonte de verdade do schema do banco — roda no boot (idempotente,
// CREATE TABLE/COLUMN sempre com IF NOT EXISTS). Existiu no passado um
// database/schema.sql paralelo tentando descrever a mesma coisa e nunca
// usado por nenhum deploy real; ficou incompleto e foi removido. Se
// precisar inspecionar o schema de fora do Node, tire um dump do banco
// (pg_dump --schema-only) em vez de manter um arquivo .sql à mão — não
// tem como esse arquivo ficar desatualizado se ele simplesmente não existe.
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
      patologia TEXT DEFAULT 'Pendente',
      resultado_optometrista TEXT DEFAULT 'Pendente',
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
    CREATE TABLE IF NOT EXISTS configuracoes_integracao (
      chave TEXT PRIMARY KEY,
      valor TEXT,
      criptografado BOOLEAN DEFAULT false,
      atualizado_por_email TEXT,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS horarios_funcionamento_loja (
      id SERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
      aberto BOOLEAN NOT NULL DEFAULT true,
      hora_inicio TIME,
      hora_fim TIME,
      intervalo_inicio TIME,
      intervalo_fim TIME,
      atualizado_por_email TEXT,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (loja, dia_semana)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS horarios_optometrista (
      id SERIAL PRIMARY KEY,
      optometrista_id INTEGER NOT NULL REFERENCES optometristas(id) ON DELETE CASCADE,
      dia_semana SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
      hora_inicio TIME NOT NULL,
      hora_fim TIME NOT NULL,
      atualizado_por_email TEXT,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (optometrista_id, dia_semana)
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vendedores_consultores (
      id BIGSERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      nome_chave TEXT NOT NULL,
      loja TEXT NOT NULL DEFAULT '',
      loja_chave TEXT NOT NULL DEFAULT '',
      ativo BOOLEAN NOT NULL DEFAULT true,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (nome_chave, loja_chave)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS metas_desempenho (
      id BIGSERIAL PRIMARY KEY,
      competencia DATE NOT NULL,
      tipo_escopo TEXT NOT NULL CHECK (tipo_escopo IN ('grupo','loja','consultor')),
      chave_escopo TEXT NOT NULL,
      loja TEXT,
      vendedor_consultor_id BIGINT REFERENCES vendedores_consultores(id) ON DELETE SET NULL,
      meta_faturamento NUMERIC(14,2) DEFAULT 0,
      meta_vendas INTEGER DEFAULT 0,
      meta_agendamentos INTEGER DEFAULT 0,
      meta_comparecimento NUMERIC(5,2) DEFAULT 0,
      meta_conversao NUMERIC(5,2) DEFAULT 0,
      meta_ticket_medio NUMERIC(14,2) DEFAULT 0,
      limite_desconto NUMERIC(5,2) DEFAULT 0,
      meta_prazo_os_dias INTEGER DEFAULT 0,
      observacao TEXT,
      ativo BOOLEAN NOT NULL DEFAULT true,
      criado_por_email TEXT,
      atualizado_por_email TEXT,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (competencia, chave_escopo)
    );
  `);

  await addColumnIfMissing("agendamentos", "gas_id", "TEXT UNIQUE");
  await addColumnIfMissing("agendamentos", "origem_sync", "TEXT DEFAULT 'postgres'");
  await addColumnIfMissing("agendamentos", "agendado_por_nome", "TEXT");
  await addColumnIfMissing("agendamentos", "agendado_por_email", "TEXT");
  await addColumnIfMissing("agendamentos", "vendedor_atendeu_nome", "TEXT");
  await addColumnIfMissing("agendamentos", "vendedor_atendeu_email", "TEXT");
  await addColumnIfMissing("agendamentos", "vendedor_consultor_id", "BIGINT REFERENCES vendedores_consultores(id) ON DELETE SET NULL");
  await addColumnIfMissing("agendamentos", "ultima_alteracao_por_nome", "TEXT");
  await addColumnIfMissing("agendamentos", "ultima_alteracao_por_email", "TEXT");
  await addColumnIfMissing("agendamentos", "ultima_alteracao_em", "TIMESTAMP");
  await addColumnIfMissing("agendamentos", "excluido_em", "TIMESTAMP");
  await addColumnIfMissing("agendamentos", "patologia", "TEXT DEFAULT 'Pendente'");
  await addColumnIfMissing("agendamentos", "resultado_optometrista", "TEXT DEFAULT 'Pendente'");
  await addColumnIfMissing("agendamentos", "atendimento_semaforo", "TEXT DEFAULT ''");
  await addColumnIfMissing("agendamentos", "atendimento_semaforo_label", "TEXT DEFAULT ''");
  await addColumnIfMissing("agendamentos", "nao_compareceu_em", "TIMESTAMPTZ");
  await addColumnIfMissing("agendamentos", "nao_compareceu_lembrete_em", "TIMESTAMPTZ");

  await pool.query(`
    CREATE OR REPLACE FUNCTION normalizar_identidade_comercial_tgt(valor TEXT)
    RETURNS TEXT AS $$
      SELECT REGEXP_REPLACE(
        TRANSLATE(LOWER(TRIM(COALESCE(valor,''))),
          'áàâãäéèêëíìîïóòôõöúùûüç',
          'aaaaaeeeeiiiiooooouuuuc'),
        '\\s+', ' ', 'g');
    $$ LANGUAGE sql IMMUTABLE;

    CREATE OR REPLACE FUNCTION vincular_vendedor_consultor_tgt()
    RETURNS trigger AS $$
    DECLARE
      nome_comercial TEXT := COALESCE(
        NULLIF(TRIM(NEW.vendedor_atendeu_nome), ''),
        NULLIF(TRIM(NEW.vendedor_nome), ''),
        NULLIF(TRIM(NEW.consultor_responsavel), '')
      );
      identidade_id BIGINT;
    BEGIN
      IF nome_comercial IS NULL THEN RETURN NEW; END IF;

      INSERT INTO vendedores_consultores (nome, nome_chave, loja, loja_chave, ativo, atualizado_em)
      VALUES (
        nome_comercial,
        normalizar_identidade_comercial_tgt(nome_comercial),
        COALESCE(NEW.loja, ''),
        normalizar_identidade_comercial_tgt(NEW.loja),
        true,
        CURRENT_TIMESTAMP
      )
      ON CONFLICT (nome_chave, loja_chave)
      DO UPDATE SET ativo = true, atualizado_em = CURRENT_TIMESTAMP
      RETURNING id INTO identidade_id;

      NEW.vendedor_consultor_id := identidade_id;
      NEW.vendedor_atendeu_nome := COALESCE(NULLIF(NEW.vendedor_atendeu_nome, ''), nome_comercial);
      NEW.vendedor_nome := COALESCE(NULLIF(NEW.vendedor_nome, ''), nome_comercial);
      NEW.consultor_responsavel := COALESCE(NULLIF(NEW.consultor_responsavel, ''), nome_comercial);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_vincular_vendedor_consultor_tgt ON agendamentos;
    CREATE TRIGGER trg_vincular_vendedor_consultor_tgt
    BEFORE INSERT OR UPDATE OF vendedor_atendeu_nome, vendedor_nome, consultor_responsavel, loja
    ON agendamentos
    FOR EACH ROW EXECUTE FUNCTION vincular_vendedor_consultor_tgt();

    UPDATE agendamentos
    SET vendedor_atendeu_nome = COALESCE(
      NULLIF(vendedor_atendeu_nome, ''),
      NULLIF(vendedor_nome, ''),
      NULLIF(consultor_responsavel, '')
    )
    WHERE vendedor_consultor_id IS NULL
      AND COALESCE(NULLIF(vendedor_atendeu_nome, ''), NULLIF(vendedor_nome, ''), NULLIF(consultor_responsavel, '')) IS NOT NULL;
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION agendar_followup_nao_compareceu_tgt()
    RETURNS trigger AS $$
    DECLARE
      novo_compareceu TEXT := TRANSLATE(
        LOWER(TRIM(COALESCE(NEW.compareceu, ''))),
        'áàâãäéèêëíìîïóòôõöúùûüç',
        'aaaaaeeeeiiiiooooouuuuc'
      );
      novo_status TEXT := TRANSLATE(
        LOWER(TRIM(COALESCE(NEW.status, ''))),
        'áàâãäéèêëíìîïóòôõöúùûüç',
        'aaaaaeeeeiiiiooooouuuuc'
      );
      antigo_nao_compareceu BOOLEAN := false;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        antigo_nao_compareceu :=
          TRANSLATE(LOWER(TRIM(COALESCE(OLD.compareceu, ''))),
            'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')
            IN ('nao', 'nao compareceu')
          OR TRANSLATE(LOWER(TRIM(COALESCE(OLD.status, ''))),
            'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')
            = 'nao compareceu';
      END IF;

      IF novo_compareceu IN ('nao', 'nao compareceu') OR novo_status = 'nao compareceu' THEN
        IF TG_OP = 'INSERT' OR NOT antigo_nao_compareceu THEN
          NEW.nao_compareceu_em := NOW();
          NEW.nao_compareceu_lembrete_em := NULL;
        ELSE
          NEW.nao_compareceu_em := COALESCE(NEW.nao_compareceu_em, NOW());
        END IF;
      ELSE
        NEW.nao_compareceu_em := NULL;
        NEW.nao_compareceu_lembrete_em := NULL;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_zz_followup_nao_compareceu_tgt ON agendamentos;
    CREATE TRIGGER trg_zz_followup_nao_compareceu_tgt
    BEFORE INSERT OR UPDATE OF compareceu, status
    ON agendamentos
    FOR EACH ROW EXECUTE FUNCTION agendar_followup_nao_compareceu_tgt();
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION atualizar_atendimento_semaforo_tgt()
    RETURNS trigger AS $$
    DECLARE
      comp TEXT := replace(lower(coalesce(NEW.compareceu, '')), 'ã', 'a');
      status_agenda TEXT := replace(lower(coalesce(NEW.status, '')), 'ã', 'a');
      venda TEXT := replace(lower(coalesce(NEW.venda_gerada, '')), 'ã', 'a');
      resultado TEXT := replace(lower(coalesce(NEW.resultado_optometrista, '')), 'ã', 'a');
      pat TEXT := replace(lower(coalesce(NEW.patologia, '')), 'ã', 'a');
      valor NUMERIC := coalesce(NEW.valor_venda, 0);
    BEGIN
      IF resultado = 'patologia' OR pat = 'sim' THEN
        NEW.atendimento_semaforo := 'azul';
        NEW.atendimento_semaforo_label := 'Patologia';
      ELSIF status_agenda IN ('nao compareceu', 'não compareceu') OR comp IN ('nao', 'não', 'nao compareceu', 'não compareceu') THEN
        NEW.atendimento_semaforo := 'vermelho';
        NEW.atendimento_semaforo_label := 'Não compareceu';
      ELSIF comp IN ('sim', 'compareceu') OR status_agenda IN ('compareceu', 'concluido', 'concluído') THEN
        IF venda = 'sim' OR valor > 0 THEN
          NEW.atendimento_semaforo := 'verde';
          NEW.atendimento_semaforo_label := 'Compareceu e comprou';
        ELSE
          NEW.atendimento_semaforo := 'amarelo';
          NEW.atendimento_semaforo_label := 'Compareceu e não comprou';
        END IF;
      ELSE
        NEW.atendimento_semaforo := '';
        NEW.atendimento_semaforo_label := '';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_atualizar_atendimento_semaforo_tgt ON agendamentos;
    CREATE TRIGGER trg_atualizar_atendimento_semaforo_tgt
    BEFORE INSERT OR UPDATE OF compareceu, status, venda_gerada, valor_venda, patologia, resultado_optometrista
    ON agendamentos
    FOR EACH ROW EXECUTE FUNCTION atualizar_atendimento_semaforo_tgt();

    UPDATE agendamentos
    SET compareceu = compareceu
    WHERE atendimento_semaforo IS NULL OR atendimento_semaforo = '';
  `);

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
      -- So preenche ultima_alteracao_por_nome quando ainda esta vazio (ex: INSERT
      -- vindo do bot/landing page sem essa info). Nao pode sobrescrever o valor que
      -- a aplicacao ja gravou nesta mesma UPDATE com quem REALMENTE fez a alteracao
      -- agora -- senao esse campo fica preso para sempre no nome de quem criou o
      -- registro (agendado_por_nome e "grudento"), mesmo quando outra pessoa edita.
      NEW.ultima_alteracao_por_nome := COALESCE(NULLIF(NEW.ultima_alteracao_por_nome, ''), responsavel_registro);
      NEW.ultima_alteracao_em := NOW();
      IF COALESCE(NEW.valor_venda, 0) > 0
        AND LOWER(COALESCE(NEW.status, '')) <> 'cancelado'
        AND LOWER(COALESCE(NEW.status_os, '')) NOT IN ('cancelada', 'cancelado', 'reembolso') THEN
        NEW.compareceu := 'Sim';
        IF TRANSLATE(LOWER(COALESCE(NEW.status, '')), 'ãáàâäéèêëíìîïóòôöõúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
          IN ('agendado', 'confirmado', 'nao compareceu') THEN
          NEW.status := 'Compareceu';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_validar_agendamento_tgt ON agendamentos;
    CREATE TRIGGER trg_validar_agendamento_tgt
    BEFORE INSERT OR UPDATE ON agendamentos
    FOR EACH ROW EXECUTE FUNCTION validar_agendamento_tgt();
  `);

  const comprasCorrigidas = await pool.query(`
    UPDATE agendamentos
    SET compareceu = 'Sim',
        status = CASE
          WHEN TRANSLATE(LOWER(COALESCE(status, '')), 'ãáàâäéèêëíìîïóòôöõúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
            IN ('agendado', 'confirmado', 'nao compareceu') THEN 'Compareceu'
          ELSE status
        END,
        atualizado_em = CURRENT_TIMESTAMP
    WHERE COALESCE(valor_venda, 0) > 0
      AND LOWER(COALESCE(status, '')) <> 'cancelado'
      AND LOWER(COALESCE(status_os, '')) NOT IN ('cancelada', 'cancelado', 'reembolso')
      AND (
        TRANSLATE(LOWER(COALESCE(compareceu, '')), 'ãáàâäéèêëíìîïóòôöõúùûüç', 'aaaaaeeeeiiiiooooouuuuc') <> 'sim'
        OR TRANSLATE(LOWER(COALESCE(status, '')), 'ãáàâäéèêëíìîïóòôöõúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
          IN ('agendado', 'confirmado', 'nao compareceu')
      )
    RETURNING id
  `);
  if (comprasCorrigidas.rowCount) {
    const ids = comprasCorrigidas.rows.slice(0, 30).map((row) => row.id).join(", ");
    console.log(`[Semáforo] ${comprasCorrigidas.rowCount} compra(s) corrigida(s) automaticamente. IDs: ${ids}`);
  }

  await negociacaoRoutes.initNegociacaoTables(pool);
  await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS lembrete_24h_em TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS lembrete_2h_em TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bloqueios_disponibilidade (
      id SERIAL PRIMARY KEY,
      loja TEXT NOT NULL,
      data DATE NOT NULL,
      hora_inicio TIME,
      hora_fim TIME,
      motivo TEXT,
      criado_por TEXT,
      criado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE (loja, data)
    )
  `);
  await pool.query(`ALTER TABLE bloqueios_disponibilidade ADD COLUMN IF NOT EXISTS hora_inicio TIME`);
  await pool.query(`ALTER TABLE bloqueios_disponibilidade ADD COLUMN IF NOT EXISTS hora_fim TIME`);

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

  // Histórico de mensagens do CRM (painel próprio, espelhando conversas do Kommo).
  // Preenchido a partir de agora pelos webhooks/salesbot — sem backfill do Kommo.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS crm_mensagens (
      id BIGSERIAL PRIMARY KEY,
      kommo_lead_id TEXT NOT NULL,
      talk_id TEXT,
      chat_id TEXT,
      direcao TEXT NOT NULL,
      autor_tipo TEXT NOT NULL,
      autor_nome TEXT,
      texto TEXT,
      criado_em TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_crm_mensagens_lead ON crm_mensagens(kommo_lead_id, criado_em);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_kommo_lead_id ON agendamentos(kommo_lead_id);`);
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

// Aggregated PostgreSQL metrics for AdAnalyzer; no customer PII is returned.
app.get("/api/internal/marketing-performance", validarAdAnalyzerKey, async (req, res) => {
  try {
    const hoje = hojeBrasil();
    const start = clean(req.query.start) || hoje.slice(0, 8) + "01";
    const end = clean(req.query.end) || hoje;
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!datePattern.test(start) || !datePattern.test(end) || start > end) {
      return res.status(400).json({ ok: false, message: "Periodo invalido. Use start/end em YYYY-MM-DD." });
    }
    const startDate = new Date(`${start}T00:00:00Z`);
    const endDate = new Date(`${end}T00:00:00Z`);
    if ((endDate - startDate) / 86400000 > 366) {
      return res.status(400).json({ ok: false, message: "Periodo maximo: 366 dias." });
    }

    const result = await pool.query(
      `SELECT loja,
         COUNT(*)::int AS agendamentos,
         COUNT(*) FILTER (WHERE LOWER(COALESCE(compareceu,'')) IN ('sim','compareceu','true','1'))::int AS comparecimentos,
         COUNT(*) FILTER (WHERE COALESCE(valor_venda,0) > 0 OR LOWER(COALESCE(venda_gerada,'')) IN ('sim','true','1'))::int AS vendas,
         COALESCE(SUM(valor_venda),0)::numeric AS faturamento,
         COALESCE(SUM(desconto),0)::numeric AS descontos
       FROM agendamentos
       WHERE data_agendamento BETWEEN $1::date AND $2::date
         AND excluido_em IS NULL
         AND nome NOT ILIKE '%teste%'
         AND COALESCE(loja,'') NOT ILIKE '%teste%'
       GROUP BY loja ORDER BY loja`,
      [start, end]
    );

    const lojas = result.rows.map((row) => ({
      loja: row.loja || "Sem loja",
      agendamentos: Number(row.agendamentos || 0),
      comparecimentos: Number(row.comparecimentos || 0),
      vendas: Number(row.vendas || 0),
      faturamento: Number(row.faturamento || 0),
      descontos: Number(row.descontos || 0)
    }));
    const totais = lojas.reduce((acc, row) => {
      for (const key of ["agendamentos", "comparecimentos", "vendas", "faturamento", "descontos"]) acc[key] += row[key];
      return acc;
    }, { agendamentos: 0, comparecimentos: 0, vendas: 0, faturamento: 0, descontos: 0 });

    res.setHeader("Cache-Control", "private, max-age=60");
    res.json({ ok: true, fonte: "postgresql", periodo: { start, end }, totais, lojas });
  } catch (error) {
    console.error("Erro em marketing-performance:", error.message);
    res.status(500).json({ ok: false, message: "Erro ao consultar desempenho de marketing." });
  }
});

// Resolve (ou cria) o ID canônico de um vendedor/consultor a partir de nome+loja,
// para sistemas externos (ex.: captação de leads) que precisam referenciar o
// mesmo ID usado aqui, sem passar por um agendamento. Precisa ficar antes do
// gate global de sessão abaixo -- é chamada server-to-server, sem cookie.
app.post("/api/internal/vendedores-consultores/resolve", validarCaptacaoKey, async (req, res) => {
  try {
    const nome = clean(req.body?.nome || "");
    const loja = clean(req.body?.loja || "");
    if (!nome) {
      return res.status(400).json({ ok: false, message: "Campo 'nome' é obrigatório." });
    }
    const result = await pool.query(
      `INSERT INTO vendedores_consultores (nome, nome_chave, loja, loja_chave, ativo, atualizado_em)
       VALUES ($1, normalizar_identidade_comercial_tgt($1), $2, normalizar_identidade_comercial_tgt($2), true, CURRENT_TIMESTAMP)
       ON CONFLICT (nome_chave, loja_chave) DO UPDATE SET ativo = true, atualizado_em = CURRENT_TIMESTAMP
       RETURNING id`,
      [nome, loja]
    );
    res.json({ ok: true, id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao resolver vendedor/consultor.", error: error.message });
  }
});

// Lista canônica de lojas ativas, pra sistemas externos cachearem localmente
// (ex.: log de "loja não reconhecida" no adanalyzer-os). Mesma regra de
// posicionamento acima: server-to-server, antes do gate de sessão.
app.get("/api/internal/lojas", validarAdAnalyzerOsKey, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, cidade FROM lojas WHERE ativo = true ORDER BY nome`
    );
    res.setHeader("Cache-Control", "private, max-age=300");
    res.json({ ok: true, lojas: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao listar lojas.", error: error.message });
  }
});

// Alinha um texto cru de loja (ex.: vindo de agendamentos.loja, com possível
// grafia legada) contra o nome canônico usado hoje na tabela `lojas`.
// Reaproveita normalizeLojaPublica() — mesma lógica que todo o resto deste
// sistema já usa — em vez de o adanalyzer-os manter seu próprio mapa de
// apelidos, que divergiria com o tempo.
app.get("/api/internal/lojas/resolver", validarAdAnalyzerOsKey, async (req, res) => {
  try {
    const bruto = clean(req.query.nome || "");
    if (!bruto) {
      return res.status(400).json({ ok: false, message: "Parâmetro 'nome' é obrigatório." });
    }
    const canonico = normalizeLojaPublica(bruto);
    if (!canonico) {
      return res.json({ ok: true, nome_original: bruto, nome_canonico: null, loja_id: null, reconhecida: false });
    }
    const result = await pool.query(`SELECT id FROM lojas WHERE nome = $1 AND ativo = true LIMIT 1`, [canonico]);
    res.json({
      ok: true,
      nome_original: bruto,
      nome_canonico: canonico,
      loja_id: result.rows[0]?.id ?? null,
      reconhecida: true
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao resolver loja.", error: error.message });
  }
});

app.use("/api", (req, res, next) => {
  if (req.path === "/auth/login" || req.path === "/auth/logout") return next();
  if (req.path.startsWith("/public/")) return next();
  return requireSession(req, res, next);
});

// Registro de auditoria: toda ação de escrita (POST/PATCH/PUT/DELETE) em
// qualquer rota da API, de qualquer perfil -- quem fez, o quê, quando, e o
// resultado. Não interfere na resposta (só observa via o evento "finish");
// uma falha aqui nunca pode derrubar a requisição real.
const METODOS_AUDITADOS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
app.use("/api", (req, res, next) => {
  if (METODOS_AUDITADOS.has(req.method)) {
    const inicio = Date.now();
    res.on("finish", () => {
      try {
        console.log("[AUDIT]", JSON.stringify({
          em: new Date().toISOString(),
          metodo: req.method,
          rota: req.originalUrl || req.path,
          status: res.statusCode,
          ms: Date.now() - inicio,
          email: req.session?.email || null,
          perfil: req.session?.perfil || null,
          loja: req.session?.loja || null
        }));
      } catch (error) {}
    });
  }
  next();
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
      `SELECT motivo, TO_CHAR(hora_inicio,'HH24:MI') AS hora_inicio, TO_CHAR(hora_fim,'HH24:MI') AS hora_fim
       FROM bloqueios_disponibilidade
       WHERE LOWER(loja) = LOWER($1) AND data = $2 LIMIT 1`,
      [loja, data]
    ).catch(() => ({ rows: [] }));
    const bloqueioAgenda = bloqueio.rows[0] || null;
    if (bloqueioAgenda && (!bloqueioAgenda.hora_inicio || !bloqueioAgenda.hora_fim)) {
      return res.json({
        ok: true, loja, data, horarios: [],
        message: `Sem disponibilidade nesta data. ${bloqueioAgenda.motivo || ""}`.trim(),
        bloqueado: true,
      });
    }

    let horariosBase = gerarHorariosBase(data, loja);

    const diaRef = new Date(data + "T12:00:00").getDay();
    const jornadaConfig = await resolverJornadaLoja(client, loja, diaRef).catch(() => null);
    if (jornadaConfig && jornadaConfig.origem === "config") {
      // Loja com jornada semanal cadastrada no painel de Configurações —
      // essa configuração substitui a regra padrão hardcoded (para permitir
      // tanto restringir quanto ampliar o horário de atendimento).
      if (!jornadaConfig.aberto) {
        return res.json({
          ok: true, loja, data, horarios: [],
          message: "Loja fechada nesta data (horário configurado).",
        });
      }
      horariosBase = gerarSlotsJornada(jornadaConfig);
    } else {
      // Unidade Santos/Gonzaga tem almoço 14:00-14:45 em dias úteis (seg-sex) — 4 slots de 15 min
      const lojaKey = loja.toLowerCase().replace(/[^a-z]/g, "");
      const isGonzagaSantos = lojaKey.includes("gonzaga") || lojaKey.includes("santos");
      if (isGonzagaSantos && !isGonzagaSemAlmocoEm29Jul2026(loja, data) && diaRef >= 1 && diaRef <= 5) {
        horariosBase = horariosBase.filter(h => h !== "14:00" && h !== "14:15" && h !== "14:30" && h !== "14:45");
      }
    }
    if (bloqueioAgenda?.hora_inicio && bloqueioAgenda?.hora_fim) {
      horariosBase = horariosBase.filter(h => h < bloqueioAgenda.hora_inicio || h >= bloqueioAgenda.hora_fim);
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
        const disponivelNoHorario = await estaOptometristaDisponivel(client, {
          nome: optometrista, loja, diaSemana: diaRef, horario
        });
        if (!disponivelNoHorario) continue;

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

    const diaAgendamento = new Date(dataAgendamento + "T12:00:00").getDay();
    const jornadaConfigPost = await resolverJornadaLoja(client, loja, diaAgendamento).catch(() => null);
    const usaJornadaConfig = !!(jornadaConfigPost && jornadaConfigPost.origem === "config");

    if (usaJornadaConfig) {
      // Loja com jornada semanal cadastrada no painel de Configurações —
      // substitui a regra padrão hardcoded (permite tanto restringir quanto
      // ampliar o horário de atendimento em relação ao valor default).
      if (!jornadaConfigPost.aberto) {
        return res.status(400).json({ ok: false, message: "Loja fechada nesta data (horário configurado)." });
      }
      if (/^\d{2}:\d{2}$/.test(horario)) {
        const dentroJornada = horario >= jornadaConfigPost.horaInicio && horario <= jornadaConfigPost.horaFim;
        const noIntervalo = !!(jornadaConfigPost.intervaloInicio && jornadaConfigPost.intervaloFim &&
          horario >= jornadaConfigPost.intervaloInicio && horario < jornadaConfigPost.intervaloFim);
        if (!dentroJornada || noIntervalo) {
          return res.status(400).json({ ok: false, message: "Horário fora do funcionamento configurado para esta loja." });
        }
      }
    } else {
      const regraHorario = horarioValidoPorRegra(dataAgendamento, horario, loja);
      if (!regraHorario.ok) {
        return res.status(400).json(regraHorario);
      }
    }

    const bloqueioHorario = await buscarBloqueioDisponibilidade(client, loja, dataAgendamento, horario);
    if (bloqueioHorario) {
      return res.status(409).json({
        ok: false,
        message: `Horário indisponível. ${bloqueioHorario.motivo || "Escolha outro horário."}`.trim()
      });
    }

    if (!usaJornadaConfig) {
      // Unidade Santos/Gonzaga: almoço 14:00-14:45 em dias úteis (4 slots de 15 min)
      if (horario === "14:00" || horario === "14:15" || horario === "14:30" || horario === "14:45") {
        const lojaKeyPost = loja.toLowerCase().replace(/[^a-z]/g, "");
        if (lojaKeyPost.includes("gonzaga") || lojaKeyPost.includes("santos")) {
          const diaPost = new Date(dataAgendamento + "T12:00:00").getDay();
          if (!isGonzagaSemAlmocoEm29Jul2026(loja, dataAgendamento) && diaPost >= 1 && diaPost <= 5) {
            return res.status(400).json({ ok: false, message: "Horário de almoço não disponível para esta unidade." });
          }
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

    // Cria lead no Kommo em background — garante lembrete 24h e recuperação automáticos
    const agRow = agendamento.rows[0];
    if (agRow.whatsapp) {
      setImmediate(() => sincronizarAgendamentoKommo(agRow).catch(e =>
        console.error('[landing-page] Erro ao sincronizar Kommo:', e.message)
      ));
    }
    setImmediate(() => mailingboss.sincronizarLead(agRow, "landing_page"));

    res.status(201).json({
      ok: true,
      message: "Agendamento criado com sucesso.",
      id: agRow.id,
      agendamentoId: agRow.id,
      agendamento: agRow,
      cliente_id: cliente.rows[0].id
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);

    if (responderErroBanco(res, error, {
      uniq_agendamento_ativo_slot: "Esse horário acabou de ser reservado. Escolha outro horário."
    })) return;

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

    // O painel já bloqueia isso no navegador (campo "Consultor / Vendedor *"),
    // mas só no cliente — quem chamasse a API direto passava por cima. Sem o
    // nome real, "Agendado por" no painel mostra só a conta de login (ex.:
    // "Consultor de Vendas - Enseada", que várias pessoas compartilham na
    // mesma loja), e ninguém consegue saber quem realmente atendeu. Vale só
    // para esta rota (formulário do painel) — o agendamento público e o bot
    // do Kommo criam agendamento sem um humano do time envolvido ainda.
    const consultorNome = clean(
      b.proprietario_nome || b.proprietarioNome || b.vendedor_atendeu_nome ||
      b.vendedorAtendeuNome || b.vendedor_nome || b.vendedorNome || b.consultor_responsavel
    );
    if (!consultorNome) {
      return res.status(400).json({ ok: false, message: "Informe o nome do Consultor / Vendedor responsável." });
    }

    // Sem validar aqui, uma data mal formada vinda do cliente/bot vai direto
    // para a coluna DATE sem checagem nenhuma -- já causou agendamentos
    // gravados com ano 26, 2626, 62026, 72026 em produção (ver toPgDate).
    const dataAgendamentoBruta = clean(b.data_agendamento || b.dataAgendamento || b.data || "");
    let dataAgendamento = null;
    if (dataAgendamentoBruta) {
      dataAgendamento = toPgDate(dataAgendamentoBruta);
      if (!dataAgendamento) return res.status(400).json({ ok: false, message: "Data do agendamento inválida." });
    }

    const actorNome = clean(req.session.nome || "Usuário autenticado");
    const actorEmail = clean(req.session.email);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const bloqueioHorario = await buscarBloqueioDisponibilidade(
        client,
        b.loja || "",
        dataAgendamento || "",
        b.horario || ""
      );
      if (bloqueioHorario) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          message: `Horário indisponível. ${bloqueioHorario.motivo || "Escolha outro horário."}`.trim()
        });
      }
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
        dataAgendamento,
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
      // Sync não-bloqueante para o Kommo e Mailingboss
      setImmediate(() => sincronizarAgendamentoKommo(result.rows[0]));
      setImmediate(() => mailingboss.sincronizarLead(result.rows[0], "painel"));
      res.json({ ok: true, message: "Agendamento salvo no PostgreSQL.", agendamento: result.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (responderErroBanco(res, error)) return;
    res.status(500).json({ ok: false, message: "Erro ao salvar agendamento.", error: error.message });
  }
});

app.get("/api/agendamentos", async (req, res) => {
  try {
    const q = req.query;
    const params = [];
    const conditions = ["a.excluido_em IS NULL"];

    // Loja: session-enforced for store-scoped roles; query param only for admin/central
    if (!canViewAllStores(req.session)) {
      if (!req.session.loja) return res.json({ ok: true, total: 0, agendamentos: [] });
      params.push(req.session.loja);
      conditions.push(storeSql("a.loja", `$${params.length}`));
    } else if (q.loja) {
      params.push(q.loja);
      conditions.push(storeSql("a.loja", `$${params.length}`));
    }

    // Date range — push to SQL so records beyond LIMIT are reachable
    const periodoDias = Number(q.periodoDias || 0);
    let dataDe = String(q.de || q.dataDe || "").trim();
    let dataAte = String(q.ate || q.dataAte || "").trim();

    if (periodoDias > 0 && !dataDe && !dataAte) {
      const hoje = hojeBrasil();
      const inicio = new Date(hoje + "T12:00:00");
      inicio.setDate(inicio.getDate() - (periodoDias - 1));
      dataDe = inicio.toISOString().slice(0, 10);
      dataAte = hoje;
    }

    if (dataDe) { params.push(dataDe); conditions.push(`a.data_agendamento >= $${params.length}`); }
    if (dataAte) { params.push(dataAte); conditions.push(`a.data_agendamento <= $${params.length}`); }

    if (q.status) { params.push(q.status); conditions.push(`LOWER(COALESCE(a.status,'')) = LOWER($${params.length})`); }
    if (q.statusOS) { params.push(q.statusOS); conditions.push(`LOWER(COALESCE(a.status_os,'')) = LOWER($${params.length})`); }
    // Etapa do lead (Novo Lead/Bot Ativo/Atendimento Humano/Agendado/Compareceu/
    // Vendido/Perdido) — mesmo cálculo usado no CRM Kanban (CRM_ESTAGIO_CASE_SQL,
    // definido mais abaixo no arquivo; seguro referenciar aqui porque o módulo
    // inteiro já terminou de carregar antes de qualquer requisição chegar).
    if (q.estagio) { params.push(q.estagio); conditions.push(`(${CRM_ESTAGIO_CASE_SQL}) = $${params.length}`); }

    // Sem filtro de data: LIMIT 1000 (carga inicial rápida). Com filtro: até 5000.
    const temFiltroData = !!(dataDe || dataAte);
    const limite = Math.min(Number(q.limit || 0) || (temFiltroData ? 5000 : 1000), 5000);

    const result = await pool.query(
      `SELECT a.*, (${CRM_ESTAGIO_CASE_SQL}) AS estagio
         FROM agendamentos a
         LEFT JOIN kommo_bot_states s ON s.lead_id = a.kommo_lead_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY a.id DESC LIMIT ${limite}`,
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
    // O formulário sempre reenvia o status/presença atual junto com qualquer
    // edição (mesmo quando só se está corrigindo nome/WhatsApp/e-mail), então
    // só bloqueamos quando o valor de status realmente MUDA para compareceu/
    // não-compareceu — reenviar o valor já existente não deve travar a edição
    // de outros campos (ex: corrigir dado do cliente num agendamento que já
    // está marcado Compareceu ou Não Compareceu).
    const statusEnviadoPresenca = Object.prototype.hasOwnProperty.call(b, "status") ||
      Object.prototype.hasOwnProperty.call(b, "statusAgenda");
    if (roleOf(req.session) === "atendimento central") {
      const statusAtualPresenca = clean(current.rows[0].status).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const statusNovoPresenca = clean(b.status || b.statusAgenda).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const statusMudouPresenca = statusEnviadoPresenca && statusNovoPresenca !== statusAtualPresenca;
      const alteraPresenca = Object.prototype.hasOwnProperty.call(b, "compareceu") ||
        Object.prototype.hasOwnProperty.call(b, "atendimento_realizado") ||
        Object.prototype.hasOwnProperty.call(b, "atendimentoRealizado") ||
        (statusMudouPresenca && ["compareceu", "nao compareceu"].includes(statusNovoPresenca));
      if (alteraPresenca) {
        return res.status(403).json({ ok: false, message: "Atendimento Central não pode registrar check-in ou presença." });
      }
    }
    if (roleOf(req.session) === "comprador") {
      const statusAtualPresenca = clean(current.rows[0].status).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const statusNovoPresenca = clean(b.status || b.statusAgenda).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      const statusMudouPresenca = statusEnviadoPresenca && statusNovoPresenca !== statusAtualPresenca;
      const alteraPresenca = Object.prototype.hasOwnProperty.call(b, "compareceu") ||
        Object.prototype.hasOwnProperty.call(b, "atendimento_realizado") ||
        Object.prototype.hasOwnProperty.call(b, "atendimentoRealizado") ||
        (statusMudouPresenca && ["compareceu", "nao compareceu"].includes(statusNovoPresenca));
      if (alteraPresenca) {
        return res.status(403).json({ ok: false, message: "Comprador não pode registrar check-in ou presença." });
      }
    }
    const hasPatologia = Object.prototype.hasOwnProperty.call(b, "patologia");
    let patologiaAtualizada = null;
    if (hasPatologia) {
      if (!hasRole(req.session, ["admin", "optometrista"])) {
        return res.status(403).json({ ok: false, message: "Somente o optometrista pode registrar patologia." });
      }
      const valorPatologia = clean(b.patologia).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const opcoesPatologia = { sim: "Sim", nao: "Não", pendente: "Pendente" };
      patologiaAtualizada = opcoesPatologia[valorPatologia] || null;
      if (!patologiaAtualizada) {
        return res.status(400).json({ ok: false, message: "Patologia deve ser marcada como Sim ou Não." });
      }
    }
    const hasResultadoOptometrista = Object.prototype.hasOwnProperty.call(b, "resultado_optometrista") ||
      Object.prototype.hasOwnProperty.call(b, "resultadoOptometrista");
    let resultadoOptometristaAtualizado = null;
    let statusResultadoOptometrista = null;
    let compareceuResultadoOptometrista = null;
    if (hasResultadoOptometrista) {
      if (!hasRole(req.session, ["admin", "optometrista"])) {
        return res.status(403).json({ ok: false, message: "Somente o optometrista pode registrar o resultado do atendimento." });
      }
      const valorResultado = clean(b.resultado_optometrista || b.resultadoOptometrista)
        .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
      const opcoesResultado = {
        checkinsimveio: "Check-in Sim veio",
        checkinsim: "Check-in Sim veio",
        sim: "Check-in Sim veio",
        checkinnaoveio: "Check-in Não veio",
        checkinnao: "Check-in Não veio",
        nao: "Check-in Não veio",
        patologia: "Patologia"
      };
      resultadoOptometristaAtualizado = opcoesResultado[valorResultado] || null;
      if (!resultadoOptometristaAtualizado) {
        return res.status(400).json({ ok: false, message: "Resultado deve ser Check-in Sim veio, Check-in Não veio ou Patologia." });
      }
      if (resultadoOptometristaAtualizado === "Check-in Não veio") {
        statusResultadoOptometrista = "Não Compareceu";
        compareceuResultadoOptometrista = "Não";
        patologiaAtualizada = "Pendente";
      } else {
        statusResultadoOptometrista = "Compareceu";
        compareceuResultadoOptometrista = "Sim";
        patologiaAtualizada = resultadoOptometristaAtualizado === "Patologia" ? "Sim" : "Pendente";
      }
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
        "observacao", "patologia", "resultado_optometrista", "resultadoOptometrista",
        "ultima_alteracao_por_nome", "ultima_alteracao_por_email", "ultima_alteracao_em"
      ]);
      const forbidden = Object.keys(b).filter((key) => !allowed.has(key));
      if (forbidden.length) {
        return res.status(403).json({ ok: false, message: "Optometrista só pode atualizar presença, status e observação." });
      }
    }
    if (["consultor de vendas", "vendedor"].includes(roleOf(req.session))) {
      // Gonzaga/Santos tem controle total da OS (inclusive valor/desconto/vendedor);
      // as demais lojas seguem restritas a dados cadastrais, sem OS nem financeiro.
      const blocked = isGonzagaSantosStore(req.session.loja) ? [] : [
        "valor_venda", "valorVenda", "desconto", "vendedor_nome", "vendedorNome",
        "numero_os", "numeroOS", "status_os", "statusOS", "data_abertura_os", "dataAberturaOS",
        "data_entrada_os", "dataEntradaOS", "data_finalizacao_os", "dataFinalizacaoOS",
        "data_entrega_os", "dataEntregaOS"
      ];
      if (blocked.some((key) => Object.prototype.hasOwnProperty.call(b, key))) {
        return res.status(403).json({ ok: false, message: "Este perfil não pode alterar estes dados de OS ou valores financeiros." });
      }
    }
    if (String(b.nome || b.nomeCompleto || "").toLowerCase().includes("teste")) {
      return res.status(400).json({ ok: false, message: "Não é permitido cadastrar cliente com nome TESTE." });
    }

    const actorNome = clean(req.session.nome || "Usuário autenticado");
    const actorEmail = clean(req.session.email);

    // Reagendar para uma nova data sem informar presença/status/resultado junto
    // reabre o registro como pendente — evita ficar com "Não Compareceu" ou
    // "Check-in Não veio" congelados de uma visita anterior após a repescagem.
    // Vale para qualquer perfil que possa alterar a data.
    // Sem validar aqui, uma data mal formada vinda do cliente/bot vai direto
    // para a coluna DATE sem checagem nenhuma -- já causou agendamentos
    // gravados com ano 26, 2626, 62026, 72026 em produção (ver toPgDate).
    const dataAgendamentoBrutaPatch = clean(b.data_agendamento || b.dataAgendamento || "");
    let novaDataAgendamento = null;
    if (dataAgendamentoBrutaPatch) {
      novaDataAgendamento = toPgDate(dataAgendamentoBrutaPatch);
      if (!novaDataAgendamento) return res.status(400).json({ ok: false, message: "Data do agendamento inválida." });
    }
    const dataAgendamentoAtual = current.rows[0].data_agendamento
      ? String(current.rows[0].data_agendamento).slice(0, 10) : null;
    const isReagendamentoDeData = Boolean(novaDataAgendamento) && novaDataAgendamento !== dataAgendamentoAtual;
    const alterouPresencaOuStatusManualmente = Object.prototype.hasOwnProperty.call(b, "status") ||
      Object.prototype.hasOwnProperty.call(b, "statusAgenda") ||
      Object.prototype.hasOwnProperty.call(b, "compareceu") ||
      hasResultadoOptometrista;
    const reagendamentoLimpo = isReagendamentoDeData && !alterouPresencaOuStatusManualmente;

    // Uma venda válida é evidência definitiva de que o cliente compareceu.
    // Mantemos cancelamentos/reembolsos fora desta regra para não transformar
    // uma OS desfeita em compra concluída.
    const valorVendaRecebido = Object.prototype.hasOwnProperty.call(b, "valor_venda")
      ? b.valor_venda
      : (Object.prototype.hasOwnProperty.call(b, "valorVenda") ? b.valorVenda : current.rows[0].valor_venda);
    const valorVendaFinal = Number(String(valorVendaRecebido ?? 0).replace(",", ".")) || 0;
    const statusAgendaSolicitado = clean(statusResultadoOptometrista || b.status || b.statusAgenda || current.rows[0].status);
    const statusOSSolicitado = clean(b.status_os || b.statusOS || current.rows[0].status_os);
    const normalizarStatus = (valor) => clean(valor).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const statusAgendaNormalizado = normalizarStatus(statusAgendaSolicitado);
    const statusOSNormalizado = normalizarStatus(statusOSSolicitado);
    const compraAtiva = valorVendaFinal > 0 &&
      statusAgendaNormalizado !== "cancelado" &&
      !["cancelada", "cancelado", "reembolso"].includes(statusOSNormalizado);
    const compareceuVenda = compraAtiva ? "Sim" : null;
    const statusVenda = compraAtiva && ["agendado", "confirmado", "nao compareceu"].includes(statusAgendaNormalizado)
      ? "Compareceu"
      : null;
    // O reset de reagendamento só vale quando não há venda ativa segurando o
    // registro — uma venda já conta a história real do atendimento, então não
    // deve virar "Agendado"/pendente nem ter o resultado do optometrista apagado.
    const reagendamentoSemVenda = reagendamentoLimpo && !compraAtiva;
    const statusReagendamento = reagendamentoSemVenda ? "Agendado" : null;
    const compareceuReagendamento = reagendamentoSemVenda ? "Pendente" : null;
    const limparResultadoOptometrista = reagendamentoSemVenda;

    const client = await pool.connect();
    let result;
    try {
      await client.query("BEGIN");
      const alteraHorarioAgenda = ["loja", "data_agendamento", "dataAgendamento", "horario"]
        .some((key) => Object.prototype.hasOwnProperty.call(b, key));
      if (alteraHorarioAgenda) {
        const bloqueioHorario = await buscarBloqueioDisponibilidade(
          client,
          b.loja || current.rows[0].loja || "",
          novaDataAgendamento || current.rows[0].data_agendamento || "",
          b.horario || current.rows[0].horario || ""
        );
        if (bloqueioHorario) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            ok: false,
            message: `Horário indisponível. ${bloqueioHorario.motivo || "Escolha outro horário."}`.trim()
          });
        }
      }
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
        patologia = COALESCE($29, patologia),
        resultado_optometrista = CASE WHEN $31::text = 'LIMPAR' THEN NULL ELSE COALESCE($30, resultado_optometrista) END,
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
        novaDataAgendamento,
        b.horario || null,
        b.observacao || null,
        statusVenda || statusResultadoOptometrista || b.status || b.statusAgenda || statusReagendamento || null,
        compareceuVenda || compareceuResultadoOptometrista || b.compareceu || compareceuReagendamento || null,
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
        b.excluir_lead ? 'LIXEIRA' : (b.restaurar_lead ? 'RESTAURAR' : null),
        patologiaAtualizada,
        resultadoOptometristaAtualizado,
        limparResultadoOptometrista ? 'LIMPAR' : null
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
        if (nc2(before.patologia) !== nc2(after.patologia)) mudancas.push(`Patologia: ${before.patologia || 'Pendente'} → ${after.patologia || 'Pendente'}`);
        if (nc2(before.resultado_optometrista) !== nc2(after.resultado_optometrista)) mudancas.push(`Resultado optometrista: ${before.resultado_optometrista || 'Pendente'} → ${after.resultado_optometrista || 'Pendente'}`);
        if (!before.numero_os && after.numero_os) mudancas.push(`OS aberta: ${after.numero_os}`);
        if (before.status_os !== after.status_os && after.status_os) mudancas.push(`Status OS: ${after.status_os}`);
        if (before.data_agendamento !== after.data_agendamento || before.horario !== after.horario)
          mudancas.push(`Reagendado: ${dtBR(after.data_agendamento)} às ${after.horario || ''}`);

        if (!mudancas.length) return;
        await adicionarNotaKommo(leadId, `📋 Atualização — ${after.nome || ''}:\n` + mudancas.map(m => `• ${m}`).join('\n'));

        // Aplica semáforo nao-compareceu no Kommo → aciona recovery.js no dia seguinte
        if (nc2(after.compareceu) === 'nao' && nc2(before.compareceu) !== 'nao') {
          const kommoLabels = require('./kommo/labels');
          await kommoLabels.applyTrafficLight(leadId, 'Não Compareceu').catch(() => {});
        }
      } catch (_) {}
    });

    res.json({ ok: true, agendamento: result.rows[0] });
  } catch (error) {
    if (responderErroBanco(res, error)) return;
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Gera notificações retroativas para agendamentos existentes com resultado de visita
app.post("/api/admin/notificacoes/gerar-retroativo", requireSuperAdmin, async (req, res) => {
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
    const check = await pool.query('SELECT * FROM agendamentos WHERE id = $1', [id]);
    if (!check.rows.length) return res.status(404).json({ ok: false, message: "Agendamento não encontrado." });
    if (!check.rows[0].excluido_em) {
      return res.status(400).json({ ok: false, message: "Mova o lead para a lixeira antes de excluir permanentemente." });
    }
    // Era a única ação do sistema sem rastro no histórico -- uma exclusão
    // permanente não deixava nenhum vestígio de quem/quando/o quê.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await saveAppointmentBackup(client, {
        action: "EXCLUSAO_PERMANENTE",
        before: check.rows[0],
        session: req.session
      });
      await client.query('DELETE FROM agendamentos WHERE id = $1', [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
    // Mesma validação já aplicada em agendamentos/usuarios: um nome de loja
    // fora do cadastro oficial (ex: nome legado da loja) faz o cliente nunca
    // ser contado nos totais da própria loja. Já aconteceu com 41 clientes
    // da Ademar de Barros gravados com "Santo Antônio".
    let lojaOrigem = null;
    if (b.loja_origem) {
      lojaOrigem = normalizeLojaPublica(b.loja_origem);
      if (!lojaOrigem) return res.status(400).json({ ok: false, message: "Loja não reconhecida. Selecione uma das lojas cadastradas no sistema." });
    }
    if (!ensureStoreAccess(req.session, lojaOrigem || req.session.loja)) {
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
        lojaOrigem,
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

app.get("/api/vendedores-consultores", async (req, res) => {
  try {
    let loja = clean(req.query.loja || "");
    if (!canViewAllStores(req.session)) {
      if (loja && !ensureStoreAccess(req.session, loja)) {
        return res.status(403).json({ ok: false, message: "Sem permissão para consultar esta loja." });
      }
      loja = clean(req.session.loja);
    }
    const params = [];
    const conditions = ["ativo = true"];
    if (loja) {
      params.push(loja);
      conditions.push(storeSql("loja", `$${params.length}`));
    }
    const result = await pool.query(
      `SELECT id, nome, loja, ativo, criado_em, atualizado_em
       FROM vendedores_consultores
       WHERE ${conditions.join(" AND ")}
       ORDER BY loja, nome`,
      params
    );
    res.json({ ok: true, vendedoresConsultores: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar vendedores e consultores.", error: error.message });
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

    const params = [];
    const conds  = [
      "excluido_em IS NULL",
      "nome NOT ILIKE '%teste%'",
      "COALESCE(loja, '') NOT ILIKE '%teste%'",
      "(COALESCE(valor_venda, 0) > 0 OR COALESCE(desconto, 0) > 0)",
    ];

    if (!canViewAllStores(req.session)) {
      if (!req.session.loja) return res.json({ ok: true, total: 0, faturamentos: [] });
      params.push(req.session.loja);
      conds.push(storeSql("loja", `$${params.length}`));
    }

    if (req.query.vendedor) {
      params.push(`%${req.query.vendedor}%`);
      conds.push(`COALESCE(NULLIF(vendedor_nome,''), NULLIF(consultor_responsavel,''), NULLIF(vendedor_atendeu_nome,''), proprietario_nome, responsavel, '') ILIKE $${params.length}`);
    }
    if (req.query.proprietario) {
      params.push(`%${req.query.proprietario}%`);
      conds.push(`COALESCE(NULLIF(proprietario_nome,''), NULLIF(agendado_por_nome,''), NULLIF(responsavel,''), '') ILIKE $${params.length}`);
    }
    if (req.query.origem) {
      params.push(`%${req.query.origem}%`);
      conds.push(`COALESCE(origem, '') ILIKE $${params.length}`);
    }
    if (req.query.dataDe) {
      params.push(req.query.dataDe);
      conds.push(`COALESCE(data_finalizacao_os, data_entrega_os, data_entrada_os, data_agendamento) >= $${params.length}::date`);
    }
    if (req.query.dataAte) {
      params.push(req.query.dataAte);
      conds.push(`COALESCE(data_finalizacao_os, data_entrega_os, data_entrada_os, data_agendamento) <= $${params.length}::date`);
    }

    const where  = `WHERE ${conds.join(" AND ")}`;
    const result = await pool.query(
      `SELECT id, id AS agendamento_id, nome AS cliente_nome, numero_os, status_os, loja,
          COALESCE(origem, '') AS origem,
          COALESCE(NULLIF(vendedor_nome,''), NULLIF(consultor_responsavel,''), NULLIF(vendedor_atendeu_nome,''), proprietario_nome, responsavel, '') AS vendedor,
          COALESCE(NULLIF(proprietario_nome,''), NULLIF(agendado_por_nome,''), NULLIF(responsavel,''), '') AS proprietario_nome,
          COALESCE(valor_venda, 0)::numeric AS valor_total,
          COALESCE(desconto, 0)::numeric AS desconto,
          CASE WHEN COALESCE(valor_venda, 0) > 0 THEN 'Venda registrada' ELSE 'Sem venda' END AS status_pagamento,
          COALESCE(data_finalizacao_os, data_entrega_os, data_entrada_os, data_agendamento, criado_em::date) AS data_venda
       FROM agendamentos ${where}
       ORDER BY COALESCE(data_finalizacao_os, data_entrega_os, data_entrada_os, data_agendamento, criado_em::date) DESC, id DESC
       LIMIT 1000`,
      params
    );

    res.json({ ok: true, total: result.rows.length, faturamentos: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

function normalizarMetaPayload(body = {}) {
  const competenciaRaw = clean(body.competencia);
  if (!/^\d{4}-\d{2}$/.test(competenciaRaw)) throw new Error("Competência inválida. Use mês e ano.");
  const tipo = clean(body.tipo_escopo || body.tipoEscopo).toLowerCase();
  if (!["grupo", "loja", "consultor"].includes(tipo)) throw new Error("Tipo de meta inválido.");
  const loja = clean(body.loja);
  const vendedorId = Number(body.vendedor_consultor_id || body.vendedorConsultorId || 0) || null;
  if (tipo === "loja" && !loja) throw new Error("Selecione a loja da meta.");
  if (tipo === "consultor" && (!loja || !vendedorId)) throw new Error("Selecione a loja e o consultor da meta.");
  const chaveEscopo = tipo === "grupo"
    ? "grupo:tgt"
    : tipo === "loja"
      ? `loja:${normalizeStoreKey(loja)}`
      : `consultor:${vendedorId}`;
  const numero = (value, max = null) => {
    const parsed = numberFromBR(value);
    if (parsed < 0 || (max !== null && parsed > max)) throw new Error("As metas devem usar valores válidos e não negativos.");
    return parsed;
  };
  return {
    competencia: `${competenciaRaw}-01`, tipo, chaveEscopo,
    loja: tipo === "grupo" ? null : loja,
    vendedorId: tipo === "consultor" ? vendedorId : null,
    metaFaturamento: numero(body.meta_faturamento),
    metaVendas: Math.trunc(numero(body.meta_vendas)),
    metaAgendamentos: Math.trunc(numero(body.meta_agendamentos)),
    metaComparecimento: numero(body.meta_comparecimento, 100),
    metaConversao: numero(body.meta_conversao, 100),
    metaTicketMedio: numero(body.meta_ticket_medio),
    limiteDesconto: numero(body.limite_desconto, 100),
    metaPrazoOsDias: Math.trunc(numero(body.meta_prazo_os_dias)),
    observacao: clean(body.observacao) || null,
    ativo: body.ativo !== false
  };
}

// ===============================
// CONFIGURAÇÕES — Admin e Atendimento Central
// ===============================

function requireAdminOuCentral(req, res, next) {
  if (!hasRole(req.session, ["admin", "atendimento central"])) {
    return res.status(403).json({ ok: false, message: "Acesso restrito ao Admin ou Atendimento Central." });
  }
  next();
}

app.get("/api/admin/configuracoes/kommo", requireAdminOuCentral, async (req, res) => {
  try {
    const subdomainBanco = await getConfigValor("kommo_subdomain");
    const accessTokenBanco = await getConfigValor("kommo_access_token");
    const webhookSecretBanco = await getConfigValor("kommo_webhook_secret");
    res.json({
      ok: true,
      subdomain: subdomainBanco || process.env.KOMMO_SUBDOMAIN || "",
      accessTokenConfigurado: !!(accessTokenBanco || process.env.KOMMO_ACCESS_TOKEN),
      webhookSecretConfigurado: !!(webhookSecretBanco || process.env.KOMMO_WEBHOOK_SECRET),
      origem: subdomainBanco || accessTokenBanco || webhookSecretBanco ? "banco" : "ambiente"
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar configuração do Kommo.", error: error.message });
  }
});

app.post("/api/admin/configuracoes/kommo", requireAdmin, async (req, res) => {
  try {
    if (!CONFIG_ENCRYPTION_KEY) {
      return res.status(503).json({ ok: false, message: "CONFIG_ENCRYPTION_KEY não configurada no Railway." });
    }
    const b = req.body || {};
    const subdomain = clean(b.subdomain);
    const accessToken = clean(b.accessToken);
    const webhookSecret = clean(b.webhookSecret);

    if (subdomain) await setConfigValor("kommo_subdomain", subdomain, { email: req.session.email });
    if (accessToken) await setConfigValor("kommo_access_token", accessToken, { criptografado: true, email: req.session.email });
    if (webhookSecret) await setConfigValor("kommo_webhook_secret", webhookSecret, { criptografado: true, email: req.session.email });

    if (subdomain || accessToken) {
      kommoClient.reconfigure({ subdomain: subdomain || undefined, accessToken: accessToken || undefined });
    }
    if (webhookSecret) {
      process.env.KOMMO_WEBHOOK_SECRET = webhookSecret;
    }

    res.json({ ok: true, message: "Configuração do Kommo salva. Já está em uso, sem precisar reiniciar o sistema." });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message || "Erro ao salvar configuração do Kommo." });
  }
});

app.post("/api/admin/configuracoes/kommo/testar", requireAdminOuCentral, async (req, res) => {
  try {
    await kommoClient.request("GET", "/account");
    res.json({ ok: true, message: "Conexão com o Kommo funcionando." });
  } catch (error) {
    res.status(502).json({ ok: false, message: error.message || "Não foi possível conectar ao Kommo." });
  }
});

app.get("/api/public/aparencia", (_req, res) => {
  res.json({ ok: true, aparencia: appearanceCache });
});

app.get("/api/admin/configuracoes/permissoes", requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    permissoes: { ...DEFAULT_ROLE_PERMISSIONS, ...rolePermissionsCache }
  });
});

app.post("/api/admin/configuracoes/permissoes", requireAdmin, async (req, res) => {
  const recebidas = req.body?.permissoes || {};
  const permitidas = {};
  for (const role of Object.keys(DEFAULT_ROLE_PERMISSIONS)) {
    const p = recebidas[role] || {};
    permitidas[role] = {
      canViewAll: !!p.canViewAll,
      canCreateAgendamento: !!p.canCreateAgendamento,
      canManageOS: !!p.canManageOS,
      canViewFinance: !!p.canViewFinance
    };
  }
  rolePermissionsCache = permitidas;
  await setConfigValor("permissoes_perfil", JSON.stringify(permitidas), { email: req.session.email });
  sessionRefreshCache.clear();
  res.json({ ok: true, message: "Permissões salvas.", permissoes: permitidas });
});

app.get("/api/admin/configuracoes/aparencia", requireAdmin, (_req, res) => {
  res.json({ ok: true, aparencia: appearanceCache });
});

app.post("/api/admin/configuracoes/aparencia", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const hex = (value, fallback) => /^#[0-9a-f]{6}$/i.test(clean(value)) ? clean(value) : fallback;
  const logoDataUrl = b.removerLogo
    ? ""
    : (clean(b.logoDataUrl) || appearanceCache.logoDataUrl || "");
  if (logoDataUrl && !/^data:image\/(png|jpeg);base64,/i.test(logoDataUrl)) {
    return res.status(400).json({ ok: false, message: "Use uma imagem PNG ou JPG válida." });
  }
  if (logoDataUrl.length > 900000) {
    return res.status(400).json({ ok: false, message: "O logotipo deve ter no máximo aproximadamente 650 KB." });
  }
  appearanceCache = {
    primaryColor: hex(b.primaryColor, appearanceCache.primaryColor),
    secondaryColor: hex(b.secondaryColor, appearanceCache.secondaryColor),
    logoDataUrl
  };
  await setConfigValor("aparencia_painel", JSON.stringify(appearanceCache), { email: req.session.email });
  res.json({ ok: true, message: "Aparência salva.", aparencia: appearanceCache });
});

app.post("/api/admin/configuracoes/lojas", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const nome = clean(b.nome);
  if (!nome) return res.status(400).json({ ok: false, message: "Informe o nome da unidade." });
  const result = await pool.query(
    `INSERT INTO lojas (gas_id, nome, cidade, endereco, ativo, origem_sync, atualizado_em)
     VALUES ($1,$2,$3,$4,true,'postgres',CURRENT_TIMESTAMP)
     RETURNING *`,
    [makeGasId("loja", nome), nome, clean(b.cidade) || null, clean(b.endereco) || null]
  );
  res.json({ ok: true, message: "Unidade criada.", loja: result.rows[0] });
});

app.patch("/api/admin/configuracoes/lojas/:id", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const result = await pool.query(
    `UPDATE lojas SET nome=COALESCE($1,nome), cidade=COALESCE($2,cidade),
       endereco=COALESCE($3,endereco), ativo=COALESCE($4,ativo), atualizado_em=CURRENT_TIMESTAMP
     WHERE id=$5 RETURNING *`,
    [clean(b.nome) || null, clean(b.cidade) || null, clean(b.endereco) || null,
      b.ativo === undefined ? null : !!b.ativo, req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ ok: false, message: "Unidade não encontrada." });
  res.json({ ok: true, message: "Unidade atualizada.", loja: result.rows[0] });
});

const DIA_SEMANA_VALIDOS = [0, 1, 2, 3, 4, 5, 6];

app.get("/api/admin/configuracoes/bloqueios-agenda", requireAdminOuCentral, async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, loja, data,
              TO_CHAR(hora_inicio,'HH24:MI') AS hora_inicio,
              TO_CHAR(hora_fim,'HH24:MI') AS hora_fim,
              motivo, criado_por, criado_em
         FROM bloqueios_disponibilidade
        WHERE data >= CURRENT_DATE
        ORDER BY data ASC, loja ASC`
    );
    res.json({
      ok: true,
      bloqueios: result.rows,
      sincronizadoCom: ["painel", "landing_page", "kommo"]
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar bloqueios da agenda.", error: error.message });
  }
});

app.post("/api/admin/configuracoes/bloqueios-agenda", requireAdminOuCentral, async (req, res) => {
  try {
    const b = req.body || {};
    const loja = normalizeLojaPublica(b.loja) || clean(b.loja);
    const data = toPgDate(b.data);
    const horaInicio = clean(b.hora_inicio) || null;
    const horaFim = clean(b.hora_fim) || null;
    const motivo = clean(b.motivo) || "Indisponibilidade configurada";

    if (!loja) return res.status(400).json({ ok: false, message: "Informe a loja." });
    if (!data) return res.status(400).json({ ok: false, message: "Informe uma data válida." });
    if (!!horaInicio !== !!horaFim) {
      return res.status(400).json({ ok: false, message: "Informe hora inicial e final, ou deixe ambas vazias para bloquear o dia inteiro." });
    }
    if (horaInicio && (
      !/^\d{2}:\d{2}$/.test(horaInicio) ||
      !/^\d{2}:\d{2}$/.test(horaFim) ||
      horaInicio >= horaFim
    )) {
      return res.status(400).json({ ok: false, message: "A faixa de horário informada é inválida." });
    }

    const result = await pool.query(
      `INSERT INTO bloqueios_disponibilidade
         (loja, data, hora_inicio, hora_fim, motivo, criado_por, criado_em)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)
       ON CONFLICT (loja, data) DO UPDATE SET
         hora_inicio = EXCLUDED.hora_inicio,
         hora_fim = EXCLUDED.hora_fim,
         motivo = EXCLUDED.motivo,
         criado_por = EXCLUDED.criado_por,
         criado_em = CURRENT_TIMESTAMP
       RETURNING id, loja, data,
                 TO_CHAR(hora_inicio,'HH24:MI') AS hora_inicio,
                 TO_CHAR(hora_fim,'HH24:MI') AS hora_fim,
                 motivo, criado_por, criado_em`,
      [loja, data, horaInicio, horaFim, motivo, req.session.email]
    );
    res.json({
      ok: true,
      message: "Bloqueio salvo e sincronizado com painel, landing page e Kommo.",
      bloqueio: result.rows[0],
      sincronizadoCom: ["painel", "landing_page", "kommo"]
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "Erro ao salvar bloqueio da agenda." });
  }
});

app.delete("/api/admin/configuracoes/bloqueios-agenda/:id", requireAdminOuCentral, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM bloqueios_disponibilidade WHERE id = $1
       RETURNING id, loja, data`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ ok: false, message: "Bloqueio não encontrado." });
    res.json({
      ok: true,
      message: "Bloqueio removido e horários liberados no painel, landing page e Kommo.",
      removido: result.rows[0],
      sincronizadoCom: ["painel", "landing_page", "kommo"]
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao remover bloqueio da agenda.", error: error.message });
  }
});

app.get("/api/admin/configuracoes/horarios-loja", requireAdminOuCentral, async (req, res) => {
  try {
    const params = [];
    let where = "";
    const lojaFiltro = clean(req.query.loja);
    if (lojaFiltro) {
      params.push(lojaFiltro);
      where = "WHERE LOWER(loja) = LOWER($1)";
    }
    const result = await pool.query(
      `SELECT * FROM horarios_funcionamento_loja ${where} ORDER BY loja ASC, dia_semana ASC`,
      params
    );
    const lojasResult = lojaFiltro
      ? { rows: [{ nome: normalizeLojaPublica(lojaFiltro) || lojaFiltro }] }
      : await pool.query(`SELECT nome FROM lojas WHERE ativo = true ORDER BY nome ASC`);
    const configurados = new Map(
      result.rows.map((row) => [`${clean(row.loja).toLowerCase()}|${row.dia_semana}`, row])
    );
    const horarios = [];
    for (const lojaRow of lojasResult.rows) {
      for (const diaSemana of DIA_SEMANA_VALIDOS) {
        const loja = lojaRow.nome;
        const configurado = configurados.get(`${clean(loja).toLowerCase()}|${diaSemana}`);
        if (configurado) {
          horarios.push({ ...configurado, origem: "configurado" });
          continue;
        }
        const padrao = jornadaPadrao(loja, diaSemana);
        horarios.push({
          id: null,
          loja,
          dia_semana: diaSemana,
          aberto: padrao.aberto,
          hora_inicio: padrao.horaInicio,
          hora_fim: padrao.horaFim,
          intervalo_inicio: padrao.intervaloInicio,
          intervalo_fim: padrao.intervaloFim,
          origem: "padrão"
        });
      }
    }
    res.json({ ok: true, horarios });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar horários de funcionamento.", error: error.message });
  }
});

app.post("/api/admin/configuracoes/horarios-loja", requireAdminOuCentral, async (req, res) => {
  try {
    const b = req.body || {};
    const loja = normalizeLojaPublica(b.loja) || clean(b.loja);
    const diaSemana = Math.trunc(Number(b.dia_semana));
    if (!loja) return res.status(400).json({ ok: false, message: "Informe a loja." });
    if (!DIA_SEMANA_VALIDOS.includes(diaSemana)) {
      return res.status(400).json({ ok: false, message: "Dia da semana inválido (use 0 a 6)." });
    }
    const aberto = b.aberto !== false;
    const horaInicio = aberto ? (clean(b.hora_inicio) || null) : null;
    const horaFim = aberto ? (clean(b.hora_fim) || null) : null;
    const intervaloInicio = clean(b.intervalo_inicio) || null;
    const intervaloFim = clean(b.intervalo_fim) || null;

    const result = await pool.query(
      `INSERT INTO horarios_funcionamento_loja
         (loja, dia_semana, aberto, hora_inicio, hora_fim, intervalo_inicio, intervalo_fim, atualizado_por_email, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)
       ON CONFLICT (loja, dia_semana) DO UPDATE SET
         aberto = EXCLUDED.aberto,
         hora_inicio = EXCLUDED.hora_inicio,
         hora_fim = EXCLUDED.hora_fim,
         intervalo_inicio = EXCLUDED.intervalo_inicio,
         intervalo_fim = EXCLUDED.intervalo_fim,
         atualizado_por_email = EXCLUDED.atualizado_por_email,
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING *`,
      [loja, diaSemana, aberto, horaInicio, horaFim, intervaloInicio, intervaloFim, req.session.email]
    );
    res.json({
      ok: true,
      message: "Horário salvo e sincronizado com painel, landing page e Kommo.",
      horario: result.rows[0],
      sincronizadoCom: ["painel", "landing_page", "kommo"]
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "Erro ao salvar horário de funcionamento." });
  }
});

app.delete("/api/admin/configuracoes/horarios-loja/:id", requireAdminOuCentral, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM horarios_funcionamento_loja WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, message: "Registro não encontrado." });
    res.json({
      ok: true,
      message: "Horário removido; a regra padrão já vale no painel, landing page e Kommo.",
      sincronizadoCom: ["painel", "landing_page", "kommo"]
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao remover horário.", error: error.message });
  }
});

app.get("/api/admin/configuracoes/horarios-optometrista", requireAdminOuCentral, async (req, res) => {
  try {
    const params = [];
    let where = "";
    const optometristaFiltro = clean(req.query.optometrista_id);
    if (optometristaFiltro) {
      params.push(Number(optometristaFiltro));
      where = "WHERE ho.optometrista_id = $1";
    }
    const result = await pool.query(
      `SELECT ho.*, o.nome AS optometrista_nome, o.loja AS optometrista_loja
         FROM horarios_optometrista ho
         JOIN optometristas o ON o.id = ho.optometrista_id
         ${where}
        ORDER BY o.nome ASC, ho.dia_semana ASC`,
      params
    );
    const optometristas = await pool.query(
      `SELECT id, nome, loja FROM optometristas
       WHERE ativo = true ${optometristaFiltro ? "AND id = $1" : ""}
       ORDER BY nome ASC`,
      optometristaFiltro ? [Number(optometristaFiltro)] : []
    );
    const porOptometrista = new Map();
    for (const row of result.rows) {
      const id = Number(row.optometrista_id);
      if (!porOptometrista.has(id)) porOptometrista.set(id, new Map());
      porOptometrista.get(id).set(Number(row.dia_semana), row);
    }
    const horarios = [];
    for (const optometrista of optometristas.rows) {
      const configurados = porOptometrista.get(Number(optometrista.id));
      for (const diaSemana of DIA_SEMANA_VALIDOS) {
        const configurado = configurados?.get(diaSemana);
        if (configurado) {
          horarios.push({ ...configurado, disponivel: true, origem: "configurado" });
          continue;
        }
        if (configurados?.size) {
          horarios.push({
            id: null,
            optometrista_id: optometrista.id,
            optometrista_nome: optometrista.nome,
            optometrista_loja: optometrista.loja,
            dia_semana: diaSemana,
            hora_inicio: null,
            hora_fim: null,
            disponivel: false,
            origem: "não atende"
          });
          continue;
        }
        const jornadaLoja = await resolverJornadaLoja(pool, optometrista.loja, diaSemana);
        horarios.push({
          id: null,
          optometrista_id: optometrista.id,
          optometrista_nome: optometrista.nome,
          optometrista_loja: optometrista.loja,
          dia_semana: diaSemana,
          hora_inicio: jornadaLoja.horaInicio,
          hora_fim: jornadaLoja.horaFim,
          disponivel: jornadaLoja.aberto,
          origem: "segue a loja"
        });
      }
    }
    res.json({ ok: true, horarios });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar horários de optometrista.", error: error.message });
  }
});

app.post("/api/admin/configuracoes/horarios-optometrista", requireAdminOuCentral, async (req, res) => {
  try {
    const b = req.body || {};
    const optometristaId = Math.trunc(Number(b.optometrista_id));
    const diaSemana = Math.trunc(Number(b.dia_semana));
    const horaInicio = clean(b.hora_inicio);
    const horaFim = clean(b.hora_fim);
    if (!optometristaId) return res.status(400).json({ ok: false, message: "Informe o optometrista." });
    if (!DIA_SEMANA_VALIDOS.includes(diaSemana)) {
      return res.status(400).json({ ok: false, message: "Dia da semana inválido (use 0 a 6)." });
    }
    if (!/^\d{2}:\d{2}$/.test(horaInicio) || !/^\d{2}:\d{2}$/.test(horaFim)) {
      return res.status(400).json({ ok: false, message: "Informe hora início e hora fim válidas (HH:MM)." });
    }

    const result = await pool.query(
      `INSERT INTO horarios_optometrista (optometrista_id, dia_semana, hora_inicio, hora_fim, atualizado_por_email, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,CURRENT_TIMESTAMP)
       ON CONFLICT (optometrista_id, dia_semana) DO UPDATE SET
         hora_inicio = EXCLUDED.hora_inicio,
         hora_fim = EXCLUDED.hora_fim,
         atualizado_por_email = EXCLUDED.atualizado_por_email,
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING *`,
      [optometristaId, diaSemana, horaInicio, horaFim, req.session.email]
    );
    res.json({
      ok: true,
      message: "Horário do optometrista salvo e sincronizado com painel, landing page e Kommo.",
      horario: result.rows[0],
      sincronizadoCom: ["painel", "landing_page", "kommo"]
    });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "Erro ao salvar horário do optometrista." });
  }
});

app.delete("/api/admin/configuracoes/horarios-optometrista/:id", requireAdminOuCentral, async (req, res) => {
  try {
    const result = await pool.query(`DELETE FROM horarios_optometrista WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, message: "Registro não encontrado." });
    res.json({
      ok: true,
      message: "Horário removido; o optometrista volta a seguir a loja no painel, landing page e Kommo.",
      sincronizadoCom: ["painel", "landing_page", "kommo"]
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao remover horário.", error: error.message });
  }
});

app.get("/api/admin/configuracoes/optometristas-loja", requireAdminOuCentral, async (req, res) => {
  try {
    const loja = normalizeLojaPublica(req.query.loja || "") || clean(req.query.loja);
    if (!loja) return res.json({ ok: true, optometristas: [] });
    const result = await pool.query(
      `SELECT id, nome, loja FROM optometristas
       WHERE ativo = true
         AND LOWER(REGEXP_REPLACE(loja, '\\s*-\\s*', ' ', 'g')) = LOWER(REGEXP_REPLACE($1, '\\s*-\\s*', ' ', 'g'))
       ORDER BY nome ASC`,
      [loja]
    );
    res.json({ ok: true, optometristas: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar optometristas da loja.", error: error.message });
  }
});

const META_SELECT = `SELECT m.*, v.nome AS vendedor_consultor_nome
  FROM metas_desempenho m
  LEFT JOIN vendedores_consultores v ON v.id = m.vendedor_consultor_id`;

app.get("/api/admin/metas", requireAdmin, async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    if (/^\d{4}-\d{2}$/.test(clean(req.query.competencia))) {
      params.push(`${clean(req.query.competencia)}-01`);
      conditions.push(`m.competencia = $${params.length}::date`);
    }
    if (req.query.ativas !== "false") conditions.push("m.ativo = true");
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(`${META_SELECT} ${where} ORDER BY m.competencia DESC, m.tipo_escopo, m.loja, v.nome`, params);
    res.json({ ok: true, metas: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar metas.", error: error.message });
  }
});

app.post("/api/admin/metas", requireAdmin, async (req, res) => {
  try {
    const m = normalizarMetaPayload(req.body);
    if (m.vendedorId) {
      const vendedor = await pool.query(`SELECT id, loja FROM vendedores_consultores WHERE id = $1 AND ativo = true`, [m.vendedorId]);
      if (!vendedor.rows.length || normalizeStoreKey(vendedor.rows[0].loja) !== normalizeStoreKey(m.loja)) {
        return res.status(400).json({ ok: false, message: "Consultor não pertence à loja selecionada." });
      }
    }
    const values = [m.competencia,m.tipo,m.chaveEscopo,m.loja,m.vendedorId,m.metaFaturamento,m.metaVendas,m.metaAgendamentos,m.metaComparecimento,m.metaConversao,m.metaTicketMedio,m.limiteDesconto,m.metaPrazoOsDias,m.observacao,m.ativo,req.session.email];
    const result = await pool.query(
      `INSERT INTO metas_desempenho (
        competencia,tipo_escopo,chave_escopo,loja,vendedor_consultor_id,
        meta_faturamento,meta_vendas,meta_agendamentos,meta_comparecimento,meta_conversao,
        meta_ticket_medio,limite_desconto,meta_prazo_os_dias,observacao,ativo,
        criado_por_email,atualizado_por_email,atualizado_em
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,CURRENT_TIMESTAMP)
      ON CONFLICT (competencia, chave_escopo) DO UPDATE SET
        loja=EXCLUDED.loja,vendedor_consultor_id=EXCLUDED.vendedor_consultor_id,
        meta_faturamento=EXCLUDED.meta_faturamento,meta_vendas=EXCLUDED.meta_vendas,
        meta_agendamentos=EXCLUDED.meta_agendamentos,meta_comparecimento=EXCLUDED.meta_comparecimento,
        meta_conversao=EXCLUDED.meta_conversao,meta_ticket_medio=EXCLUDED.meta_ticket_medio,
        limite_desconto=EXCLUDED.limite_desconto,meta_prazo_os_dias=EXCLUDED.meta_prazo_os_dias,
        observacao=EXCLUDED.observacao,ativo=EXCLUDED.ativo,
        atualizado_por_email=EXCLUDED.atualizado_por_email,atualizado_em=CURRENT_TIMESTAMP
      RETURNING *`, values);
    res.json({ ok: true, message: "Meta salva com sucesso.", meta: result.rows[0] });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "Erro ao salvar meta." });
  }
});

app.patch("/api/admin/metas/:id", requireAdmin, async (req, res) => {
  try {
    const m = normalizarMetaPayload(req.body);
    if (m.vendedorId) {
      const vendedor = await pool.query(`SELECT id, loja FROM vendedores_consultores WHERE id = $1 AND ativo = true`, [m.vendedorId]);
      if (!vendedor.rows.length || normalizeStoreKey(vendedor.rows[0].loja) !== normalizeStoreKey(m.loja)) {
        return res.status(400).json({ ok: false, message: "Consultor não pertence à loja selecionada." });
      }
    }
    const result = await pool.query(
      `UPDATE metas_desempenho SET competencia=$1,tipo_escopo=$2,chave_escopo=$3,loja=$4,vendedor_consultor_id=$5,
       meta_faturamento=$6,meta_vendas=$7,meta_agendamentos=$8,meta_comparecimento=$9,meta_conversao=$10,
       meta_ticket_medio=$11,limite_desconto=$12,meta_prazo_os_dias=$13,observacao=$14,ativo=$15,
       atualizado_por_email=$16,atualizado_em=CURRENT_TIMESTAMP WHERE id=$17 RETURNING *`,
      [m.competencia,m.tipo,m.chaveEscopo,m.loja,m.vendedorId,m.metaFaturamento,m.metaVendas,m.metaAgendamentos,m.metaComparecimento,m.metaConversao,m.metaTicketMedio,m.limiteDesconto,m.metaPrazoOsDias,m.observacao,m.ativo,req.session.email,req.params.id]);
    if (!result.rows.length) return res.status(404).json({ ok: false, message: "Meta não encontrada." });
    res.json({ ok: true, message: "Meta atualizada.", meta: result.rows[0] });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "Erro ao atualizar meta." });
  }
});

app.delete("/api/admin/metas/:id", requireAdmin, async (req, res) => {
  const result = await pool.query(
    `UPDATE metas_desempenho SET ativo=false, atualizado_por_email=$1, atualizado_em=CURRENT_TIMESTAMP WHERE id=$2 RETURNING id`,
    [req.session.email, req.params.id]);
  if (!result.rows.length) return res.status(404).json({ ok: false, message: "Meta não encontrada." });
  res.json({ ok: true, message: "Meta desativada." });
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
    const usuarios = result.rows.map((usuario) => isHugoAccount(usuario)
      ? { ...usuario, cargo: "super_admin", protected: true }
      : usuario);
    res.json({ ok: true, usuarios });
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
    if (cargo.toLowerCase() === "super_admin") {
      return res.status(403).json({ ok: false, message: "O perfil Super Admin é exclusivo e não pode ser atribuído pelo painel." });
    }
    if (email === HUGO_SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ ok: false, message: "A conta do criador é protegida e não pode ser recriada pelo painel." });
    }
    if (!nome || !email || !cargo) {
      return res.status(400).json({ ok: false, message: "Nome, e-mail e perfil são obrigatórios." });
    }
    if (password && password.length < 12) {
      return res.status(400).json({ ok: false, message: "A senha deve ter pelo menos 12 caracteres." });
    }
    // Mesma validação da landing page: um valor de loja fora do cadastro
    // oficial (ex: nome antigo/legado da loja) faz esse usuário nunca ver os
    // agendamentos da própria loja, porque o filtro de sessão exige match
    // exato contra agendamentos.loja. Já aconteceu com 4 contas da loja
    // Ademar de Barros gravadas com "Santo Antônio" (nome legado).
    let loja = null;
    if (b.loja) {
      loja = normalizeLojaPublica(b.loja);
      if (!loja) return res.status(400).json({ ok: false, message: "Loja não reconhecida. Selecione uma das lojas cadastradas no sistema." });
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
      [gasId, nome, email, passwordHash, cargo, loja, !!b.can_view_finance, b.ativo !== false]
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
    const target = await pool.query('SELECT id, email, cargo FROM usuarios WHERE id = $1', [id]);
    if (!target.rows.length) return res.status(404).json({ ok: false, message: "Usuário não encontrado." });
    if (isHugoAccount(target.rows[0])) {
      return res.status(403).json({ ok: false, message: "A conta do criador é protegida contra alterações pelo painel." });
    }
    if (clean(b.cargo).toLowerCase() === "super_admin") {
      return res.status(403).json({ ok: false, message: "O perfil Super Admin é exclusivo e não pode ser atribuído pelo painel." });
    }
    const password = String(b.password || b.senha || "");
    if (password && password.length < 12) {
      return res.status(400).json({ ok: false, message: "A senha deve ter pelo menos 12 caracteres." });
    }
    // Mesma validação da landing page (ver POST /api/usuarios acima): não
    // deixar gravar um nome de loja fora do cadastro oficial.
    let lojaParam = null;
    if (b.loja !== undefined) {
      const lojaRaw = clean(b.loja);
      if (lojaRaw) {
        lojaParam = normalizeLojaPublica(lojaRaw);
        if (!lojaParam) return res.status(400).json({ ok: false, message: "Loja não reconhecida. Selecione uma das lojas cadastradas no sistema." });
      }
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
        lojaParam,
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
    if (check.rows.length && isHugoAccount(check.rows[0])) {
      return res.status(403).json({ ok: false, message: "A conta do criador é permanente e não pode ser excluída." });
    }
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
    if (req.query.nome) {
      params.push(`%${req.query.nome}%`);
      conds.push(`feito_por_nome ILIKE $${params.length}`);
    }
    if (req.query.cliente) {
      params.push(`%${req.query.cliente}%`);
      conds.push(`cliente_nome ILIKE $${params.length}`);
    }
    if (req.query.origem) {
      params.push(`%${req.query.origem}%`);
      conds.push(`(COALESCE(registro_novo->>'origem','') ILIKE $${params.length} OR COALESCE(registro_anterior->>'origem','') ILIKE $${params.length})`);
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

// ── GET /api/admin/kommo/diagnostico ─────────────────────────────────────────
// Mostra: duplicatas, leads novos com mensagem, tempo médio de resposta
app.get("/api/admin/kommo/diagnostico", requireSuperAdmin, async (req, res) => {
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
app.post("/api/admin/kommo/dedup", requireSuperAdmin, async (req, res) => {
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
app.get("/api/admin/kommo/inspect", requireSuperAdmin, async (req, res) => {
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
app.get("/api/admin/kommo/bot-states", requireSuperAdmin, async (req, res) => {
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

// ── GET /api/admin/diag/loja-mismatch ─────────────────────────────────────────
// Auditoria de integridade: nome de loja legado ("Santo Antônio" em vez do
// oficial "Ademar de Barros") já apareceu em 5 tabelas diferentes nesta
// mesma sessão de trabalho, sempre achado manualmente. Esta rota varre TODA
// tabela com coluna de loja de uma vez, comparando cada valor distinto
// contra o cadastro oficial ativo (tabela `lojas`) com a mesma normalização
// usada em produção (acento/maiúscula não importam, mas o texto tem que
// bater). Quando aparecer uma trava nova ou uma tabela nova com coluna de
// loja, só adicionar em TABELAS_COM_LOJA abaixo.
const TABELAS_COM_LOJA = [
  { tabela: "usuarios", flagAtivo: "ativo" },
  { tabela: "vendedores_consultores", flagAtivo: "ativo" },
  { tabela: "optometristas", flagAtivo: "ativo" },
  { tabela: "metas_desempenho", flagAtivo: "ativo" },
  { tabela: "agendamentos", flagExcluido: "excluido_em" },
  { tabela: "bloqueios_disponibilidade" },
  { tabela: "faturamentos" },
  { tabela: "historico_os" },
  { tabela: "desempenho_anuncios" },
  { tabela: "horarios_funcionamento_loja" }
];

// Extraído da rota abaixo pra ser reaproveitado pelo cron mensal
// (rodarAuditoriaIntegridadeMensal) sem duplicar a mesma varredura.
async function buscarDivergenciasDeLoja() {
  const divergencias = [];
  for (const cfg of TABELAS_COM_LOJA) {
    const condicoes = [`loja IS NOT NULL`, `loja <> ''`];
    if (cfg.flagAtivo) condicoes.push(`${cfg.flagAtivo} = true`);
    if (cfg.flagExcluido) condicoes.push(`${cfg.flagExcluido} IS NULL`);
    condicoes.push(`NOT EXISTS (
      SELECT 1 FROM lojas l WHERE l.ativo = true AND
        TRANSLATE(LOWER(TRIM(l.nome)), 'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')
        = TRANSLATE(LOWER(TRIM(${cfg.tabela}.loja)), 'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc')
    )`);
    const r = await pool.query(`
      SELECT loja, COUNT(*)::int AS total
      FROM ${cfg.tabela}
      WHERE ${condicoes.join(" AND ")}
      GROUP BY loja ORDER BY total DESC
    `);
    for (const row of r.rows) {
      divergencias.push({ tabela: cfg.tabela, loja: row.loja, total: row.total });
    }
  }
  return divergencias;
}

// Roda 1x por mês sozinho (ver startAuditoriaIntegridadeCron) e avisa o
// admin pelo sino de notificações do painel só quando encontra alguma
// divergência de loja — sem aviso nenhum se estiver tudo certo, pra não
// virar ruído mensal. Usa logs_sistema como trava de "já rodou esse mês"
// (sobrevive a reinício/redeploy do container).
async function rodarAuditoriaIntegridadeMensal() {
  const jaRodouEsteMes = await pool.query(`
    SELECT 1 FROM logs_sistema
    WHERE tipo = 'auditoria_integridade'
      AND date_trunc('month', criado_em) = date_trunc('month', NOW())
    LIMIT 1
  `);
  if (jaRodouEsteMes.rows.length) return { executou: false, motivo: "ja rodou este mes" };

  const divergencias = await buscarDivergenciasDeLoja();

  await pool.query(
    `INSERT INTO logs_sistema (tipo, origem, mensagem, detalhes) VALUES ($1,$2,$3,$4)`,
    [
      "auditoria_integridade",
      "cron",
      divergencias.length
        ? `${divergencias.length} divergência(s) de loja encontrada(s)`
        : "Nenhuma divergência de loja encontrada",
      JSON.stringify({ divergencias })
    ]
  );

  if (divergencias.length) {
    const porTabela = {};
    for (const d of divergencias) (porTabela[d.tabela] = porTabela[d.tabela] || []).push(`"${d.loja}" (${d.total})`);
    const detalhe = Object.entries(porTabela).map(([t, vs]) => `${t}: ${vs.join(", ")}`).join(" · ");
    await pool.query(
      `INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios) VALUES ($1,$2,$3,$4,$5)`,
      [
        "auditoria_integridade",
        `🔍 Auditoria mensal: ${divergencias.length} loja(s) fora do cadastro oficial`,
        `Confira em /api/admin/diag/loja-mismatch. ${detalhe}`,
        null,
        ["admin", "super_admin", "atendimento central", HUGO_SUPER_ADMIN_EMAIL]
      ]
    );
  }

  console.log(`[AuditoriaIntegridade] ${divergencias.length} divergência(s) de loja encontrada(s).`);
  return { executou: true, divergencias };
}

function startAuditoriaIntegridadeCron() {
  if (process.env.AUDITORIA_INTEGRIDADE_ENABLED === "false") {
    console.log("    AuditoriaIntegridade: desativada");
    return;
  }
  // Checa 1x por dia às 7h; o próprio job só age uma vez por mês (ver
  // rodarAuditoriaIntegridadeMensal) — verificação diária garante que um
  // redeploy perto do dia 1 não faça o mês inteiro passar em branco.
  scheduleDaily("AuditoriaIntegridade", 7, rodarAuditoriaIntegridadeMensal);
}

app.get("/api/admin/diag/loja-mismatch", requireSuperAdmin, async (req, res) => {
  try {
    const lj = await pool.query(`SELECT nome, ativo FROM lojas ORDER BY nome`);
    const divergencias = await buscarDivergenciasDeLoja();

    // Valores de loja dos usuários + simulação de quantos agendamentos cada
    // um veria com a própria sessão (pega tanto mismatch de nome quanto
    // usuário legitimamente sem nenhum agendamento na loja ainda).
    const us = await pool.query(`
      SELECT nome, cargo, COALESCE(loja,'(null)') AS loja, ativo
      FROM usuarios WHERE ativo = true ORDER BY loja, nome
    `);
    const checks = [];
    for (const u of us.rows) {
      if (['admin', 'atendimento central'].includes(u.cargo)) continue;
      if (!u.loja || u.loja === '(null)') { checks.push({ usuario: u.nome, cargo: u.cargo, loja_session: u.loja, agendamentos_visiveis: null, aviso: "sem loja definida" }); continue; }
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
      resumo: divergencias.length
        ? `${divergencias.length} valor(es) de loja fora do cadastro oficial, em ${new Set(divergencias.map(d => d.tabela)).size} tabela(s).`
        : "Nenhuma divergência de loja encontrada em nenhuma tabela.",
      lojas_cadastradas: lj.rows,
      divergencias,
      usuarios_e_visibilidade: checks
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.get("/api/admin/kommo/pipelines", requireSuperAdmin, async (req, res) => {
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
app.post("/api/admin/kommo/setup-stages", requireSuperAdmin, async (req, res) => {
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

app.post("/api/admin/kommo/update-stage-colors", requireSuperAdmin, async (req, res) => {
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

function executiveMetricRow(row = {}) {
  const number = (key) => Number(row[key] || 0);
  const agendamentos = number("agendamentos");
  const comparecimentos = number("comparecimentos");
  const vendas = number("vendas");
  const faturamento = number("faturamento");
  return {
    ...row,
    agendamentos,
    clientes: number("clientes"),
    comparecimentos,
    faltas: number("faltas"),
    vendas,
    faturamento,
    descontos: number("descontos"),
    os_ativas: number("os_ativas"),
    os_atrasadas: number("os_atrasadas"),
    lead_time_medio: number("lead_time_medio"),
    ticket_medio: vendas ? Number((faturamento / vendas).toFixed(2)) : 0,
    taxa_comparecimento: agendamentos ? Number((comparecimentos * 100 / agendamentos).toFixed(1)) : 0,
    taxa_conversao: comparecimentos ? Number((vendas * 100 / comparecimentos).toFixed(1)) : 0,
    desconto_percentual: faturamento ? Number((number("descontos") * 100 / faturamento).toFixed(1)) : 0
  };
}

app.get("/api/admin/dashboard-executivo", requireAdmin, async (req, res) => {
  try {
    const hoje = hojeBrasil();
    const inicio = clean(req.query.inicio) || `${hoje.slice(0, 7)}-01`;
    const fim = clean(req.query.fim) || hoje;
    const loja = clean(req.query.loja);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fim) || inicio > fim) {
      return res.status(400).json({ ok: false, message: "Período inválido." });
    }
    const params = [inicio, fim];
    const isTargetGroup = normalizeStoreKey(loja) === "oticas target";
    const lojaCondition = loja ? (params.push(loja), isTargetGroup
      ? `AND LOWER(COALESCE(a.loja,'')) LIKE '%target%'`
      : `AND ${storeSql("a.loja", `$${params.length}`)}`) : "";
    const baseWhere = `a.excluido_em IS NULL AND a.nome NOT ILIKE '%teste%'
      AND COALESCE(a.loja,'') NOT ILIKE '%teste%'
      AND COALESCE(a.data_agendamento, a.criado_em::date) BETWEEN $1::date AND $2::date ${lojaCondition}`;
    const metricSql = `
      COUNT(*)::int AS agendamentos,
      COUNT(DISTINCT COALESCE(NULLIF(REGEXP_REPLACE(a.whatsapp, '\\D','','g'),''), NULLIF(LOWER(a.email),''), LOWER(a.nome)))::int AS clientes,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(a.compareceu,'')) IN ('sim','compareceu','true','1') OR LOWER(COALESCE(a.status,'')) IN ('compareceu','concluído','concluido'))::int AS comparecimentos,
      COUNT(*) FILTER (WHERE LOWER(COALESCE(a.compareceu,'')) IN ('não','nao','não compareceu','nao compareceu') OR LOWER(COALESCE(a.status,'')) IN ('não compareceu','nao compareceu'))::int AS faltas,
      COUNT(*) FILTER (WHERE COALESCE(a.valor_venda,0) > 0)::int AS vendas,
      COALESCE(SUM(a.valor_venda),0)::numeric AS faturamento,
      COALESCE(SUM(a.desconto),0)::numeric AS descontos,
      COUNT(*) FILTER (WHERE NULLIF(a.numero_os,'') IS NOT NULL AND LOWER(COALESCE(a.status_os,'')) NOT IN ('concluído','concluido','entregue','cancelada','cancelado','reembolso'))::int AS os_ativas,
      COUNT(*) FILTER (WHERE a.data_entrega_os < CURRENT_DATE AND LOWER(COALESCE(a.status_os,'')) NOT IN ('concluído','concluido','entregue','cancelada','cancelado','reembolso'))::int AS os_atrasadas,
      COALESCE(AVG(COALESCE(a.lead_time_dias, a.data_finalizacao_os - a.data_abertura_os)) FILTER (WHERE a.data_finalizacao_os IS NOT NULL),0)::numeric AS lead_time_medio`;

    const executiveStoreSql = `CASE
      WHEN LOWER(COALESCE(a.loja,'')) LIKE '%target%' THEN 'Óticas Target'
      ELSE COALESCE(NULLIF(a.loja,''),'Sem loja') END`;
    const executiveProfileSql = `COALESCE(NULLIF(u.cargo,''), 'Não informado')`;
    const executiveLojaStaffSql = `(u.cargo IS NOT NULL AND LOWER(u.cargo) NOT LIKE '%central%' AND LOWER(u.cargo) NOT LIKE '%admin%')`;
    const executiveChannelSql = `CASE
      WHEN LOWER(COALESCE(a.agendado_por_nome,'')) LIKE '%maria cristina%' THEN 'Atendimento Central'
      WHEN LOWER(COALESCE(a.origem_sync,'')) = 'landing_page'
        OR LOWER(COALESCE(a.origem,'')) LIKE '%landing%'
        OR LOWER(COALESCE(a.origem,'')) LIKE '%site%'
        OR LOWER(COALESCE(a.access_tags,'')) LIKE '%origem:site%' THEN 'Landing Page (Teste de Visão)'
      WHEN LOWER(COALESCE(a.origem,'')) LIKE '%whatsapp%'
        OR LOWER(COALESCE(a.access_tags,'')) LIKE '%origem:whatsapp%' THEN 'Atendimento Central'
      WHEN LOWER(COALESCE(a.origem_sync,'')) = 'kommo_bot'
        OR LOWER(COALESCE(a.access_tags,'')) LIKE '%origem:kommo%' THEN 'Atendimento Central'
      WHEN ${executiveLojaStaffSql} THEN 'Loja'
      WHEN a.kommo_lead_id IS NOT NULL THEN 'Atendimento Central'
      WHEN NULLIF(TRIM(a.origem),'') IS NULL THEN 'Não informada'
      ELSE a.origem END`;

    const baseWhereSemFiltroLoja = `a.excluido_em IS NULL AND a.nome NOT ILIKE '%teste%'
      AND COALESCE(a.loja,'') NOT ILIKE '%teste%'
      AND COALESCE(a.data_agendamento, a.criado_em::date) BETWEEN $1::date AND $2::date`;

    const [resumoResult, lojasResult, consultoresResult, origensResult, tendenciaResult, metasResult, lojaPerfilResult, lojaOrfaResult] = await Promise.all([
      pool.query(`SELECT ${metricSql} FROM agendamentos a WHERE ${baseWhere}`, params),
      pool.query(`SELECT ${executiveStoreSql} AS loja, ${metricSql} FROM agendamentos a WHERE ${baseWhere} GROUP BY ${executiveStoreSql} ORDER BY faturamento DESC`, params),
      pool.query(`SELECT a.vendedor_consultor_id AS id,
          COALESCE(NULLIF(MAX(v.nome),''), NULLIF(MAX(a.vendedor_nome),''), NULLIF(MAX(a.consultor_responsavel),''), 'Não informado') AS consultor,
          COALESCE(NULLIF(a.loja,''),'Sem loja') AS loja, ${metricSql}
        FROM agendamentos a LEFT JOIN vendedores_consultores v ON v.id = a.vendedor_consultor_id
        WHERE ${baseWhere} GROUP BY a.vendedor_consultor_id, a.loja ORDER BY faturamento DESC`, params),
      pool.query(`SELECT ${executiveChannelSql} AS origem, ${metricSql}
        FROM agendamentos a LEFT JOIN usuarios u ON LOWER(u.email) = LOWER(NULLIF(a.agendado_por_email,''))
        WHERE ${baseWhere} GROUP BY ${executiveChannelSql} ORDER BY agendamentos DESC`, params),
      pool.query(`SELECT TO_CHAR(DATE_TRUNC('month', COALESCE(a.data_agendamento,a.criado_em::date)), 'YYYY-MM') AS competencia,
          ${metricSql} FROM agendamentos a WHERE ${baseWhere}
        GROUP BY DATE_TRUNC('month', COALESCE(a.data_agendamento,a.criado_em::date)) ORDER BY competencia`, params),
      pool.query(`${META_SELECT} WHERE m.ativo = true AND m.competencia BETWEEN DATE_TRUNC('month',$1::date) AND DATE_TRUNC('month',$2::date) ORDER BY m.tipo_escopo,m.loja,v.nome`, [inicio, fim]),
      pool.query(`SELECT ${executiveStoreSql} AS loja, ${executiveProfileSql} AS perfil, ${metricSql}
        FROM agendamentos a LEFT JOIN usuarios u ON LOWER(u.email) = LOWER(NULLIF(a.agendado_por_email,''))
        WHERE ${baseWhere} GROUP BY ${executiveStoreSql}, ${executiveProfileSql} ORDER BY ${executiveStoreSql}, faturamento DESC`, params),
      pool.query(`SELECT COALESCE(NULLIF(TRIM(a.loja),''),'(vazio)') AS loja, COUNT(*)::int AS total
        FROM agendamentos a
        WHERE ${baseWhereSemFiltroLoja}
          AND NULLIF(TRIM(a.loja),'') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM lojas l WHERE ${storeSql("l.nome", "a.loja")})
        GROUP BY loja ORDER BY total DESC LIMIT 5`, [inicio, fim])
    ]);

    const resumo = executiveMetricRow(resumoResult.rows[0]);
    const origensMedidas = origensResult.rows.map(executiveMetricRow);
    const nomesCanaisSempreExibidos = ["Atendimento Central", "Landing Page (Teste de Visão)", "Loja"];
    const canaisSempreExibidos = new Set(nomesCanaisSempreExibidos);
    const canaisMarketing = new Set(["Atendimento Central", "Landing Page (Teste de Visão)"]);
    const origens = nomesCanaisSempreExibidos.map((nome) => origensMedidas.find((row) => row.origem === nome)
      || executiveMetricRow({ origem: nome })).concat(origensMedidas.filter((row) => !canaisSempreExibidos.has(row.origem)));
    const marketing = origens.filter((row) => canaisMarketing.has(row.origem)).reduce((acc, row) => ({
      clientes: acc.clientes + row.clientes,
      agendamentos: acc.agendamentos + row.agendamentos,
      vendas: acc.vendas + row.vendas,
      faturamento: acc.faturamento + row.faturamento
    }), { clientes: 0, agendamentos: 0, vendas: 0, faturamento: 0 });
    const setores = [
      { setor: "Atendimento e agenda", indicador: "Comparecimento", realizado: resumo.taxa_comparecimento, unidade: "%", base: resumo.agendamentos },
      { setor: "Optometria", indicador: "Atendimentos realizados", realizado: resumo.comparecimentos, unidade: "clientes", base: resumo.clientes },
      { setor: "Comercial", indicador: "Conversão em vendas", realizado: resumo.taxa_conversao, unidade: "%", base: resumo.vendas },
      { setor: "Laboratório e OS", indicador: "Prazo médio", realizado: resumo.lead_time_medio, unidade: "dias", base: resumo.os_ativas },
      { setor: "Marketing", indicador: "Clientes dos canais rastreados", realizado: marketing.clientes, unidade: "clientes", base: marketing.agendamentos }
    ];
    const alertas = [];
    if (resumo.taxa_comparecimento < 70) alertas.push({ nivel: "alto", area: "Atendimento", mensagem: "Comparecimento abaixo de 70%. Reforçar confirmação e lembretes." });
    if (resumo.taxa_conversao < 35) alertas.push({ nivel: "alto", area: "Comercial", mensagem: "Conversão abaixo de 35%. Revisar abordagem e motivos de perda." });
    if (resumo.os_atrasadas > 0) alertas.push({ nivel: "alto", area: "OS", mensagem: `${resumo.os_atrasadas} OS atrasada(s) precisam de ação.` });
    if (resumo.desconto_percentual > 10) alertas.push({ nivel: "medio", area: "Financeiro", mensagem: "Desconto médio acima de 10% do faturamento." });
    if (lojaOrfaResult.rows.length) {
      // Agendamento com loja fora do cadastro oficial da tabela `lojas` fica
      // invisível para qualquer perfil de loja (só admin/central enxergam) —
      // já causou 44 agendamentos "perdidos" vindos da landing page sem que
      // ninguém percebesse por semanas. Este alerta torna isso visível sem
      // precisar saber que /api/admin/diag/loja-mismatch existe.
      const totalOrfaos = lojaOrfaResult.rows.reduce((acc, r) => acc + r.total, 0);
      const exemplos = lojaOrfaResult.rows.map((r) => `"${r.loja}" (${r.total})`).join(", ");
      alertas.push({
        nivel: "alto",
        area: "Cadastro",
        mensagem: `${totalOrfaos} agendamento(s) com loja fora do cadastro oficial, invisíveis para perfis de loja: ${exemplos}. Corrigir em /api/admin/diag/loja-mismatch.`
      });
    }
    if (!alertas.length) alertas.push({ nivel: "ok", area: "Grupo", mensagem: "Nenhum alerta crítico no período selecionado." });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      periodo: { inicio, fim, loja: loja || null },
      resumo,
      lojas: lojasResult.rows.map(executiveMetricRow),
      consultores: consultoresResult.rows.map(executiveMetricRow),
      origens,
      lojaPerfil: lojaPerfilResult.rows.map(executiveMetricRow),
      marketing,
      tendencia: tendenciaResult.rows.map(executiveMetricRow),
      setores,
      metas: metasResult.rows,
      alertas
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar o painel executivo.", error: error.message });
  }
});

// ===============================
// CRM (Fase 1): kanban de leads + histórico de conversa, espelhando o Kommo
// dentro do próprio sistema. Base é kommo_bot_states (sinal de "existe uma
// conversa real"), com o agendamento mais recente daquele lead via LATERAL.
// ===============================

// Também usado por GET /api/agendamentos (mais acima no arquivo) para expor
// e filtrar a etapa do lead na tela de agendamentos, não só aqui no Kanban.
const CRM_ESTAGIO_CASE_SQL = `CASE
  WHEN a.venda_gerada = 'sim' OR COALESCE(a.valor_venda,0) > 0 THEN 'Vendido'
  WHEN LOWER(COALESCE(a.compareceu,'')) IN ('não','nao','não compareceu','nao compareceu')
    OR LOWER(COALESCE(a.status,'')) IN ('cancelado','não compareceu','nao compareceu') THEN 'Perdido'
  WHEN LOWER(COALESCE(a.compareceu,'')) IN ('sim','compareceu') THEN 'Compareceu'
  WHEN a.id IS NOT NULL AND LOWER(COALESCE(a.status,'')) IN ('agendado','confirmado') THEN 'Agendado'
  WHEN s.etapa = 'transferido' THEN 'Atendimento Humano'
  WHEN s.etapa IS NOT NULL AND s.etapa <> 'boas_vindas' THEN 'Bot Ativo'
  ELSE 'Novo Lead'
END`;

const CRM_LOJA_SQL = `COALESCE(NULLIF(a.loja,''), NULLIF(s.state->>'loja',''), 'Sem loja')`;

const CRM_ORDEM_ESTAGIOS = ["Atendimento Humano", "Bot Ativo", "Agendado", "Compareceu", "Vendido", "Perdido", "Novo Lead"];

function crmLeadsBaseQuery({ conditions }) {
  return `
    SELECT
      s.lead_id AS kommo_lead_id,
      COALESCE(NULLIF(s.state->>'nome',''), NULLIF(a.nome,''), '(sem nome)') AS nome,
      COALESCE(NULLIF(a.whatsapp,''), NULLIF(s.state->>'whatsapp',''), '') AS whatsapp,
      ${CRM_LOJA_SQL} AS loja,
      s.etapa AS etapa_bot,
      s.bot_active,
      s.updated_at AS ultima_atividade,
      a.id AS agendamento_id, a.status, a.compareceu, a.venda_gerada, a.valor_venda,
      a.data_agendamento, a.horario, a.vendedor_atendeu_nome,
      ${CRM_ESTAGIO_CASE_SQL} AS estagio
    FROM kommo_bot_states s
    LEFT JOIN LATERAL (
      SELECT * FROM agendamentos ag
      WHERE ag.kommo_lead_id = s.lead_id AND ag.excluido_em IS NULL
      ORDER BY ag.criado_em DESC
      LIMIT 1
    ) a ON true
    ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
  `;
}

// O CRM é ferramenta de Admin/Atendimento Central, não de perfil de loja --
// o front-end já esconde o botão para os demais perfis, mas as rotas em si
// não tinham esse gate (só faziam escopo por loja), então qualquer sessão
// autenticada conseguia listar/enviar mensagem via chamada direta à API.
function requireCrmAccess(req, res, next) {
  if (!canViewAllStores(req.session)) {
    return res.status(403).json({ ok: false, message: "CRM disponível apenas para Admin e Atendimento Central." });
  }
  next();
}

app.get("/api/admin/crm/leads", requireCrmAccess, async (req, res) => {
  try {
    const q = req.query;
    const params = [];
    const conditions = [];

    if (clean(q.loja)) {
      params.push(clean(q.loja));
      conditions.push(storeSql(CRM_LOJA_SQL, `$${params.length}`));
    }

    const busca = clean(q.busca);
    if (busca) {
      params.push(`%${busca}%`);
      conditions.push(`(s.state->>'nome' ILIKE $${params.length} OR a.nome ILIKE $${params.length} OR a.whatsapp ILIKE $${params.length})`);
    }

    const base = crmLeadsBaseQuery({ conditions });

    const colunasResult = await pool.query(`SELECT estagio, COUNT(*)::int AS total FROM (${base}) t GROUP BY estagio`, params);
    const contagem = new Map(colunasResult.rows.map((r) => [r.estagio, r.total]));
    const colunas = CRM_ORDEM_ESTAGIOS.map((estagio) => ({ estagio, total: contagem.get(estagio) || 0 }));

    const estagioFiltro = clean(q.estagio);
    const paramsLeads = [...params];
    let whereEstagio = "";
    if (estagioFiltro) {
      paramsLeads.push(estagioFiltro);
      whereEstagio = `WHERE t.estagio = $${paramsLeads.length}`;
    }
    const leadsResult = await pool.query(
      `SELECT * FROM (${base}) t ${whereEstagio} ORDER BY t.ultima_atividade DESC LIMIT 300`,
      paramsLeads
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, colunas, leads: leadsResult.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar o CRM.", error: error.message });
  }
});

function crmExtrairTelefoneContato(contact) {
  const campos = contact?.custom_fields_values || [];
  const campo = campos.find((c) => c.field_code === "PHONE")
    || campos.find((c) => String(c.field_name || "").toUpperCase().includes("TELEFONE"));
  return clean(campo?.values?.[0]?.value || "");
}

// Busca o nome/telefone reais do contato direto no Kommo quando o lead ainda
// não tem essa informação salva (comum em leads que ainda não passaram pela
// saudação do bot). Resultado é salvo em kommo_bot_states.state para não
// precisar bater no Kommo de novo nas próximas vezes que o lead for aberto.
async function crmResolverContatoKommo(leadId) {
  try {
    const kommoClient = require("./kommo/client");
    const lead = await kommoClient.getLead(leadId);
    const contactId = lead?._embedded?.contacts?.[0]?.id;
    let contact = contactId ? await kommoClient.getContact(contactId) : null;
    if (!contact) {
      const contatos = await kommoClient.getContactsByLead(leadId);
      contact = contatos[0] || null;
    }
    if (!contact) return null;
    const nome = clean(contact.name);
    if (/\{\{.*\}\}/.test(nome)) return null; // variável do Kommo não resolvida
    return { nome: nome || null, whatsapp: crmExtrairTelefoneContato(contact) || null };
  } catch (e) {
    console.error(`[CRM] Erro ao resolver contato Kommo — lead ${leadId}:`, e.message);
    return null;
  }
}

async function crmBuscarLead(leadId) {
  const params = [String(leadId)];
  const base = crmLeadsBaseQuery({ conditions: ["s.lead_id = $1"] });
  const result = await pool.query(base, params);
  let lead = result.rows[0] || null;
  if (!lead) return null;

  if (lead.nome === "(sem nome)" || !lead.whatsapp) {
    const contato = await crmResolverContatoKommo(leadId);
    if (contato && (contato.nome || contato.whatsapp)) {
      const atualizacoes = {};
      if (contato.nome && lead.nome === "(sem nome)") atualizacoes.nome = contato.nome;
      if (contato.whatsapp && !lead.whatsapp) atualizacoes.whatsapp = contato.whatsapp;
      if (Object.keys(atualizacoes).length) {
        const SM = require("./kommo/bot/stateManager");
        await SM.getState(leadId); // garante que o estado em memória está carregado antes do merge
        SM.setState(leadId, atualizacoes, { persist: true });
        lead = { ...lead, ...atualizacoes };
      }
    }
  }
  return lead;
}

app.get("/api/admin/crm/leads/:leadId/mensagens", requireCrmAccess, async (req, res) => {
  try {
    const leadId = clean(req.params.leadId);
    const lead = await crmBuscarLead(leadId);
    if (!lead) return res.status(404).json({ ok: false, message: "Lead não encontrado." });
    if (!ensureStoreAccess(req.session, lead.loja)) {
      return res.status(403).json({ ok: false, message: "Sem acesso a esta loja." });
    }
    const mensagens = await pool.query(
      `SELECT id, direcao, autor_tipo, autor_nome, texto, criado_em
       FROM crm_mensagens WHERE kommo_lead_id = $1 ORDER BY criado_em ASC LIMIT 500`,
      [leadId]
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, lead, mensagens: mensagens.rows });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar a conversa.", error: error.message });
  }
});

app.post("/api/admin/crm/leads/:leadId/mensagens", requireCrmAccess, async (req, res) => {
  try {
    const leadId = clean(req.params.leadId);
    const texto = clean(req.body?.texto);
    if (!texto) return res.status(400).json({ ok: false, message: "Mensagem vazia." });

    const lead = await crmBuscarLead(leadId);
    if (!lead) return res.status(404).json({ ok: false, message: "Lead não encontrado." });
    if (!ensureStoreAccess(req.session, lead.loja)) {
      return res.status(403).json({ ok: false, message: "Sem acesso a esta loja." });
    }

    const kommoClient = require("./kommo/client");
    const SM = require("./kommo/bot/stateManager");
    const crmLog = require("./kommo/crmLog");

    await kommoClient.sendProactiveMessage(leadId, texto);
    SM.markHumanActivity(leadId);
    await crmLog.registrarMensagem({
      leadId, direcao: "saida", autorTipo: "atendente",
      autorNome: req.session?.nome || null, texto,
    });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao enviar mensagem.", error: error.message });
  }
});

// GET /api/admin/crm/metricas — espelha os indicadores de atendimento que hoje
// só existem dentro do Kommo (conversas ativas, tempo médio de 1ª resposta,
// conversas por atendente), calculados a partir de crm_mensagens. Como esse
// histórico só começou a ser gravado no deploy da Fase 1, fica zerado/parcial
// até acumular tráfego real — isso é esperado, não é bug.
app.get("/api/admin/crm/metricas", requireCrmAccess, async (req, res) => {
  try {
    const q = req.query;
    const hoje = hojeBrasil();
    const inicio = clean(q.inicio) || `${hoje.slice(0, 7)}-01`;
    const fim = clean(q.fim) || hoje;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || !/^\d{4}-\d{2}-\d{2}$/.test(fim) || inicio > fim) {
      return res.status(400).json({ ok: false, message: "Período inválido." });
    }

    const params = [];
    const conditions = [];
    if (clean(q.loja)) {
      params.push(clean(q.loja));
      conditions.push(storeSql(CRM_LOJA_SQL, `$${params.length}`));
    }

    const base = crmLeadsBaseQuery({ conditions });
    const leadsFiltroSql = conditions.length ? `AND kommo_lead_id IN (SELECT kommo_lead_id FROM (${base}) b)` : "";

    const ativasResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM (${base}) t WHERE t.estagio IN ('Bot Ativo','Atendimento Humano')`,
      params
    );

    const paramsPeriodo = [...params, inicio, fim];
    const idxInicio = paramsPeriodo.length - 1;
    const idxFim = paramsPeriodo.length;

    const tempoResult = await pool.query(
      `WITH ordenado AS (
         SELECT kommo_lead_id, direcao, criado_em,
                LEAD(direcao) OVER (PARTITION BY kommo_lead_id ORDER BY criado_em) AS prox_direcao,
                LEAD(criado_em) OVER (PARTITION BY kommo_lead_id ORDER BY criado_em) AS prox_em
         FROM crm_mensagens
         WHERE criado_em::date BETWEEN $${idxInicio}::date AND $${idxFim}::date ${leadsFiltroSql}
       )
       SELECT AVG(EXTRACT(EPOCH FROM (prox_em - criado_em)) / 60)::numeric AS minutos
       FROM ordenado WHERE direcao = 'entrada' AND prox_direcao = 'saida'`,
      paramsPeriodo
    );

    const atendenteResult = await pool.query(
      `SELECT autor_nome, COUNT(DISTINCT kommo_lead_id)::int AS conversas, COUNT(*)::int AS mensagens
       FROM crm_mensagens
       WHERE autor_tipo = 'atendente' AND autor_nome IS NOT NULL
         AND criado_em::date BETWEEN $${idxInicio}::date AND $${idxFim}::date ${leadsFiltroSql}
       GROUP BY autor_nome ORDER BY conversas DESC LIMIT 20`,
      paramsPeriodo
    );

    res.setHeader("Cache-Control", "no-store");
    res.json({
      ok: true,
      periodo: { inicio, fim },
      conversasAtivas: ativasResult.rows[0]?.total || 0,
      tempoMedioRespostaMin: tempoResult.rows[0]?.minutos !== null ? Number(tempoResult.rows[0].minutos) : null,
      porAtendente: atendenteResult.rows,
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: "Erro ao carregar métricas do CRM.", error: error.message });
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
    const hoje = hojeBrasil();
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
  if (fs.existsSync(indexPath)) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.sendFile(indexPath);
  }
  res.json({
    ok: true,
    service: "Agendamento System",
    message: "Servidor rodando com PostgreSQL.",
    routes: [
      "GET /health",
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

    // Identifica visualmente no Kommo a unidade responsável pelo lead.
    const labels = require('./kommo/labels');
    const pipelineIdDaLoja = resolverPipelineId(ag.loja);
    const prefixoLoja = pipelineIdDaLoja === PIPELINE_POR_LOJA.gonzaga ? 'gon'
      : pipelineIdDaLoja === PIPELINE_POR_LOJA.enseada ? 'ens'
      : pipelineIdDaLoja === PIPELINE_POR_LOJA.pitangueiras ? 'pit'
      : pipelineIdDaLoja === PIPELINE_POR_LOJA.ademar ? 'tgt'
      : '';
    if (prefixoLoja) await labels.applyStoreLabel(leadId, prefixoLoja);

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
app.post('/api/admin/sync/agendamentos-para-kommo', requireSuperAdmin, async (req, res) => {
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
        await kommoClient.sendProactiveMessage(String(ag.kommo_lead_id), mensagem);
        await pool.query(`UPDATE agendamentos SET lembrete_24h_em = NOW() WHERE id = $1`, [ag.id]);
        console.log(`[lembretes24h] ✅ Enviado para ${ag.nome} (id=${ag.id})`);
        enviados++;
      } catch (e) {
        console.error(`[lembretes24h] ❌ Erro no id=${ag.id} (${ag.nome}):`, e.message);
        erros++;
        // Não marca como enviado: a próxima verificação poderá tentar novamente.
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
app.post('/api/admin/lembretes/disparar', requireSuperAdmin, async (req, res) => {
  const resultado = await runReminders();
  res.json({ ok: true, ...resultado });
});

app.post('/api/admin/lembretes/2h/disparar', requireAdmin, async (req, res) => {
  const resultado = await runTwoHourReminders();
  res.json({ ok: true, ...resultado });
});

async function startServer() {
  await initDatabase();
  await carregarConfiguracaoKommoDoBanco();
  await carregarConfiguracoesPainelDoBanco();
  startReminderCron();
  startRecoveryCron();
  startFollowupCron();
  startAuditoriaIntegridadeCron();
  return new Promise((resolve) => {
    const server = app.listen(PORT, "0.0.0.0", () => {
      console.log(`Sistema rodando na porta ${PORT}`);
      console.log("PostgreSQL conectado e tabelas verificadas.");
      resolve(server);
    });
  });
}

if (require.main === module) {
  startServer()
    .then(() => {
      if (process.env.ENABLE_LEGACY_REMINDERS !== "true") return;
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
  initDatabase,
  signSession,
  verifySession,
  requireSession,
  requireSuperAdmin,
  isSuperAdmin,
  buildPermissions,
  publicUser,
  normalizeLojaPublica,
  toPgDate,
  encryptSecret,
  decryptSecret,
  hasRole,
  rodarAuditoriaIntegridadeMensal
};
