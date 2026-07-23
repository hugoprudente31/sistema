// Kommo Scheduling - Sistema Oticas Target
// Consulta disponibilidade e cria agendamentos diretamente no PostgreSQL.

const crypto = require("crypto");
const { Pool } = require("pg");
const mailingboss = require("../mailingboss");

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
      hora_inicio TIME,
      hora_fim TIME,
      motivo    TEXT,
      criado_por TEXT,
      criado_em TIMESTAMP DEFAULT NOW(),
      UNIQUE (loja, data)
    )
  `);
  await pool.query(`ALTER TABLE bloqueios_disponibilidade ADD COLUMN IF NOT EXISTS hora_inicio TIME`);
  await pool.query(`ALTER TABLE bloqueios_disponibilidade ADD COLUMN IF NOT EXISTS hora_fim TIME`);
  _bloqueiosTableReady = true;
}

async function estaLojaBloqueada(loja, dataPg, horario = "") {
  try {
    await ensureBloqueiosTable();
    const horarioNormalizado = clean(horario);
    const { rows } = await pool.query(
      `SELECT 1 FROM bloqueios_disponibilidade
       WHERE LOWER(loja) = LOWER($1) AND data = $2
         AND (
           ($3::text = '' AND hora_inicio IS NULL AND hora_fim IS NULL)
           OR ($3::text <> '' AND (hora_inicio IS NULL OR hora_fim IS NULL OR ($3::time >= hora_inicio AND $3::time < hora_fim)))
         )
       LIMIT 1`,
      [loja, dataPg, horarioNormalizado]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function adicionarBloqueio({ loja, data, horaInicio, horaFim, motivo, criadoPor }) {
  await ensureBloqueiosTable();
  const dataPg = toPgDate(data);
  if (!dataPg) throw new Error("Data inválida.");
  const inicio = clean(horaInicio);
  const fim = clean(horaFim);
  if ((inicio || fim) && (!/^\d{2}:\d{2}$/.test(inicio) || !/^\d{2}:\d{2}$/.test(fim) || inicio >= fim)) {
    throw new Error("Faixa de horário inválida.");
  }
  const lojaNorm = normalizeLoja(loja);
  await pool.query(
    `INSERT INTO bloqueios_disponibilidade (loja, data, hora_inicio, hora_fim, motivo, criado_por)
     VALUES ($1, $2, $3::time, $4::time, $5, $6)
     ON CONFLICT (loja, data) DO UPDATE SET
       hora_inicio = EXCLUDED.hora_inicio, hora_fim = EXCLUDED.hora_fim,
       motivo = EXCLUDED.motivo, criado_por = EXCLUDED.criado_por, criado_em = NOW()`,
    [lojaNorm, dataPg, inicio || null, fim || null, motivo || null, criadoPor || null]
  );
  _cache.delete(`disponibilidade|${lojaNorm}|${dataPg}`);
  return { loja: lojaNorm, data: dataPg, horaInicio: inicio, horaFim: fim };
}

async function removerBloqueio({ loja, data }) {
  await ensureBloqueiosTable();
  const dataPg = toPgDate(data);
  if (!dataPg) throw new Error("Data inválida.");
  const lojaNorm = normalizeLoja(loja);
  const { rowCount } = await pool.query(
    `DELETE FROM bloqueios_disponibilidade WHERE LOWER(loja) = LOWER($1) AND data = $2`,
    [lojaNorm, dataPg]
  );
  _cache.delete(`disponibilidade|${lojaNorm}|${dataPg}`);
  return rowCount;
}

async function listarBloqueios() {
  await ensureBloqueiosTable();
  const { rows } = await pool.query(
    `SELECT loja, TO_CHAR(data,'DD/MM/YYYY') AS data,
            TO_CHAR(hora_inicio,'HH24:MI') AS hora_inicio,
            TO_CHAR(hora_fim,'HH24:MI') AS hora_fim,
            motivo, criado_por, criado_em
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

// Gerado dinamicamente — não hardcodar aqui para manter alinhamento com gerarHorariosBase
const TODOS_HORARIOS = (function() {
  const slots = [];
  for (let m = 10 * 60; m <= 18 * 60; m += 15) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const h = `${hh}:${mm}`;
    if (h !== "13:00" && h !== "13:15" && h !== "13:30" && h !== "13:45") slots.push(h);
  }
  return slots;
})();

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
    "target": ademar,
    "tgt": ademar,
    "ademar": ademar,
    "ademar de barros": ademar,
    "oticas target": ademar,
    "oticas target ademar de barros": ademar,
    "santo antonio": ademar,
    "sto. antonio": ademar,
  };

  return mapa[key] || raw;
}

// Ano fora dessa faixa nunca é uma data real de agendamento -- é sinal de
// corrupção (já aconteceu em produção: agendamentos vindos desse fluxo
// gravados com ano 26, 2626, 62026, 72026, provavelmente de texto livre do
// WhatsApp que não bateu com nenhum formato esperado e caiu no fallback
// `new Date(s)`, cujo parsing é permissivo e imprevisível).
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
      const brShort = s.match(/^(\d{1,2})\/(\d{1,2})$/);
      if (brShort) {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(Number(brShort[2])).padStart(2, "0");
        const day = String(Number(brShort[1])).padStart(2, "0");
        let candidate = `${year}-${month}-${day}`;
        const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        if (candidate < today) candidate = `${year + 1}-${month}-${day}`;
        resultado = candidate;
      } else {
        const d = new Date(s);
        if (!Number.isNaN(d.getTime())) resultado = d.toISOString().slice(0, 10);
      }
    }
  }
  if (!resultado) return null;
  return anoRazoavel(Number(resultado.slice(0, 4))) ? resultado : null;
}

async function reagendarAgendamentoPorLead({ leadId, data, horario }) {
  const dataPg = toPgDate(data);
  const horarioNormalizado = clean(horario).replace(/^(\d{1,2})h(\d{2})?$/i, (_, h, m) =>
    `${String(Number(h)).padStart(2, "0")}:${m || "00"}`
  );

  if (!leadId) return { ok: false, error: "Lead do Kommo nao informado." };
  if (!dataPg) return { ok: false, error: "Data invalida. Use DD/MM ou DD/MM/AAAA." };
  if (!/^\d{2}:\d{2}$/.test(horarioNormalizado)) {
    return { ok: false, error: "Horario invalido. Use HH:MM." };
  }

  const today = new Date().toISOString().slice(0, 10);
  if (dataPg < today) return { ok: false, error: "A nova data precisa ser hoje ou uma data futura." };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT * FROM agendamentos
       WHERE kommo_lead_id = $1
         AND status = ANY($2::text[])
         AND excluido_em IS NULL
       ORDER BY data_agendamento DESC, horario DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [String(leadId), ["Agendado", "Confirmado"]]
    );

    if (!current.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Nenhum agendamento ativo foi encontrado para este lead." };
    }

    const appointment = current.rows[0];
    const loja = normalizeLoja(appointment.loja);
    if (!getHorariosLoja(loja, dataPg).includes(horarioNormalizado)) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Esse horario nao faz parte do atendimento da loja nessa data." };
    }
    if (await estaLojaBloqueada(loja, dataPg, horarioNormalizado)) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Esse horário está bloqueado para atendimento. Escolha outro horário." };
    }

    const optometristaLivre = await buscarPrimeiroOptometristaLivre(
      client,
      loja,
      dataPg,
      horarioNormalizado,
      appointment.optometrista,
      appointment.gas_id
    );
    if (!optometristaLivre) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Esse horario acabou de ser reservado. Escolha outro horario." };
    }

    const updated = await client.query(
      `UPDATE agendamentos
          SET data_agendamento = $1,
              horario = $2,
              optometrista = $3,
              status = 'Agendado',
              compareceu = 'Pendente',
              lembrete_24h_em = NULL,
              observacao = CONCAT(COALESCE(observacao, ''), $4::text),
              atualizado_em = CURRENT_TIMESTAMP
        WHERE id = $5
        RETURNING id, nome, loja, optometrista,
                  TO_CHAR(data_agendamento, 'DD/MM/YYYY') AS data_agendamento,
                  horario`,
      [
        dataPg,
        horarioNormalizado,
        optometristaLivre,
        `\nReagendado pelo WhatsApp/Kommo em ${new Date().toISOString()} (antes: ${toBrDate(appointment.data_agendamento)} ${appointment.horario}).`,
        appointment.id,
      ]
    );

    await client.query(
      `INSERT INTO logs_sistema (tipo, origem, mensagem, detalhes)
       VALUES ('kommo','salesbot','Agendamento reagendado pelo Kommo',$1)`,
      [JSON.stringify({
        agendamento_id: appointment.id,
        kommo_lead_id: String(leadId),
        loja,
        data_anterior: toBrDate(appointment.data_agendamento),
        horario_anterior: appointment.horario,
        nova_data: dataPg,
        novo_horario: horarioNormalizado,
      })]
    );

    await client.query("COMMIT");
    _cache.delete(`disponibilidade|${loja}|${toPgDate(appointment.data_agendamento)}`);
    _cache.delete(`disponibilidade|${loja}|${dataPg}`);
    return { ok: true, ...updated.rows[0] };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[Scheduling] Erro ao reagendar no banco:", e.message);
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
}

async function cancelarAgendamentoPorLead({ leadId, motivo = "Cancelado pelo cliente no WhatsApp/Kommo" }) {
  if (!leadId) return { ok: false, error: "Lead do Kommo nao informado." };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT id, loja, data_agendamento, horario
         FROM agendamentos
        WHERE kommo_lead_id = $1
          AND status = ANY($2::text[])
          AND excluido_em IS NULL
        ORDER BY data_agendamento DESC, horario DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [String(leadId), ["Agendado", "Confirmado"]]
    );
    if (!current.rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Nenhum agendamento ativo foi encontrado para este lead." };
    }
    const appointment = current.rows[0];
    await client.query(
      `UPDATE agendamentos
          SET status = 'Cancelado',
              observacao = CONCAT(COALESCE(observacao, ''), $1::text),
              atualizado_em = CURRENT_TIMESTAMP
        WHERE id = $2`,
      [`\n${motivo} em ${new Date().toISOString()}.`, appointment.id]
    );
    await client.query(
      `INSERT INTO logs_sistema (tipo, origem, mensagem, detalhes)
       VALUES ('kommo','salesbot','Agendamento cancelado pelo Kommo',$1)`,
      [JSON.stringify({ agendamento_id: appointment.id, kommo_lead_id: String(leadId), motivo })]
    );
    await client.query("COMMIT");
    _cache.delete(`disponibilidade|${normalizeLoja(appointment.loja)}|${toPgDate(appointment.data_agendamento)}`);
    return { ok: true, id: appointment.id };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
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
  for (let m = startHour * 60; m <= endHour * 60; m += 15) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    slots.push(`${hh}:${mm}`);
  }
  return slots;
}

function getHorariosLoja(loja, data) {
  const pgDate = toPgDate(data);
  if (!pgDate) return TODOS_HORARIOS;

  const date = new Date(pgDate + "T12:00:00");
  const day = date.getDay();
  if (day === 0) return [];

  let slots = generateSlots(10, day === 6 ? 16 : 18);
  const lojaKey = stripAccents(loja).replace(/[^a-z]/g, "");
  const isGonzagaSantos = lojaKey.includes("gonzaga") || lojaKey.includes("santos");
  // Gonzaga: almoço 14:00–14:45 em dias úteis. Demais lojas: 13:00–13:45.
  if (isGonzagaSantos && day >= 1 && day <= 5) {
    slots = slots.filter((h) => h !== "14:00" && h !== "14:15" && h !== "14:30" && h !== "14:45");
  } else if (!isGonzagaSantos) {
    slots = slots.filter((h) => h !== "13:00" && h !== "13:15" && h !== "13:30" && h !== "13:45");
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
      if (await estaLojaBloqueada(lojaNormalizada, dataPg, horario)) continue;
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
  if (!getHorariosLoja(lojaNormalizada, dataPg).includes(horarioNormalizado)) {
    return { ok: false, error: "Esse horario nao faz parte do atendimento da loja nessa data." };
  }
  if (await estaLojaBloqueada(lojaNormalizada, dataPg, horarioNormalizado)) {
    return { ok: false, error: "Esse horário está bloqueado para atendimento. Escolha outro horário." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existente = leadId ? await client.query(
      `SELECT * FROM agendamentos
       WHERE kommo_lead_id = $1
         AND status = ANY($2::text[])
         AND excluido_em IS NULL
       ORDER BY data_agendamento DESC, horario DESC, id DESC
       LIMIT 1
       FOR UPDATE`,
      [String(leadId), PUBLIC_BLOCKING_STATUSES]
    ) : { rows: [] };
    const agendamentoExistente = existente.rows[0] || null;

    if (
      agendamentoExistente &&
      normalizeLoja(agendamentoExistente.loja) === lojaNormalizada &&
      toPgDate(agendamentoExistente.data_agendamento) === dataPg &&
      clean(agendamentoExistente.horario) === horarioNormalizado
    ) {
      await client.query("COMMIT");
      return {
        ok: true,
        unchanged: true,
        id: agendamentoExistente.id,
        data_agendamento: toBrDate(dataPg),
        horario: horarioNormalizado,
        loja: lojaNormalizada,
        optometrista: agendamentoExistente.optometrista || "A definir",
      };
    }

    const gasId = agendamentoExistente?.gas_id || (leadId
      ? makeId("kommo", String(leadId))
      : makeId("kommo", stableHash({ nomeNormalizado, whatsappNormalizado, lojaNormalizada, dataPg, horarioNormalizado })));

    const optometristaLivre = await buscarPrimeiroOptometristaLivre(
      client,
      lojaNormalizada,
      dataPg,
      horarioNormalizado,
      optometrista,
      agendamentoExistente?.gas_id || gasId
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

    const agendamento = agendamentoExistente
      ? await client.query(
        `UPDATE agendamentos SET
          gas_id = COALESCE(gas_id, $1),
          nome = $2, whatsapp = $3, email = $4, loja = $5, optometrista = $6,
          data_agendamento = $7, horario = $8, observacao = $9,
          status = 'Agendado', compareceu = 'Pendente',
          access_tags = 'origem:kommo;canal:salesbot;fluxo:agendamento',
          kommo_lead_id = $10, origem_sync = 'kommo_bot', excluido_em = NULL,
          lembrete_24h_em = NULL, atualizado_em = CURRENT_TIMESTAMP
        WHERE id = $11
        RETURNING *`,
        [
          gasId, nomeNormalizado, whatsappNormalizado, emailNormalizado || null,
          lojaNormalizada, optometristaLivre, dataPg, horarioNormalizado,
          `Agendado pelo bot - Lead Kommo #${leadId}`, String(leadId), agendamentoExistente.id,
        ]
      )
      : await client.query(
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

    if (!agendamentoExistente) {
      setImmediate(() => mailingboss.sincronizarLead(agendamento.rows[0], "kommo"));
    }

    return {
      ok: true,
      updated: !!agendamentoExistente,
      created: !agendamentoExistente,
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

async function buscarAgendamentoAtivoPorLead(leadId) {
  if (!leadId) return null;
  const { rows } = await pool.query(
    `SELECT id, nome, loja, optometrista, horario,
            TO_CHAR(data_agendamento, 'DD/MM/YYYY') AS data_agendamento
       FROM agendamentos
      WHERE kommo_lead_id = $1
        AND status = ANY($2::text[])
        AND excluido_em IS NULL
      ORDER BY data_agendamento DESC, horario DESC, id DESC
      LIMIT 1`,
    [String(leadId), PUBLIC_BLOCKING_STATUSES]
  );
  return rows[0] || null;
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
  buscarAgendamentoAtivoPorLead,
  reagendarAgendamentoPorLead,
  cancelarAgendamentoPorLead,
  getContatoDoLead,
  adicionarBloqueio,
  removerBloqueio,
  listarBloqueios,
};
