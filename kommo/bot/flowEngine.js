// Bot Flow Engine - SalesBot Kommo Oticas TGT.

const kommo = require("../client");
const labels = require("../labels");
const MSG = require("./messages");
const SM = require("./stateManager");
const scheduling = require("../scheduling");

const pendingResponses = new Map();

// Fila por lead: garante que mensagens do mesmo lead são processadas em sequência,
// nunca em paralelo. Evita race condition quando o Kommo dispara 2 Salesbot callbacks
// quasi-simultâneos para o mesmo lead.
const leadQueue = new Map();

function enqueueForLead(leadId, fn) {
  const key = String(leadId);
  const prev = leadQueue.get(key) || Promise.resolve();
  const next = prev.then(fn).catch((e) => {
    console.error(`[BOT][${key}] Erro na fila:`, e.message);
  });
  leadQueue.set(key, next);
  next.finally(() => {
    if (leadQueue.get(key) === next) leadQueue.delete(key);
  });
  return next;
}

const PIPELINE_TO_PREFIX = {
  "9511355": "tgt",
  "9907903": "gon",
  "12931092": "ens",
  "12931096": "pit",
};

const PREFIX_TO_PIPELINE = {
  tgt: "9511355",
  gon: "9907903",
  ens: "12931092",
  pit: "12931096",
};

// Mapa de estágios por pipeline — IDs confirmados em 2026-07-01.
// Sobrescrito por KOMMO_STAGES_MAP (env var JSON) se configurado.
const DEFAULT_STAGES_MAP = {
  "9511355": {  // Target / Ademar
    bot_ativo:    108252660,
    informacoes:  103056032,
    agendamento:  103341012,
    agendado:     103341012,
    orcamento:    106146176,
    atendente:    108252664,
    recuperacao:  108252668,
  },
  "9907903": {  // Gonzaga
    bot_ativo:    108252672,
    informacoes:  103056180,
    agendamento:  103341100,
    agendado:     103341100,
    orcamento:    106135040,
    atendente:    108252676,
    recuperacao:  108252680,
  },
  "12931092": { // Enseada
    bot_ativo:    108252684,
    informacoes:  103056212,
    agendamento:  103341140,
    agendado:     103341140,
    orcamento:    106163000,
    atendente:    108252688,
    recuperacao:  108252692,
  },
  "12931096": { // Pitangueiras
    bot_ativo:    108252696,
    informacoes:  103056236,
    agendamento:  103340708,
    agendado:     103340708,
    orcamento:    106137140,
    atendente:    108252700,
    recuperacao:  108252704,
  },
};

let _stagesMap = null;
function getStagesMap() {
  if (_stagesMap) return _stagesMap;
  try {
    const fromEnv = process.env.KOMMO_STAGES_MAP ? JSON.parse(process.env.KOMMO_STAGES_MAP) : null;
    _stagesMap = fromEnv && Object.keys(fromEnv).length > 0 ? fromEnv : DEFAULT_STAGES_MAP;
  } catch {
    _stagesMap = DEFAULT_STAGES_MAP;
  }
  return _stagesMap;
}

const STORE_ALIASES = {
  gon: ["gon", "gonzaga", "santos", "gonzaga & santos"],
  ens: ["ens", "enseada"],
  pit: ["pit", "pitangueiras"],
  tgt: ["tgt", "target", "santo antonio", "santo antônio", "ademar", "ademar de barros"],
};

const FLOW_GROUPS = {
  principal: ["novo-lead", "menu-enviado", "aguardando-escolha", "redirecionado"],
  info: ["info-novo", "info-submenu", "info-aguardando", "info-lentes", "info-endereco", "info-promocoes", "info-especialista"],
  tv: ["tv-novo", "tv-link-enviado", "tv-aguardando-confirm", "tv-agendado", "tv-especialista"],
  orc: ["orc-novo", "orc-aguardando-receita", "orc-receita-recebida", "orc-em-atendimento", "orc-finalizado"],
  rh: ["rh-novo", "rh-aguardando-curriculo", "rh-curriculo-recebido", "rh-em-analise", "rh-finalizado"],
  pv: ["pv-novo", "pv-submenu", "pv-nota-fiscal", "pv-garantia", "pv-reembolso", "pv-especialista"],
};

function queueResponse(leadId, text) {
  const key = String(leadId);
  const arr = pendingResponses.get(key) || [];
  arr.push(text);
  pendingResponses.set(key, arr);
}

function flushResponses(leadId) {
  const key = String(leadId);
  const arr = pendingResponses.get(key) || [];
  pendingResponses.delete(key);
  return arr;
}

function clean(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function normalize(v) {
  return clean(v).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function prefixFromLoja(loja) {
  const key = normalize(loja);
  for (const [prefix, aliases] of Object.entries(STORE_ALIASES)) {
    if (aliases.some((alias) => key.includes(normalize(alias)))) return prefix;
  }
  return "";
}

function lojaByPrefix(prefix) {
  return MSG.storeByPrefix(prefix || "gon");
}

function prefixFromPipeline(pipelineId) {
  return PIPELINE_TO_PREFIX[String(pipelineId || "")] || "";
}

function parseOption(text) {
  // Exige que a mensagem seja APENAS o número (sem texto junto).
  // Evita que "2 óculos quero orçamento" dispare a opção 2.
  const match = clean(text).match(/^(\d+)$/);
  return match ? match[1] : "";
}

function isYes(text) {
  return ["SIM", "S", "1", "OK", "CONFIRMAR", "CONFIRMADO", "CONFIRMO"].includes(clean(text).toUpperCase());
}

function isNo(text) {
  return ["NAO", "NÃO", "N", "2", "CANCELAR", "VOLTAR"].includes(clean(text).toUpperCase());
}

async function send(talkId, leadId, text) {
  if (process.env.KOMMO_USE_SALESBOT === "true") {
    queueResponse(leadId, text);
    return;
  }

  const chatId = SM.getChatId ? SM.getChatId(leadId) : null;

  try {
    if (talkId) {
      // Usa talkId direto do evento — mais confiável que busca via API
      await kommo.sendMessage(String(talkId), text, chatId || null);
    } else {
      await kommo.sendMessageToLead(leadId, text);
    }
  } catch (e) {
    console.error(`[BOT][${leadId}] Erro ao enviar mensagem (talkId=${talkId}):`, e.message);
    // Tenta fallback se o envio direto falhou e temos talkId
    if (talkId) {
      try {
        await kommo.sendMessageToLead(leadId, text);
      } catch (e2) {
        console.error(`[BOT][${leadId}] Fallback também falhou:`, e2.message);
      }
    }
  }
}

async function moveStage(leadId, stageKey, lojaPrefix) {
  // Prioridade 1: mapa por pipeline (via KOMMO_STAGES_MAP)
  const pipelineId = PREFIX_TO_PIPELINE[lojaPrefix || ""] || "";
  const mapEntry = getStagesMap()[pipelineId] || {};
  const stageId = mapEntry[stageKey]
    // Prioridade 2: env var individual (retrocompatibilidade)
    || process.env[`KOMMO_STAGE_${stageKey.toUpperCase()}`];
  if (!stageId) return;
  await kommo.moveToStage(leadId, stageId).catch((e) =>
    console.error(`[BOT][${leadId}] Erro ao mover estágio (${stageKey}):`, e.message)
  );
}

function labelName(prefix, suffix) {
  return `${prefix}-${suffix}`;
}

function labelsFor(prefix, group) {
  return (FLOW_GROUPS[group] || []).map((suffix) => labelName(prefix, suffix));
}

async function applyFlowLabel(leadId, prefix, group, suffix) {
  await labels.swapLabel(leadId, labelsFor(prefix, group), labelName(prefix, suffix));
}

async function addFlowLabel(leadId, prefix, suffix) {
  await labels.applyLabel(leadId, labelName(prefix, suffix));
}

async function resolveStore(leadId, state, context = {}) {
  const fromState = prefixFromLoja(state.loja) || state.loja_prefix;
  if (fromState) return lojaByPrefix(fromState);

  const fromContext = prefixFromLoja(context.loja || context.store || context.store_name);
  if (fromContext) return lojaByPrefix(fromContext);

  const fromPipeline = prefixFromPipeline(context.pipeline_id || context.pipelineId);
  if (fromPipeline) return lojaByPrefix(fromPipeline);

  try {
    const lead = await kommo.getLead(leadId);
    const fromLeadPipeline = prefixFromPipeline(lead?.pipeline_id);
    if (fromLeadPipeline) return lojaByPrefix(fromLeadPipeline);
  } catch {
    // Em testes locais ou falha temporária da API, usa fallback seguro.
  }

  return lojaByPrefix("gon");
}

async function ensureStoreState(leadId, state, context = {}) {
  const loja = await resolveStore(leadId, state, context);
  if (state.loja !== loja.nome || state.loja_prefix !== loja.prefix) {
    SM.setState(leadId, { loja: loja.nome, loja_prefix: loja.prefix });
    state.loja = loja.nome;
    state.loja_prefix = loja.prefix;
  }
  return loja;
}

async function transferToHuman(leadId, state, talkId, motivo = "solicitação do cliente", extraLabel = "") {
  const loja = lojaByPrefix(state.loja_prefix);
  if (extraLabel) await addFlowLabel(leadId, loja.prefix, extraLabel);

  await send(talkId, leadId, MSG.transferindoParaHumano(loja.nome));
  await kommo.addNote(leadId, `${MSG.notaParaAtendente(state)}\nMotivo: ${motivo}`);
  await labels.setHumanControl(leadId);
  await labels.applyLabel(leadId, labels.LABELS.ATENDIMENTO_HUMANO);
  await moveStage(leadId, "atendente", loja.prefix);
  SM.setState(leadId, { etapa: "transferido", bot_active: false, transferred_at: Date.now() }, { persist: true });
}

function sanitizeNome(v) {
  const s = clean(v);
  return /\{\{.*\}\}/.test(s) ? "" : s; // descarta variável Kommo não resolvida
}

async function handleBoasVindas(leadId, state, talkId, context) {
  const loja = await ensureStoreState(leadId, state, context);
  let nome = sanitizeNome(state.nome) || sanitizeNome(context.contact_name || context.nome);

  if (!nome) {
    try {
      // Tentativa 1: GET /leads/{id}?with=contacts → pega contactId → GET /contacts/{id}
      const lead = await kommo.getLead(leadId);
      const contactId = lead?._embedded?.contacts?.[0]?.id;
      if (contactId) {
        const contact = await kommo.getContact(contactId);
        nome = sanitizeNome(contact?.name || "");
        console.log(`[BOT][${leadId}] Nome via getContact(${contactId}): "${nome}"`);
      }
      // Tentativa 2 (fallback): GET /contacts?filter[leads_id][]={leadId}
      if (!nome) {
        const contacts = await kommo.getContactsByLead(leadId);
        nome = sanitizeNome(contacts[0]?.name || "");
        console.log(`[BOT][${leadId}] Nome via getContactsByLead: "${nome}"`);
      }
    } catch (e) {
      console.error(`[BOT][${leadId}] Erro ao buscar nome do contato:`, e.message);
      nome = "";
    }
  }

  // Guarda apenas o primeiro nome
  if (nome) nome = nome.trim().split(/\s+/)[0];

  SM.setState(leadId, {
    nome,
    loja: loja.nome,
    loja_prefix: loja.prefix,
    etapa: "menu_principal",
    bot_active: true,
  }, { persist: true });

  await labels.setBotControl(leadId);
  await addFlowLabel(leadId, loja.prefix, "novo-lead");
  await addFlowLabel(leadId, loja.prefix, "menu-enviado");
  await applyFlowLabel(leadId, loja.prefix, "principal", "aguardando-escolha");
  await moveStage(leadId, "bot_ativo", loja.prefix);
  await send(talkId, leadId, MSG.boasVindas(nome, loja));
}

// Palavras que indicam saudação genérica — reenvia menu sem penalizar
const SAUDACOES = ["oi", "ola", "bom", "boa", "hello", "hi", "tudo", "menu", "inicio", "ajuda", "alo", "ola", "hey"];
function ehSaudacao(text) {
  if (!text || text.trim().length === 0) return true;
  const n = normalize(text);
  if (n.length <= 3) return true;
  return SAUDACOES.some((s) => n.startsWith(s));
}

async function handleMenuPrincipal(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  const op = parseOption(text);

  // Qualquer mensagem sem número → reapresenta menu sem penalizar.
  // Cobre saudações ("Oi", "Bom dia"), linguagem natural ("Quero agendar"),
  // e qualquer outro texto que não seja uma opção numérica.
  if (!op) {
    console.log(`[BOT][${leadId}] Mensagem sem opção numérica — reapresenta menu`);
    await send(talkId, leadId, MSG.menuPrincipal(loja));
    return;
  }

  if (op === "1") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "info_menu", ultimo_topico: "Informações" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "principal", "redirecionado");
    await addFlowLabel(leadId, loja.prefix, "info-novo");
    await addFlowLabel(leadId, loja.prefix, "info-submenu");
    await applyFlowLabel(leadId, loja.prefix, "info", "info-aguardando");
    await moveStage(leadId, "informacoes", loja.prefix);
    await send(talkId, leadId, MSG.infoMenu());
    return;
  }

  if (op === "2") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "tv_aguardando_confirm", ultimo_topico: "Teste de Visão" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "principal", "redirecionado");
    await addFlowLabel(leadId, loja.prefix, "tv-novo");
    await addFlowLabel(leadId, loja.prefix, "tv-link-enviado");
    await applyFlowLabel(leadId, loja.prefix, "tv", "tv-aguardando-confirm");
    await moveStage(leadId, "agendamento", loja.prefix);
    await send(talkId, leadId, MSG.testeVisao(loja));
    return;
  }

  if (op === "3") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "orcamento_menu", ultimo_topico: "Orçamento" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "principal", "redirecionado");
    await addFlowLabel(leadId, loja.prefix, "orc-novo");
    await moveStage(leadId, "orcamento", loja.prefix);
    await send(talkId, leadId, MSG.orcamentoMenu());
    return;
  }

  if (op === "4") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "rh_menu", ultimo_topico: "Trabalhe Conosco" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "principal", "redirecionado");
    await addFlowLabel(leadId, loja.prefix, "rh-novo");
    await send(talkId, leadId, MSG.trabalheConoscoMenu());
    return;
  }

  if (op === "5") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "pv_menu", ultimo_topico: "Pós Venda" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "principal", "redirecionado");
    await addFlowLabel(leadId, loja.prefix, "pv-novo");
    await applyFlowLabel(leadId, loja.prefix, "pv", "pv-submenu");
    await send(talkId, leadId, MSG.posVendaMenu());
    return;
  }

  // Número enviado mas fora do intervalo 1-5 (ex: "6", "0", "10")
  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) return transferToHuman(leadId, state, talkId, "2 respostas inválidas no menu principal");
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.menuPrincipal(loja));
}

async function handleInfoMenu(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  const op = parseOption(text);

  if (!op) {
    await send(talkId, leadId, MSG.infoMenu());
    return;
  }

  const map = {
    "1": { etapa: "info_aguarda_sim_nao", label: "info-lentes", topic: "Lentes e Armações", message: MSG.infoLentes() },
    "2": { etapa: "info_aguarda_sim_nao", label: "info-endereco", topic: "Endereço e Horário", message: MSG.infoEndereco(loja) },
    "3": { etapa: "info_aguarda_sim_nao", label: "info-promocoes", topic: "Promoções", message: MSG.infoPromocoes() },
  };

  if (map[op]) {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, {
      etapa: map[op].etapa,
      ultimo_topico: map[op].topic,
      ultimo_info_label: map[op].label,
    }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "info", map[op].label);
    await send(talkId, leadId, map[op].message);
    return;
  }

  if (op === "4") {
    SM.resetInvalidCount(leadId);
    await applyFlowLabel(leadId, loja.prefix, "info", "info-especialista");
    await transferToHuman(leadId, state, talkId, "Informações - falar com especialista");
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) return transferToHuman(leadId, state, talkId, "2 respostas inválidas em informações");
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.infoMenu());
}

async function handleInfoSimNao(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);

  if (isYes(text)) {
    await applyFlowLabel(leadId, loja.prefix, "info", "info-especialista");
    await transferToHuman(leadId, state, talkId, `Informações - ${state.ultimo_topico}`);
    return;
  }

  if (isNo(text)) {
    SM.setState(leadId, { etapa: "menu_principal", ultimo_info_label: null }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "principal", "aguardando-escolha");
    await send(talkId, leadId, MSG.menuPrincipal(loja));
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) return transferToHuman(leadId, state, talkId, "Resposta inválida após informações");
  await send(talkId, leadId, "Responda SIM para falar com especialista ou NÃO para voltar ao menu.");
}

async function handleTesteVisao(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  const normalized = normalize(text);

  if (isYes(text) || normalized.includes("confirmado")) {
    SM.setState(leadId, { etapa: "tv_agendado" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "tv", "tv-agendado");
    await labels.applyTrafficLight(leadId, "Agendado");
    await moveStage(leadId, "agendado", loja.prefix);
    await kommo.addNote(leadId, `Teste de Visão confirmado via SalesBot - ${loja.nome}`);
    await send(talkId, leadId, MSG.testeConfirmado(loja));
    return;
  }

  if (normalized.includes("duvida") || normalized.includes("dúvida") || normalized.includes("atendente") || normalized.includes("especialista")) {
    await applyFlowLabel(leadId, loja.prefix, "tv", "tv-especialista");
    await transferToHuman(leadId, state, talkId, "Teste de visão - dúvidas");
    return;
  }

  await send(talkId, leadId, `Quando concluir o agendamento pelo link, responda CONFIRMADO. Se precisar de ajuda, escreva ESPECIALISTA.`);
}

async function handleOrcamentoReceita(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  SM.setState(leadId, { etapa: "orcamento_em_atendimento" }, { persist: true });
  await addFlowLabel(leadId, loja.prefix, "orc-receita-recebida");
  await applyFlowLabel(leadId, loja.prefix, "orc", "orc-em-atendimento");
  await transferToHuman(leadId, { ...state, ultimo_topico: `Orçamento: ${clean(text).slice(0, 120)}` }, talkId, "Orçamento - receita recebida");
}

async function handleOrcamentoMenu(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  const op = parseOption(text);

  if (!op) {
    await send(talkId, leadId, MSG.orcamentoMenu());
    return;
  }

  if (op === "1") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "orcamento_aguardando_receita", ultimo_topico: "Orçamento - Receita" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "orc", "orc-aguardando-receita");
    await send(talkId, leadId, MSG.orcamentoReceita());
    return;
  }

  if (op === "2") {
    SM.resetInvalidCount(leadId);
    await applyFlowLabel(leadId, loja.prefix, "orc", "orc-em-atendimento");
    await transferToHuman(leadId, { ...state, ultimo_topico: "Orçamento - Armação" }, talkId, "Orçamento - quer armação");
    return;
  }

  if (op === "3") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "orcamento_lente", ultimo_topico: "Orçamento - Lente" }, { persist: true });
    await send(talkId, leadId, MSG.orcamentoLente());
    return;
  }

  if (op === "4") {
    SM.resetInvalidCount(leadId);
    await applyFlowLabel(leadId, loja.prefix, "orc", "orc-em-atendimento");
    await transferToHuman(leadId, { ...state, ultimo_topico: "Orçamento - Especialista" }, talkId, "Orçamento - falar com especialista");
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) return transferToHuman(leadId, state, talkId, "2 respostas inválidas em orçamento");
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.orcamentoMenu());
}

async function handleOrcamentoLente(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  await applyFlowLabel(leadId, loja.prefix, "orc", "orc-em-atendimento");
  await transferToHuman(
    leadId,
    { ...state, ultimo_topico: `Orçamento - Lente: ${clean(text).slice(0, 100)}` },
    talkId,
    "Orçamento - tipo de lente especificado"
  );
}

async function handleRhCurriculo(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  SM.setState(leadId, { etapa: "rh_em_analise" }, { persist: true });
  await addFlowLabel(leadId, loja.prefix, "rh-curriculo-recebido");
  await applyFlowLabel(leadId, loja.prefix, "rh", "rh-em-analise");
  await transferToHuman(leadId, { ...state, ultimo_topico: `RH: ${clean(text).slice(0, 120)}` }, talkId, "Trabalhe Conosco - currículo recebido");
}

async function handleRhMenu(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  const op = parseOption(text);

  if (!op) {
    await send(talkId, leadId, MSG.trabalheConoscoMenu());
    return;
  }

  if (op === "1") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "rh_aguardando_curriculo", ultimo_topico: "RH - Currículo" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "rh", "rh-aguardando-curriculo");
    await send(talkId, leadId, MSG.trabalheConosco());
    return;
  }

  if (op === "2") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "rh_aguardando_info", ultimo_topico: "RH - Experiência" }, { persist: true });
    await send(talkId, leadId, MSG.trabalheConoscoExperiencia());
    return;
  }

  if (op === "3") {
    SM.resetInvalidCount(leadId);
    await transferToHuman(leadId, { ...state, ultimo_topico: "Trabalhe Conosco - Atendimento" }, talkId, "Trabalhe Conosco - falar com atendimento");
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) return transferToHuman(leadId, state, talkId, "2 respostas inválidas em trabalhe conosco");
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.trabalheConoscoMenu());
}

async function handleRhExperiencia(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  await applyFlowLabel(leadId, loja.prefix, "rh", "rh-em-analise");
  await transferToHuman(
    leadId,
    { ...state, ultimo_topico: `RH - Experiência: ${clean(text).slice(0, 100)}` },
    talkId,
    "Trabalhe Conosco - experiência informada"
  );
}

async function handlePosVendaMenu(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  const op = parseOption(text);

  if (!op) {
    await send(talkId, leadId, MSG.posVendaMenu());
    return;
  }

  const options = {
    "1": { label: "pv-garantia",       topic: "Garantia" },
    "2": { label: "pv-ajuste-armacao", topic: "Ajuste de Armação" },
    "3": { label: "pv-problema-lente", topic: "Problema com Lente" },
    "4": { label: "pv-especialista",   topic: "Atendimento" },
  };

  if (options[op]) {
    SM.resetInvalidCount(leadId);
    const selected = options[op];
    await applyFlowLabel(leadId, loja.prefix, "pv", selected.label);
    await transferToHuman(leadId, { ...state, ultimo_topico: `Pós Venda - ${selected.topic}` }, talkId, `Pós Venda - ${selected.topic}`);
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) return transferToHuman(leadId, state, talkId, "2 respostas inválidas em pós-venda");
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.posVendaMenu());
}

async function handleLembreteResposta(leadId, state, text, talkId) {
  if (normalize(text) === "reagendar") {
    SM.setState(leadId, {
      etapa: "reagendamento_data",
      reagendamento: { data: null, horario: null },
    }, { persist: true });
    return;
  }

  // Compatibilidade com conversas em que o clique em Reagendar nao gerou
  // evento separado, mas a resposta de data chegou ao webhook.
  if (/^\d{1,2}\/\d{1,2}(?:\/\d{4})?$/.test(clean(text))) {
    return handleReagendamentoData(leadId, state, text);
  }

  if (isYes(text)) {
    SM.setState(leadId, { etapa: "menu_principal" }, { persist: true });
    await send(talkId, leadId, MSG.lembreteConfirmado());
    return;
  }
  if (isNo(text)) {
    const cancellation = await scheduling.cancelarAgendamentoPorLead({ leadId });
    SM.setState(leadId, { etapa: "transferido", bot_active: false }, { persist: true });
    await send(talkId, leadId, MSG.lembreteCancelado());
    const loja = lojaByPrefix(state.loja_prefix);
    await kommo.addNote(leadId,
      cancellation?.ok
        ? "❌ Cliente cancelou o agendamento pelo bot. Status atualizado no sistema."
        : `⚠️ Cliente pediu cancelamento, mas o sistema não encontrou agendamento ativo: ${cancellation?.error || "erro desconhecido"}`
    );
    await labels.setHumanControl(leadId);
    await moveStage(leadId, "recuperacao", loja.prefix);
    return;
  }
  // Resposta não reconhecida — repete a pergunta
  await send(talkId, leadId, `Não entendi. Por favor, responda *SIM* para confirmar ou *NÃO* para cancelar.`);
}

async function handleReagendamentoData(leadId, state, text) {
  const value = clean(text);
  if (!/^\d{1,2}\/\d{1,2}(?:\/\d{4})?$/.test(value)) {
    await kommo.addNote(leadId, `⚠️ Data de reagendamento inválida recebida: ${value}`);
    return;
  }
  SM.setState(leadId, {
    etapa: "reagendamento_horario",
    reagendamento: { ...(state.reagendamento || {}), data: value, horario: null },
  }, { persist: true });
}

async function handleReagendamentoHorario(leadId, state, text) {
  const raw = clean(text);
  const match = raw.match(/^(\d{1,2})(?::|h)(\d{2})?$|^(\d{1,2})$/i);
  if (!match) {
    await kommo.addNote(leadId, `⚠️ Horário de reagendamento inválido recebido: ${raw}`);
    SM.setState(leadId, { etapa: "transferido", bot_active: false }, { persist: true });
    await labels.setHumanControl(leadId).catch(() => {});
    return;
  }

  const hour = Number(match[1] || match[3]);
  const minute = Number(match[2] || 0);
  const horario = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const data = state.reagendamento?.data;
  const result = await scheduling.reagendarAgendamentoPorLead({ leadId, data, horario });
  const detailsFieldId = Number(process.env.KOMMO_APPOINTMENT_DETAILS_FIELD_ID || 773261);

  if (result?.ok) {
    const details = `Reagendamento confirmado | Data: ${result.data_agendamento} | Horário: ${result.horario} | Loja: ${result.loja}`;
    await kommo.updateLead(leadId, {
      custom_fields_values: [{ field_id: detailsFieldId, values: [{ value: details }] }],
    }).catch(() => {});
    await kommo.addNote(leadId,
      `✅ Reagendamento confirmado no sistema\n📅 ${result.data_agendamento} às ${result.horario}\n🏪 ${result.loja}\n👁 ${result.optometrista || "A definir"}`
    );
    SM.setState(leadId, {
      etapa: "menu_principal",
      reagendamento: { data, horario, confirmado: true },
    }, { persist: true });
    return;
  }

  const error = result?.error || "Não foi possível confirmar automaticamente.";
  await kommo.updateLead(leadId, {
    custom_fields_values: [{ field_id: detailsFieldId, values: [{ value: `Reagendamento pendente | ${error}` }] }],
  }).catch(() => {});
  await kommo.addNote(leadId, `⚠️ Reagendamento requer atendimento humano\nData: ${data}\nHorário: ${horario}\nMotivo: ${error}`);
  SM.setState(leadId, {
    etapa: "transferido",
    bot_active: false,
    reagendamento: { data, horario, confirmado: false, erro: error },
  }, { persist: true });
  await labels.setHumanControl(leadId).catch(() => {});
}

async function handleRecuperacaoMenu(leadId, state, text, talkId) {
  const loja = lojaByPrefix(state.loja_prefix);
  const op = parseOption(text);

  if (!op) {
    await send(talkId, leadId, MSG.recuperacao(state.nome));
    return;
  }

  if (op === "1") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "tv_aguardando_confirm", ultimo_topico: "Teste de Visão" }, { persist: true });
    await applyFlowLabel(leadId, loja.prefix, "tv", "tv-aguardando-confirm");
    await moveStage(leadId, "agendamento", loja.prefix);
    await send(talkId, leadId, MSG.testeVisao(loja));
    return;
  }

  if (op === "2") {
    SM.resetInvalidCount(leadId);
    SM.setState(leadId, { etapa: "orcamento_menu", ultimo_topico: "Orçamento" }, { persist: true });
    await moveStage(leadId, "orcamento", loja.prefix);
    await send(talkId, leadId, MSG.orcamentoMenu());
    return;
  }

  if (op === "3") {
    SM.resetInvalidCount(leadId);
    await transferToHuman(leadId, state, talkId, "Recuperação — solicitou especialista");
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) return transferToHuman(leadId, state, talkId, "2 respostas inválidas na recuperação");
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.recuperacao(state.nome));
}

async function route(leadId, state, text, talkId, context) {
  if (state.etapa === "boas_vindas") return handleBoasVindas(leadId, state, talkId, context);
  if (state.etapa === "menu_principal") return handleMenuPrincipal(leadId, state, text, talkId);
  if (state.etapa === "recuperacao_menu") return handleRecuperacaoMenu(leadId, state, text, talkId);
  if (state.etapa === "info_menu") return handleInfoMenu(leadId, state, text, talkId);
  if (state.etapa === "info_aguarda_sim_nao") return handleInfoSimNao(leadId, state, text, talkId);
  if (state.etapa === "tv_aguardando_confirm") return handleTesteVisao(leadId, state, text, talkId);
  if (state.etapa === "orcamento_menu") return handleOrcamentoMenu(leadId, state, text, talkId);
  if (state.etapa === "orcamento_aguardando_receita") return handleOrcamentoReceita(leadId, state, text, talkId);
  if (state.etapa === "orcamento_lente") return handleOrcamentoLente(leadId, state, text, talkId);
  if (state.etapa === "rh_menu") return handleRhMenu(leadId, state, text, talkId);
  if (state.etapa === "rh_aguardando_curriculo") return handleRhCurriculo(leadId, state, text, talkId);
  if (state.etapa === "rh_aguardando_info") return handleRhExperiencia(leadId, state, text, talkId);
  if (state.etapa === "pv_menu") return handlePosVendaMenu(leadId, state, text, talkId);
  if (state.etapa === "lembrete_resposta") return handleLembreteResposta(leadId, state, text, talkId);
  if (state.etapa === "reagendamento_data") return handleReagendamentoData(leadId, state, text);
  if (state.etapa === "reagendamento_horario") return handleReagendamentoHorario(leadId, state, text);
  if (state.etapa === "transferido") return;

  SM.setState(leadId, { etapa: "menu_principal" }, { persist: true });
  await send(talkId, leadId, MSG.menuPrincipal(lojaByPrefix(state.loja_prefix)));
}

async function _processMessage({ leadId, talkId, chatId, text, authorType, loja, pipeline_id, pipelineId, contact_name }) {
  if (process.env.BOT_ENABLED === "false") return;
  if (authorType === "user" || authorType === "bot") return;

  SM.markClientActivity(leadId);
  const state = await SM.getState(leadId);

  if (talkId && !state.talk_id) {
    SM.setState(leadId, { talk_id: talkId }, { persist: true });
    state.talk_id = talkId;
  }
  if (chatId && !state.chat_id) {
    SM.setState(leadId, { chat_id: chatId }, { persist: true });
    state.chat_id = chatId;
  }

  await ensureStoreState(leadId, state, { loja, pipeline_id, pipelineId });

  // Reativação pelo Salesbot: o add_talk e o Salesbot chegam quasi-simultâneos.
  // Se o Salesbot chegar antes do add_talk processar, o estado ainda é "transferido".
  // Neste caso reativamos aqui mesmo, sem depender da ordem dos eventos do Kommo.
  if (state.etapa === "transferido" && state.transferred_at) {
    const elapsed = Date.now() - state.transferred_at;
    if (elapsed >= 60 * 1000) {
      console.log(`[BOT][${leadId}] ♻️ Cliente voltou após ${Math.round(elapsed / 1000)}s — reativando pelo Salesbot`);
      SM.setState(leadId, { etapa: "boas_vindas", bot_active: false, transferred_at: null, last_human_at: null }, { persist: true });
      state.etapa = "boas_vindas";
      state.bot_active = false;
    }
  }

  // Bot bloqueado em atendimento humano — só reativa via nova conversa (add_talk ou Salesbot acima)
  if (!SM.shouldBotActivate(state)) return;

  if (!state.bot_active) {
    SM.setState(leadId, { bot_active: true });
    await labels.setBotControl(leadId).catch(() => {});
  }

  await route(leadId, state, clean(text), state.talk_id || talkId, { loja, pipeline_id, pipelineId, contact_name });
}

function processMessage(params) {
  return enqueueForLead(params.leadId, () => _processMessage(params));
}

async function processNewLead(leadId, context = {}) {
  if (process.env.BOT_ENABLED === "false") return;
  const state = await SM.getState(leadId);

  if (state.etapa === "transferido") {
    // Grace period: Kommo dispara add_talk automaticamente logo após o bot transferir
    // (quando o Salesbot fecha o fluxo e abre para o atendente). Ignoramos esse evento
    // por 60s para evitar que o bot reative durante o handoff. Após o período, um
    // novo add_talk legítimo (cliente voltou a contatar) reativa o bot normalmente.
    const elapsed = Date.now() - (state.transferred_at || 0);
    if (elapsed < 60 * 1000) {
      console.log(`[BOT][${leadId}] add_talk durante handoff (${Math.round(elapsed / 1000)}s após transferência) — ignorando`);
      return;
    }

    console.log(`[BOT][${leadId}] 📱 Nova conversa — reativando bot após atendimento humano`);
    SM.setState(leadId, { etapa: "boas_vindas", bot_active: false, last_human_at: null, transferred_at: null }, { persist: true });
    state.etapa = "boas_vindas";
    state.bot_active = false;

    // Em modo Salesbot: não envia boas-vindas aqui (a fila seria descartada pelo /api/salesbot).
    // O estado boas_vindas fica aguardando a primeira mensagem do cliente, que chega pelo
    // /api/salesbot com contact_name — aí handleBoasVindas é chamado com o nome correto.
    if (process.env.KOMMO_USE_SALESBOT !== "true") {
      await handleBoasVindas(leadId, state, context.talkId || null, context);
    }
    return;
  }

  // Se o bot já está ativo ou a conversa já avançou, não faz nada
  if (state.etapa !== "boas_vindas" || state.bot_active) {
    console.log(`[BOT][${leadId}] Novo lead/talk — já processado (etapa: ${state.etapa})`);
    return;
  }

  // Em modo Salesbot: mantém estado boas_vindas. O primeiro /api/salesbot recebe
  // contact_name no payload e chama handleBoasVindas com o nome correto do lead.
  // Em modo direto: envia boas-vindas imediatamente.
  if (process.env.KOMMO_USE_SALESBOT !== "true") {
    console.log(`[BOT][${leadId}] 📱 Novo lead — enviando boas-vindas imediatamente`);
    await handleBoasVindas(leadId, state, context.talkId || null, context);
  } else {
    console.log(`[BOT][${leadId}] 📱 Novo lead — aguardando primeira mensagem do cliente via Salesbot`);
  }
}

module.exports = { processMessage, processNewLead, flushResponses };
