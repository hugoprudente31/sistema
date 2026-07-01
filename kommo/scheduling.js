// Kommo Scheduling - Sistema Oticas Target
// Consulta disponibilidade e cria agendamentos diretamente no PostgreSQL.

const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

// ── Bloqueios de disponibilidade ─────────────────────────────────
// Garante que a tabela existe na primeira chamada (idempotente).
let _bloqueiosTableReady = false;
async function ensureBloqueiosTable() {
  if (_bloqueiosTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bloqueios_disponibilidade (
      id        SERIAL PRIMARY KEY,
      loja      TEXT NOT NULL,
      data      DATE NOT NULL,
      motivo    TEXT,
      criado_por TEXT,
      criado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE (loja, data)
    )
  `);
  _bloqueiosTableReady = true;
}

async function estaLojaBloqueada(loja, dataPg) {
  try {
    await ensureBloqueiosTable();
    const { rows } = await pool.query(
      `SELECT 1 FROM bloqueios_disponibilidade
       WHERE LOWER(loja) = LOWER($1) AND data = $2
       LIMIT 1`,
      [loja, dataPg]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function adicionarBloqueio({ loja, data, motivo, criadoPor }) {
  await ensureBloqueiosTable();
  const dataPg = toPgDate(data);
  if (!dataPg) throw new Error("Data inválida.");
  await pool.query(
    `INSERT INTO bloqueios_disponibilidade (loja, data, motivo, criado_por)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (loja, data) DO UPDATE SET motivo = EXCLUDED.motivo, criado_por = EXCLUDED.criado_por, criado_em = NOW()`,
    [loja, dataPg, motivo || null, criadoPor || null]
  );
  // Invalida cache para esta loja/data
  _cache.delete(`disponibilidade|${normalizeLoja(loja)}|${dataPg}`);
}

async function removerBloqueio({ loja, data }) {
  await ensureBloqueiosTable();
  const dataPg = toPgDate(data);
  if (!dataPg) throw new Error("Data inválida.");
  const { rowCount } = await pool.query(
    `DELETE FROM bloqueios_disponibilidade WHERE LOWER(loja) = LOWER($1) AND data = $2`,
    [loja, dataPg]
  );
  _cache.delete(`disponibilidade|${normalizeLoja(loja)}|${dataPg}`);
  return rowCount;
}

async function listarBloqueios() {
  await ensureBloqueiosTable();
  const { rows } = await pool.query(
    `SELECT loja, TO_CHAR(data,'DD/MM/YYYY') AS data, motivo, criado_por, criado_em
     FROM bloqueios_disponibilidade
     ORDER BY data DESC, loja`
  );
  return rows;
}

const PUBLIC_BLOCKING_STATUSES = [
  "Agendado",
  "Confirmado",
  "Compareceu",
  "OS em Andamento",
];

const TODOS_HORARIOS = [
  "10:00", "10:30", "11:00", "11:30",
  "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00", "17:30",
];

const _cache = new Map();
const CACHE_TTL = 30_000;

function clean(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function stripAccents(v) {
  return clean(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLoja(loja) {
  const raw = clean(loja);
  const key = stripAccents(raw).replace(/\s*-\s*/g, " ");
  const gonzaga = "\u00f3ticas TGT - Gonzaga";
  const enseada = "\u00f3ticas TGT Enseada";
  const pitangueiras = "\u00f3ticas TGT Pitangueiras";
  const ademar = "\u00f3ticas Target - Ademar de Barros";

  const mapa = {
    "gonzaga": gonzaga,
    "gonzaga & santos": gonzaga,
    "gonzaga santos": gonzaga,
    "santos": gonzaga,
    "oticas tgt gonzaga": gonzaga,
    "oticas tgt santos": gonzaga,
    "oticas tgt gonzaga santos": gonzaga,
    "enseada": enseada,
    "oticas tgt enseada": enseada,
    "oticas tgt enseada guaruja": enseada,
    "pitangueiras": pitangueiras,
    "oticas tgt pitangueiras": pitangueiras,
    "oticas tgt pitangueiras guaruja": pitangueiras,
    "ademar": ademar,
    "ademar de barros": ademar,
    "oticas target ademar de barros": ademar,
    "santo antonio": ademar,
    "sto. antonio": ademar,
  };

  return mapa[key] || raw;
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

function toBrDate(v) {
  const pg = toPgDate(v);
  if (!pg) return clean(v);
  const [yyyy, mm, dd] = pg.split("-");
  return `${dd}/${mm}/${yyyy}`;
}

function normalizeWhatsapp(v) {
  return clean(v).replace(/\D/g, "");
}

function makeId(prefix, value) {
  const base = clean(value);
  if (base) return `${prefix}:${base}`;
  return `${prefix}:hash:${crypto.randomBytes(8).toString("hex")}`;
}

function stableHash(obj) {
  return crypto.createHash("sha1").update(JSON.stringify(obj || {})).digest("hex");
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

function generateSlots(startHour, endHour) {
  const slots = [];
  for (let h = startHour; h <= endHour; h += 1) {
    slots.push(`${String(h).padStart(2, "0")}:00`);
    if (h !== endHour) slots.push(`${String(h).padStart(2, "0")}:30`);
  }
  return slots.filter((h) => h !== "13:00" && h !== "13:30");
}

function getHorariosLoja(loja, data) {
  const pgDate = toPgDate(data);
  if (!pgDate) return TODOS_HORARIOS;

  const date = new Date(pgDate + "T12:00:00");
  const day = date.getDay();
  if (day === 0) return [];

  let slots = generateSlots(10, day === 6 ? 16 : 18);
  const lojaKey = stripAccents(loja).replace(/[^a-z]/g, "");
  if ((lojaKey.includes("gonzaga") || lojaKey.includes("santos")) && day >= 1 && day <= 5) {
    slots = slots.filter((h) => h !== "14:00" && h !== "14:30");
  }

  return slots;
}

function lojaComparableSql(columnSql) {
  return `
    TRANSLATE(
      LOWER(REGEXP_REPLACE(COALESCE(${columnSql}, ''), '\\s*-\\s*', ' ', 'g')),
      'áàâãäéèêëíìîïóòôõöúùûüç',
      'aaaaaeeeeiiiiooooouuuuc'
    )
  `;
}

async function buscarOptometristasAtivosPorLoja(client, loja) {
  const result = await client.query(
    `SELECT nome
     FROM optometristas
     WHERE ativo = true
       AND ${lojaComparableSql("loja")} = ${lojaComparableSql("$1")}
     ORDER BY nome ASC`,
    [loja]
  );

  return result.rows.map((r) => clean(r.nome)).filter(Boolean);
}

async function buscarPrimeiroOptometristaLivre(client, loja, data, horario, optometristaPreferido, gasIdIgnorado = null) {
  const optometristas = await buscarOptometristasAtivosPorLoja(client, loja);
  const candidatos = [];

  if (clean(optometristaPreferido)) candidatos.push(clean(optometristaPreferido));
  for (const optometrista of optometristas) {
    if (!candidatos.some((x) => x.toLowerCase() === optometrista.toLowerCase())) {
      candidatos.push(optometrista);
    }
  }
  if (!candidatos.length) candidatos.push("A definir");

  for (const optometrista of candidatos) {
    const ocupado = await client.query(
      `SELECT id
       FROM agendamentos
       WHERE ${lojaComparableSql("loja")} = ${lojaComparableSql("$1")}
         AND LOWER(COALESCE(optometrista, '')) = LOWER($2)
         AND data_agendamento = $3
         AND horario = $4
         AND status = ANY($5::text[])
         AND excluido_em IS NULL
         AND ($6::text IS NULL OR gas_id IS DISTINCT FROM $6)
       LIMIT 1`,
      [loja, optometrista, data, horario, PUBLIC_BLOCKING_STATUSES, gasIdIgnorado]
    );

    if (!ocupado.rows.length) return optometrista;
  }

  return "";
}

async function getHorariosDisponiveis(loja, data) {
  const lojaNormalizada = normalizeLoja(loja);
  const dataPg = toPgDate(data);
  const cacheKey = `disponibilidade|${lojaNormalizada}|${dataPg || data}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (!lojaNormalizada || !dataPg) return getHorariosLoja(lojaNormalizada, data);

  // Dia bloqueado por falta de optometrista ou outro motivo
  if (await estaLojaBloqueada(lojaNormalizada, dataPg)) {
    console.log(`[Scheduling] ⛔ ${lojaNormalizada} bloqueada em ${dataPg}`);
    cacheSet(cacheKey, []);
    return [];
  }

  const client = await pool.connect();
  try {
    const horarios = [];
    for (const horario of getHorariosLoja(lojaNormalizada, dataPg)) {
      const optometristaLivre = await buscarPrimeiroOptometristaLivre(client, lojaNormalizada, dataPg, horario);
      if (optometristaLivre) horarios.push(horario);
    }
    cacheSet(cacheKey, horarios);
    return horarios;
  } catch (e) {
    console.error("[Scheduling] Erro ao buscar disponibilidade no banco:", e.message);
    return getHorariosLoja(lojaNormalizada, data);
  } finally {
    client.release();
  }
}

async function criarAgendamento({ nome, whatsapp, email, loja, data, horario, leadId, optometrista }) {
  const lojaNormalizada = normalizeLoja(loja);
  const dataPg = toPgDate(data);
  const horarioNormalizado = clean(horario);
  const nomeNormalizado = clean(nome) || "Sem nome";
  const whatsappNormalizado = normalizeWhatsapp(whatsapp);
  const emailNormalizado = clean(email);

  if (!lojaNormalizada) return { ok: false, error: "Loja nao informada." };
  if (!dataPg) return { ok: false, error: "Data do agendamento invalida." };
  if (!/^\d{2}:\d{2}$/.test(horarioNormalizado)) return { ok: false, error: "Horario invalido." };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const gasId = leadId
      ? makeId("kommo", String(leadId))
      : makeId("kommo", stableHash({ nomeNormalizado, whatsappNormalizado, lojaNormalizada, dataPg, horarioNormalizado }));

    const optometristaLivre = await buscarPrimeiroOptometristaLivre(
      client,
      lojaNormalizada,
      dataPg,
      horarioNormalizado,
      optometrista,
      gasId
    );

    if (!optometristaLivre) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Esse horario acabou de ser reservado. Escolha outro horario." };
    }

    const clienteGasId = makeId("cliente", (whatsappNormalizado || emailNormalizado || nomeNormalizado).toLowerCase());
    const cliente = await client.query(
      `INSERT INTO clientes (gas_id, nome, whatsapp, email, origem, loja_origem, observacoes, origem_sync, atualizado_em)
       VALUES ($1,$2,$3,$4,'Kommo Bot',$5,$6,'kommo_bot',CURRENT_TIMESTAMP)
       ON CONFLICT (gas_id) DO UPDATE SET
         nome = EXCLUDED.nome,
         whatsapp = EXCLUDED.whatsapp,
         email = EXCLUDED.email,
         origem = EXCLUDED.origem,
         loja_origem = EXCLUDED.loja_origem,
         observacoes = EXCLUDED.observacoes,
         origem_sync = 'kommo_bot',
         atualizado_em = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        clienteGasId,
        nomeNormalizado,
        whatsappNormalizado,
        emailNormalizado || null,
        lojaNormalizada,
        `Cliente originado do Kommo${leadId ? ` - Lead #${leadId}` : ""}`,
      ]
    );

    const agendamento = await client.query(
      `INSERT INTO agendamentos (
        gas_id, nome, whatsapp, email, loja, optometrista, origem,
        data_agendamento, horario, observacao, status, compareceu,
        responsavel, criado_por_email, proprietario_id, proprietario_nome,
        access_tags, kommo_lead_id, origem_sync, criado_em, atualizado_em
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,'Kommo Bot',
        $7,$8,$9,'Agendado','Pendente',
        'Kommo Bot','kommo-bot@sistema.local','kommo-bot','Kommo Bot',
        'origem:kommo;canal:salesbot;fluxo:agendamento',$10,'kommo_bot',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
      )
      ON CONFLICT (gas_id) DO UPDATE SET
        nome = EXCLUDED.nome,
        whatsapp = EXCLUDED.whatsapp,
        email = EXCLUDED.email,
        loja = EXCLUDED.loja,
        optometrista = EXCLUDED.optometrista,
        data_agendamento = EXCLUDED.data_agendamento,
        horario = EXCLUDED.horario,
        observacao = EXCLUDED.observacao,
        status = EXCLUDED.status,
        compareceu = EXCLUDED.compareceu,
        access_tags = EXCLUDED.access_tags,
        kommo_lead_id = EXCLUDED.kommo_lead_id,
        origem_sync = 'kommo_bot',
        excluido_em = NULL,
        atualizado_em = CURRENT_TIMESTAMP
      RETURNING *`,
      [
        gasId,
        nomeNormalizado,
        whatsappNormalizado,
        emailNormalizado || null,
        lojaNormalizada,
        optometristaLivre,
        dataPg,
        horarioNormalizado,
        `Agendado pelo bot${leadId ? ` - Lead Kommo #${leadId}` : ""}`,
        leadId ? String(leadId) : null,
      ]
    );

    await client.query(
      `INSERT INTO logs_sistema (tipo, origem, mensagem, detalhes)
       VALUES ('kommo','salesbot','Agendamento Kommo gravado no PostgreSQL',$1)`,
      [JSON.stringify({
        agendamento_id: agendamento.rows[0].id,
        cliente_id: cliente.rows[0].id,
        loja: lojaNormalizada,
        data_agendamento: dataPg,
        horario: horarioNormalizado,
        kommo_lead_id: leadId ? String(leadId) : null,
      })]
    );

    await client.query("COMMIT");
    _cache.delete(`disponibilidade|${lojaNormalizada}|${dataPg}`);

    return {
      ok: true,
      id: agendamento.rows[0].id,
      data_agendamento: toBrDate(dataPg),
      horario: horarioNormalizado,
      loja: lojaNormalizada,
      optometrista: optometristaLivre,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[Scheduling] Erro ao criar agendamento no banco:", e.message);
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
}

async function getContatoDoLead(kommoClient, leadId) {
  try {
    const lead = await kommoClient.getLead(leadId);
    const contato = lead?._embedded?.contacts?.[0];
    if (!contato) return { nome: null, whatsapp: null, email: null };

    const campos = contato.custom_fields_values || [];
    const phone = campos.find((c) => c.field_code === "PHONE")?.values?.[0]?.value || "";
    const email = campos.find((c) => c.field_code === "EMAIL")?.values?.[0]?.value || "";

    return {
      nome: contato.name || lead.name || null,
      whatsapp: phone,
      email,
    };
  } catch {
    return { nome: null, whatsapp: null, email: null };
  }
}

module.exports = {
  TODOS_HORARIOS,
  getHorariosLoja,
  getHorariosDisponiveis,
  criarAgendamento,
  getContatoDoLead,
  adicionarBloqueio,
  removerBloqueio,
  listarBloqueios,
};
