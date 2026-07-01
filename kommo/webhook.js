// Kommo Webhook Router — Sistema Óticas Target

const crypto      = require("crypto");
const express     = require("express");
const { Pool }    = require("pg");
const router      = express.Router();
const kommo       = require("./client");
const scheduling  = require("./scheduling");
const SM          = require("./bot/stateManager");
const { processMessage, processNewLead } = require("./bot/flowEngine");
const { adicionarBloqueio, removerBloqueio, listarBloqueios } = require("./scheduling");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

function safeEqual(value, expected) {
  const a = Buffer.from(String(value || ""));
  const b = Buffer.from(String(expected || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function webhookSecret(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(
    req.headers["x-kommo-webhook-secret"] ||
    req.query.secret ||
    req.body.secret ||
    ""
  ).trim();
}

function requireWebhookSecret(req, res, next) {
  const expected = process.env.KOMMO_WEBHOOK_SECRET || "";
  if (!expected) return res.status(503).json({ ok: false, message: "KOMMO_WEBHOOK_SECRET nao configurado." });
  if (!safeEqual(webhookSecret(req), expected)) {
    return res.status(401).json({ ok: false, message: "Webhook Kommo nao autorizado." });
  }
  return next();
}

function normalizeLoja(loja = "") {
  if (/santos/i.test(loja) || /gonzaga/i.test(loja)) return "Gonzaga & Santos";
  return loja.trim();
}

function getCampo(campos = [], code) {
  const f = campos.find((c) => c.field_code === code);
  return f?.values?.[0]?.value || "";
}

// ── Extrai entrada de mensagem do payload do Kommo ───────────────
// O Kommo pode enviar o evento em formatos ligeiramente diferentes
function extractMessageEntry(payload) {
  const msg = payload?.message?.add?.[0] || payload?.message?.[0];
  if (!msg) return null;

  // element_type "2" = lead no Kommo
  const leadId =
    msg.lead_id ||
    msg.conversation?.lead_id ||
    (msg.element_type === "2" || msg.element_type === 2 ? msg.element_id : null) ||
    msg.entity_id ||
    null;

  const talkId     = msg.talk_id  || msg.conversation?.id || null;
  const chatId     = msg.chat_id  || null;
  const text       = msg.text     || msg.content?.text    || "";
  const authorType = msg.author?.type || msg.author_type  || "contact";

  // Nome do contato — presente em contacts.update no payload add_message
  const contact_name = payload?.contacts?.update?.[0]?.name || null;

  // Pipeline ID — presente em leads.update ou leads.add quando Kommo inclui no payload
  const pipeline_id =
    payload?.leads?.update?.[0]?.pipeline_id ||
    payload?.leads?.add?.[0]?.pipeline_id    ||
    null;

  return { leadId, talkId, chatId, text, authorType, contact_name, pipeline_id };
}

// ── POST /webhook/kommo ──────────────────────────────────────────
router.post("/webhook/kommo", requireWebhookSecret, async (req, res) => {
  // Sempre responde 200 — Kommo para de reenviar se receber erro
  res.status(200).json({ received: true });

  const payload = req.body;
  console.log("[Webhook/Kommo] Evento:", JSON.stringify(payload).slice(0, 400));

  try {

    // ── Evento: nova mensagem no inbox ─────────────────────────
    if (payload?.message?.add) {
      const entry = extractMessageEntry(payload);

      // No modo Salesbot, o Kommo chama /api/salesbot para mensagens do cliente.
      // Mas ainda precisamos rastrear mensagens de ATENDENTES para o handoff bot↔humano.
      if (process.env.KOMMO_USE_SALESBOT === "true") {
        if (entry?.leadId && entry.authorType === "user") {
          SM.markHumanActivity(String(entry.leadId));
          console.log(`[Webhook/Kommo] 👤 Atendente registrado — lead ${entry.leadId}`);
        } else {
          console.log("[Webhook/Kommo] Modo Salesbot — message.add do cliente ignorado (Salesbot processa)");
        }
        return;
      }

      if (!entry?.leadId) {
        console.log("[Webhook/Kommo] message.add sem lead_id — ignorando");
        return;
      }

      console.log(`[Webhook/Kommo] 💬 Mensagem no lead ${entry.leadId} — autor: ${entry.authorType}`);
      await processMessage({
        leadId:     String(entry.leadId),
        talkId:     entry.talkId ? String(entry.talkId) : null,
        chatId:     entry.chatId  ? String(entry.chatId)  : null,
        text:       entry.text,
        authorType: entry.authorType,
      });
      return;
    }

    // ── Evento: novo lead adicionado ao pipeline ───────────────
    if (payload?.leads?.add) {
      const leadEntry = payload.leads.add[0];
      if (!leadEntry?.id) return;

      console.log(`[Webhook/Kommo] 🆕 Novo lead ${leadEntry.id}`);
      await processNewLead(String(leadEntry.id));
      return;
    }

    // ── Evento: mudança de estágio / atualização de lead ───────
    const leadEntry =
      payload?.leads?.status?.[0] ||
      payload?.leads?.update?.[0] || null;

    if (!leadEntry) {
      console.log("[Webhook/Kommo] Payload sem evento mapeado — ignorando");
      return;
    }

    // Verifica se está no estágio de agendamento manual (via atendente)
    const stageAgendar = process.env.KOMMO_STAGE_AGENDAR;
    if (stageAgendar && String(leadEntry.status_id) !== String(stageAgendar)) {
      console.log(`[Webhook/Kommo] Estágio ${leadEntry.status_id} — sem ação de agendamento`);
      return;
    }

    // Se chegou aqui, é um agendamento criado manualmente pelo atendente
    const leadId = leadEntry.id;
    console.log(`[Webhook/Kommo] 📅 Agendamento manual — lead ${leadId}`);

    const lead   = await kommo.getLead(leadId);
    const campos = lead?.custom_fields_values || [];
    const contato = lead?._embedded?.contacts?.[0] || {};

    const loja            = normalizeLoja(getCampo(campos, "LOJA"));
    const dataAgendamento = getCampo(campos, "DATA_AGENDAMENTO");
    const horario         = getCampo(campos, "HORARIO");
    const optometrista    = getCampo(campos, "OPTOMETRISTA");

    if (!dataAgendamento || !horario) {
      console.log("[Webhook/Kommo] DATA_AGENDAMENTO ou HORARIO não preenchidos — ignorando");
      await kommo.addNote(leadId, "⚠️ Para agendar, preencha os campos: DATA_AGENDAMENTO e HORARIO no lead.");
      return;
    }

    const dbResult = await scheduling.criarAgendamento({
      nome: contato.name || lead.name || "Sem nome",
      whatsapp: getCampo(campos, "PHONE") || "",
      email: getCampo(campos, "EMAIL") || "",
      loja,
      optometrista,
      data: dataAgendamento,
      horario,
      leadId,
    });
    console.log("[Webhook/Kommo] PostgreSQL:", JSON.stringify(dbResult).slice(0, 200));

    if (dbResult?.ok) {
      await kommo.addNote(leadId,
        `✅ Agendamento criado no sistema\n📅 ${dataAgendamento} às ${horario}\n🏪 ${loja}\n👁 ${optometrista || "A definir"}`
      );
    } else {
      await kommo.addNote(leadId, `⚠️ Erro ao criar agendamento: ${dbResult?.error || "desconhecido"}`);
    }

  } catch (err) {
    console.error("[ERRO][Webhook/Kommo]", err.message);
  }
});

// Rastreador em memória dos últimos 20 eventos recebidos (para diagnóstico)
const _recentEvents = [];
function trackEvent(tipo, resumo) {
  _recentEvents.unshift({ tipo, resumo, ts: new Date().toISOString() });
  if (_recentEvents.length > 20) _recentEvents.pop();
}

// ── POST /api/kommo/message ──────────────────────────────────────
// Webhook para eventos: add_message, add_talk, add_lead.
// Kommo não envia secret — verifica pelo subdomain no payload.
router.post("/api/kommo/message", async (req, res) => {
  res.status(200).json({ received: true });

  const payload = req.body;

  const incomingSubdomain = payload?.account?.subdomain || "";
  const expectedSubdomain = process.env.KOMMO_SUBDOMAIN || "";
  if (expectedSubdomain && incomingSubdomain && incomingSubdomain !== expectedSubdomain) {
    console.log(`[Kommo/Message] Subdomínio inesperado: ${incomingSubdomain} — ignorando`);
    return;
  }

  console.log("[Kommo/Message] Payload:", JSON.stringify(payload).slice(0, 400));

  try {
    // ── Evento: nova conversa WhatsApp (add_talk) ────────────────
    if (payload?.talk?.add) {
      const talk = payload.talk.add[0];
      // Kommo pode usar lead_id OU entity_id (quando entity_type = "lead")
      const leadId =
        talk?.lead_id ||
        (talk?.entity_type === "lead" || talk?.entity_type === 2 ? talk?.entity_id : null) ||
        null;
      trackEvent("add_talk", `lead=${leadId} talk=${talk?.id} pipeline=${talk?.pipeline_id} entity_id=${talk?.entity_id}`);
      if (leadId) {
        console.log(`[Kommo/Message] 📱 Nova conversa — lead ${leadId}, talk ${talk.id}`);
        await processNewLead(String(leadId), {
          talkId:      talk.id           ? String(talk.id)           : null,
          chatId:      talk.chat_id      ? String(talk.chat_id)      : null,
          pipeline_id: talk.pipeline_id  ? String(talk.pipeline_id)  : null,
        });
      } else {
        console.log("[Kommo/Message] add_talk sem lead_id/entity_id:", JSON.stringify(talk).slice(0, 200));
      }
      return;
    }

    // ── Evento: novo lead criado (add_lead) ──────────────────────
    if (payload?.leads?.add && !payload?.message?.add) {
      const lead = payload.leads.add[0];
      trackEvent("add_lead", `lead=${lead?.id} pipeline=${lead?.pipeline_id}`);
      if (lead?.id) {
        console.log(`[Kommo/Message] 🆕 Novo lead — lead ${lead.id}`);
        await processNewLead(String(lead.id), {
          pipeline_id: lead.pipeline_id ? String(lead.pipeline_id) : null,
        });
      }
      return;
    }

    // ── Evento: nova mensagem (add_message) ─────────────────────
    if (!payload?.message?.add) {
      trackEvent("unknown", JSON.stringify(payload).slice(0, 80));
      console.log("[Kommo/Message] Payload sem evento mapeado — ignorando");
      return;
    }

    const entry = extractMessageEntry(payload);
    if (!entry?.leadId) {
      trackEvent("add_message_sem_lead", JSON.stringify(payload?.message?.add?.[0]).slice(0, 80));
      console.log("[Kommo/Message] message.add sem lead_id — ignorando");
      return;
    }

    if (entry.authorType === "user") {
      trackEvent("add_message_atendente", `lead=${entry.leadId}`);
      SM.markHumanActivity(String(entry.leadId));
      console.log(`[Kommo/Message] 👤 Atendente — lead ${entry.leadId}`);
      return;
    }

    trackEvent("add_message_cliente", `lead=${entry.leadId} talk=${entry.talkId} chat=${entry.chatId} text="${entry.text.slice(0,40)}"`);
    console.log(`[Kommo/Message] 💬 Contato — lead ${entry.leadId} talk=${entry.talkId} — "${entry.text.slice(0, 60)}"`);

    await processMessage({
      leadId:       String(entry.leadId),
      talkId:       entry.talkId       ? String(entry.talkId)       : null,
      chatId:       entry.chatId       ? String(entry.chatId)       : null,
      text:         entry.text,
      authorType:   entry.authorType   || "contact",
      contact_name: entry.contact_name || null,
      pipeline_id:  entry.pipeline_id  ? String(entry.pipeline_id)  : null,
    });

  } catch (err) {
    console.error("[ERRO][Kommo/Message]", err.message);
  }
});

// ── Admin: bloqueios de disponibilidade ─────────────────────────
// GET  /api/admin/bloqueios           — lista bloqueios ativos
// POST /api/admin/bloqueios           — adiciona bloqueio { loja, data, motivo }
// DELETE /api/admin/bloqueios         — remove bloqueio   { loja, data }
// Acesso protegido por KOMMO_WEBHOOK_SECRET no header Authorization.

router.get("/api/admin/bloqueios", requireWebhookSecret, async (req, res) => {
  try {
    const lista = await listarBloqueios();
    res.json({ ok: true, bloqueios: lista });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/api/admin/bloqueios", requireWebhookSecret, async (req, res) => {
  const { loja, data, motivo } = req.body || {};
  if (!loja || !data) return res.status(400).json({ ok: false, error: "Campos obrigatórios: loja, data." });
  try {
    await adicionarBloqueio({ loja, data, motivo, criadoPor: "admin" });
    console.log(`[Admin] ⛔ Bloqueio adicionado — ${loja} em ${data}`);
    res.json({ ok: true, mensagem: `Loja "${loja}" bloqueada em ${data}.` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete("/api/admin/bloqueios", requireWebhookSecret, async (req, res) => {
  const { loja, data } = req.body || {};
  if (!loja || !data) return res.status(400).json({ ok: false, error: "Campos obrigatórios: loja, data." });
  try {
    const removed = await removerBloqueio({ loja, data });
    console.log(`[Admin] ✅ Bloqueio removido — ${loja} em ${data}`);
    res.json({ ok: true, mensagem: removed ? `Bloqueio removido para "${loja}" em ${data}.` : "Nenhum bloqueio encontrado." });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/pipeline-stages/:pipelineId ──────────────────
// Lista estágios de um pipeline específico.
router.get("/api/admin/pipeline-stages/:pipelineId", requireWebhookSecret, async (req, res) => {
  try {
    const data = await kommo.request("GET", `/leads/pipelines/${req.params.pipelineId}`);
    const statuses = data?._embedded?.statuses || data?.statuses || [];
    const stages = statuses.map(s => ({ id: s.id, nome: s.name, sort: s.sort }))
      .sort((a, b) => a.sort - b.sort);
    res.json({ ok: true, pipeline_id: req.params.pipelineId, nome: data.name, stages });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/admin/migrate-tv-leads ────────────────────────────
// Busca todos os leads com Teste de Visão agendado pelo bot no banco,
// move para o estágio "Agendamento (Teste de Visão)" em cada pipeline
// e aplica a etiqueta "Agendado pelo Bot".
const STAGES_TV = {
  "9511355":  103341012,
  "9907903":  103341100,
  "12931092": 103341140,
  "12931096": 103340708,
};
const PREFIX_TO_PIPELINE_MAP = {
  tgt: "9511355",
  gon: "9907903",
  ens: "12931092",
  pit: "12931096",
};

router.post("/api/admin/migrate-tv-leads", requireWebhookSecret, async (req, res) => {
  const dryRun = req.body?.dry_run === true;
  const TAG = req.body?.etiqueta || "Agendado pelo Bot";

  let dbLeads = [];
  try {
    const { rows } = await pool.query(
      `SELECT lead_id, etapa, loja_prefix, loja, nome, state
       FROM kommo_bot_states
       WHERE etapa IN ('tv_aguardando_confirm','tv_agendado','lembrete_resposta')
         AND loja_prefix IS NOT NULL`
    );
    dbLeads = rows;
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro DB: " + e.message });
  }

  // Também inclui leads com agendamento confirmado no PostgreSQL mas com etapa diferente
  try {
    const { rows: agRows } = await pool.query(
      `SELECT DISTINCT kommo_lead_id AS lead_id
       FROM agendamentos
       WHERE kommo_lead_id IS NOT NULL
         AND status IN ('Agendado','Confirmado')
         AND excluido_em IS NULL`
    );
    const existing = new Set(dbLeads.map(r => String(r.lead_id)));
    for (const r of agRows) {
      if (!existing.has(String(r.lead_id))) {
        dbLeads.push({ lead_id: r.lead_id, etapa: "tv_agendado_db", loja_prefix: null });
      }
    }
  } catch {}

  const results = [];
  for (const row of dbLeads) {
    const leadId = String(row.lead_id);
    let prefix = row.loja_prefix;

    // Tenta descobrir pipeline via API do Kommo se prefix desconhecido
    if (!prefix || !PREFIX_TO_PIPELINE_MAP[prefix]) {
      try {
        const lead = await kommo.getLead(leadId);
        const pid = String(lead?.pipeline_id || "");
        prefix = Object.entries(PREFIX_TO_PIPELINE_MAP).find(([, v]) => v === pid)?.[0] || null;
      } catch {}
    }

    const pipelineId = PREFIX_TO_PIPELINE_MAP[prefix] || null;
    const stageId    = pipelineId ? STAGES_TV[pipelineId] : null;

    if (!stageId) {
      results.push({ lead_id: leadId, status: "sem_pipeline", etapa: row.etapa });
      continue;
    }

    if (dryRun) {
      results.push({ lead_id: leadId, status: "dry_run", pipeline: pipelineId, stage: stageId, etiqueta: TAG });
      continue;
    }

    try {
      // Busca tags atuais e adiciona a nova sem remover as existentes
      const lead = await kommo.getLead(leadId);
      const tagsAtuais = (lead?._embedded?.tags || []).map(t => t.name);
      const novasTags  = tagsAtuais.includes(TAG) ? tagsAtuais : [...tagsAtuais, TAG];

      await kommo.moveToStage(leadId, stageId);
      await kommo.setLeadTags(leadId, novasTags);

      results.push({ lead_id: leadId, status: "ok", pipeline: pipelineId, stage: stageId, tags: novasTags });
    } catch (e) {
      results.push({ lead_id: leadId, status: "erro", erro: e.message });
    }

    // Respeita rate limit do Kommo
    await new Promise(r => setTimeout(r, 300));
  }

  const ok  = results.filter(r => r.status === "ok").length;
  const err = results.filter(r => r.status === "erro").length;
  const sem = results.filter(r => r.status === "sem_pipeline").length;

  console.log(`[Admin] Migrate TV leads — ok:${ok} erro:${err} sem_pipeline:${sem} dry:${dryRun}`);
  res.json({ ok: true, dry_run: dryRun, total: results.length, processados: ok, erros: err, sem_pipeline: sem, detalhe: results });
});

// ── GET /api/admin/all-pipelines-stages ──────────────────────────
// Lista estágios das 4 lojas de uma vez.
router.get("/api/admin/all-pipelines-stages", requireWebhookSecret, async (req, res) => {
  const pipelines = [
    { id: "9511355",  loja: "Target (Ademar)" },
    { id: "9907903",  loja: "Gonzaga" },
    { id: "12931092", loja: "Enseada" },
    { id: "12931096", loja: "Pitangueiras" },
  ];
  try {
    const results = await Promise.all(pipelines.map(async p => {
      try {
        const data = await kommo.request("GET", `/leads/pipelines/${p.id}`);
        const statuses = data?._embedded?.statuses || data?.statuses || [];
        return {
          pipeline_id: p.id,
          loja: p.loja,
          nome_pipeline: data.name,
          stages: statuses.map(s => ({ id: s.id, nome: s.name, sort: s.sort }))
            .sort((a, b) => a.sort - b.sort),
        };
      } catch (e) {
        return { pipeline_id: p.id, loja: p.loja, erro: e.message };
      }
    }));
    res.json({ ok: true, pipelines: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/admin/diagnostico ───────────────────────────────────
// Diagnóstico completo do bot: env vars, estados no DB, eventos recentes.
router.get("/api/admin/diagnostico", requireWebhookSecret, async (req, res) => {
  const diag = {
    timestamp: new Date().toISOString(),
    env: {
      BOT_ENABLED:               process.env.BOT_ENABLED ?? "(não definido — padrão: ativo)",
      KOMMO_USE_SALESBOT:        process.env.KOMMO_USE_SALESBOT ?? "(não definido — padrão: false)",
      KOMMO_SUBDOMAIN:           process.env.KOMMO_SUBDOMAIN   ? "✅ " + process.env.KOMMO_SUBDOMAIN : "❌ ausente",
      KOMMO_ACCESS_TOKEN:        process.env.KOMMO_ACCESS_TOKEN ? "✅ configurado" : "❌ ausente",
      KOMMO_WEBHOOK_SECRET:      process.env.KOMMO_WEBHOOK_SECRET ? "✅ configurado" : "❌ ausente",
      DATABASE_URL:              process.env.DATABASE_URL ? "✅ configurado" : "❌ ausente",
      KOMMO_STAGES_MAP:          process.env.KOMMO_STAGES_MAP ? "✅ configurado" : "(não definido — usando DEFAULT_STAGES_MAP hardcoded)",
      LINK_TESTE_VISAO:          process.env.LINK_TESTE_VISAO ?? "(não definido — usando padrão)",
    },
    webhook_url_ativo:     "POST https://sistema.oticastgt.com.br/api/kommo/message",
    webhook_url_legado:    "POST https://sistema.oticastgt.com.br/webhook/kommo (requer KOMMO_WEBHOOK_SECRET no header)",
    modo_bot:              process.env.KOMMO_USE_SALESBOT === "true" ? "SALESBOT (/api/salesbot)" : "WEBHOOK DIRETO (/api/kommo/message)",
    ultimos_eventos_recebidos: _recentEvents,
    db: {},
    pipelines: {
      "9511355":  { loja: "Target/Ademar",  bot_ativo: 108252660, agendamento_tv: 103341012, atendente: 108252664 },
      "9907903":  { loja: "Gonzaga",        bot_ativo: 108252672, agendamento_tv: 103341100, atendente: 108252676 },
      "12931092": { loja: "Enseada",        bot_ativo: 108252684, agendamento_tv: 103341140, atendente: 108252688 },
      "12931096": { loja: "Pitangueiras",   bot_ativo: 108252696, agendamento_tv: 103340708, atendente: 108252700 },
    },
  };

  try {
    const r = await pool.query(`
      SELECT etapa, loja_prefix, COUNT(*)::int AS total
      FROM kommo_bot_states
      GROUP BY etapa, loja_prefix
      ORDER BY total DESC
    `);
    diag.db.estados_por_etapa = r.rows;
  } catch (e) { diag.db.estados_erro = e.message; }

  try {
    const r = await pool.query(`
      SELECT lead_id, etapa, loja_prefix, bot_active, updated_at
      FROM kommo_bot_states
      ORDER BY updated_at DESC LIMIT 10
    `);
    diag.db.ultimos_leads_ativos = r.rows;
  } catch {}

  res.json(diag);
});

// ── GET /kommo/health ────────────────────────────────────────────
router.get("/kommo/health", async (req, res) => {
  let db_bot_states = null;
  try {
    const r = await pool.query("SELECT COUNT(*)::int AS total FROM kommo_bot_states");
    db_bot_states = r.rows[0].total;
  } catch {}

  res.json({
    ok:                        true,
    bot_enabled:               process.env.BOT_ENABLED !== "false",
    kommo:                     !!process.env.KOMMO_ACCESS_TOKEN,
    salesbot_mode:             process.env.KOMMO_USE_SALESBOT === "true",
    stages_map_configured:     !!process.env.KOMMO_STAGES_MAP,
    webhook_secret_configured: !!process.env.KOMMO_WEBHOOK_SECRET,
    subdomain:                 process.env.KOMMO_SUBDOMAIN || "não configurado",
    database:                  !!process.env.DATABASE_URL,
    db_bot_states,
    timestamp:                 new Date().toISOString(),
  });
});

module.exports = router;
