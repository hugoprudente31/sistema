// Bot Flow Engine — Sistema Óticas Target
// Motor de estado do bot. Cada etapa do funil tem um handler.

const kommo      = require("../client");
const MSG        = require("./messages");
const SM         = require("./stateManager");
const labels     = require("../labels");
const scheduling = require("../scheduling");

// Nomes das lojas disponíveis (usado no menu de escolha)
const LOJAS = MSG.LOJAS_INFO.map(l => l.nome);

// ── Utilitários ──────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Envia uma mensagem com pequeno delay (evita spam/bloqueio)
async function send(talkId, leadId, text) {
  await sleep(800);
  try {
    if (talkId) {
      await kommo.sendMessage(talkId, text);
    } else {
      await kommo.sendMessageToLead(leadId, text);
    }
    const preview = text.slice(0, 70).replace(/\n/g, " ");
    console.log(`[BOT][${leadId}] → "${preview}${text.length > 70 ? "…" : ""}"`);
  } catch (e) {
    console.error(`[BOT][${leadId}] Erro ao enviar:`, e.message);
  }
}

// Move o lead de estágio (só se a var de ambiente estiver configurada)
async function moveStage(leadId, envKey) {
  const stageId = process.env[envKey];
  if (!stageId) return;
  await kommo.moveToStage(leadId, stageId).catch(e =>
    console.error(`[BOT][${leadId}] Erro ao mover estágio (${envKey}):`, e.message)
  );
}

// Normaliza opções numéricas ("1", "1.", "1 ", " 2 " → "1", "2")
function parseOption(text) {
  const m = (text || "").trim().match(/^(\d+)/);
  return m ? m[1] : null;
}

// Valida data no formato DD/MM/AAAA
function isValidDate(str) {
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return false;
  const [, d, mo, y] = m;
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() == y && date.getMonth() == mo - 1 && date.getDate() == d;
}

function isPastDate(str) {
  const [d, mo, y] = str.split("/");
  const date  = new Date(y, mo - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return date < today;
}

// ── Transferência para humano ────────────────────────────────────

async function transferToHuman(leadId, state, talkId, motivo = "solicitação do cliente") {
  console.log(`[BOT][${leadId}] 👤 Transferindo para humano — ${motivo}`);

  await send(talkId, leadId, MSG.transferindoParaHumano());

  // Nota interna para o atendente
  await kommo.addNote(leadId, MSG.notaParaAtendente(state));

  // Etiquetas
  await labels.setHumanControl(leadId);
  await labels.applyLabel(leadId, labels.LABELS.ATENDIMENTO_HUMANO);

  // Move de estágio
  await moveStage(leadId, "KOMMO_STAGE_ATENDENTE");

  // Atribui responsável padrão
  const responsibleId = process.env.KOMMO_DEFAULT_RESPONSIBLE_ID;
  if (responsibleId) {
    await kommo.updateLead(leadId, { responsible_user_id: Number(responsibleId) }).catch(() => {});
  }

  SM.setState(leadId, { etapa: "transferido", bot_active: false }, { persist: true });
}

// ── Handler: já transferido ──────────────────────────────────────

async function handleTransferido(leadId, state, text, talkId) {
  // Se bot deve retomar (humano sumiu por 15 min), volta ao menu
  if (SM.shouldBotResume(state)) {
    console.log(`[BOT][${leadId}] 🔄 Humano inativo há 15min — retomando`);
    await labels.setBotControl(leadId);
    SM.setState(leadId, { etapa: "menu_principal", bot_active: true }, { persist: true });
    await send(talkId, leadId, MSG.menuPrincipal());
  }
  // Senão, humano está no controle — não responde
}

// ── Handler: boas-vindas ─────────────────────────────────────────

async function handleBoasVindas(leadId, state, talkId) {
  // Tenta buscar nome do lead se não tiver
  let nome = state.nome;
  if (!nome) {
    try {
      const lead = await kommo.getLead(leadId);
      nome = lead?._embedded?.contacts?.[0]?.name || lead?.name || null;
    } catch { /* ignora */ }
  }

  SM.setState(leadId, { nome, etapa: "menu_principal", bot_active: true }, { persist: true });
  await labels.setBotControl(leadId);
  await moveStage(leadId, "KOMMO_STAGE_BOT_ATIVO");

  await send(talkId, leadId, MSG.boasVindas(nome));
}

// ── Handler: menu principal ──────────────────────────────────────

async function handleMenuPrincipal(leadId, state, text, talkId) {
  const op = parseOption(text);

  if (op === "1") {
    SM.setState(leadId, { etapa: "info_menu" }, { persist: true });
    await labels.applyLabel(leadId, labels.LABELS.INFORMACOES_SOLICITADAS);
    await moveStage(leadId, "KOMMO_STAGE_INFORMACOES");
    await send(talkId, leadId, MSG.infoMenu());
    return;
  }

  if (op === "2") {
    SM.setState(leadId, { etapa: "agendamento_tipo" }, { persist: true });
    await labels.applyLabel(leadId, labels.LABELS.AGENDAMENTO_SOLICITADO);
    await moveStage(leadId, "KOMMO_STAGE_AGENDAMENTO");
    await send(talkId, leadId, MSG.agendamentoTipo());
    return;
  }

  if (op === "3") {
    SM.setState(leadId, { etapa: "orcamento_menu" }, { persist: true });
    await labels.applyLabel(leadId, labels.LABELS.ORCAMENTO_SOLICITADO);
    await moveStage(leadId, "KOMMO_STAGE_ORCAMENTO");
    await send(talkId, leadId, MSG.orcamentoMenu());
    return;
  }

  if (op === "4") {
    await transferToHuman(leadId, state, talkId, "Opção 4 — cliente pediu atendente");
    return;
  }

  // Resposta inválida
  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) {
    await transferToHuman(leadId, state, talkId, "2 respostas inválidas no menu principal");
    return;
  }
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.menuPrincipal());
}

// ── Handler: menu de informações ─────────────────────────────────

async function handleInfoMenu(leadId, state, text, talkId) {
  const op = parseOption(text);
  SM.resetInvalidCount(leadId);

  const subEtapas = {
    "1": "info_endereco",
    "2": "info_garantia",
    "3": "info_oculos_sol",
    "4": "info_lentes",
    "5": "info_oculos_rapido",
    "6": "info_promocoes",
    "7": null, // transfere
  };

  if (op && subEtapas.hasOwnProperty(op)) {
    if (op === "7") {
      await transferToHuman(leadId, state, talkId, "Opção 7 no menu de informações");
      return;
    }
    const novaEtapa = subEtapas[op];
    SM.setState(leadId, { etapa: novaEtapa });

    const msgs = {
      info_endereco:     MSG.infoEndereco(),
      info_garantia:     MSG.infoGarantia(),
      info_oculos_sol:   MSG.infoOculosSol(),
      info_lentes:       MSG.infoLentes(),
      info_oculos_rapido: MSG.infoOculosRapido(),
      info_promocoes:    MSG.infoPromocoes(),
    };
    await send(talkId, leadId, msgs[novaEtapa]);
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) {
    await transferToHuman(leadId, state, talkId, "2 respostas inválidas no menu de informações");
    return;
  }
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.infoMenu());
}

// ── Handler: sub-menus de informação ─────────────────────────────

async function handleInfoSub(leadId, state, text, talkId) {
  const op = parseOption(text);
  SM.resetInvalidCount(leadId);

  // Opção "agendar visita" em oculos sol / lentes / rápido
  if (op === "1" && ["info_oculos_sol", "info_oculos_rapido"].includes(state.etapa)) {
    SM.setState(leadId, { etapa: "agendamento_tipo" }, { persist: true });
    await labels.applyLabel(leadId, labels.LABELS.AGENDAMENTO_SOLICITADO);
    await send(talkId, leadId, MSG.agendamentoTipo());
    return;
  }

  if (op === "1" && state.etapa === "info_lentes") {
    SM.setState(leadId, { etapa: "orcamento_menu" }, { persist: true });
    await send(talkId, leadId, MSG.orcamentoMenu());
    return;
  }

  if (op === "2" && state.etapa === "info_lentes") {
    SM.setState(leadId, { etapa: "agendamento_tipo" }, { persist: true });
    await send(talkId, leadId, MSG.agendamentoTipo());
    return;
  }

  if (op === "1" && state.etapa === "info_promocoes") {
    await transferToHuman(leadId, state, talkId, "Cliente pediu promoções com atendente");
    return;
  }

  // "Voltar ao menu" — última opção em todos os sub-menus
  const ultimaOpcao = { info_garantia: "2", info_oculos_sol: "3", info_lentes: "4", info_oculos_rapido: "3", info_promocoes: "2", info_endereco: "2" };
  if (op === ultimaOpcao[state.etapa]) {
    await transferToHuman(leadId, state, talkId, "Cliente pediu atendente no sub-menu de info");
    return;
  }

  // Qualquer outra opção = voltar ao menu principal
  SM.setState(leadId, { etapa: "menu_principal" });
  await send(talkId, leadId, MSG.menuPrincipal());
}

// ── Handler: escolha do tipo de agendamento ──────────────────────

async function handleAgendamentoTipo(leadId, state, text, talkId) {
  const op = parseOption(text);
  SM.resetInvalidCount(leadId);

  if (op === "1") {
    SM.setState(leadId, { etapa: "agendamento_loja" }, { persist: true });
    await send(talkId, leadId, MSG.agendamentoEscolhaLoja(LOJAS));
    return;
  }

  if (op === "2") {
    SM.setState(leadId, { etapa: "agendamento_grupo" }, { persist: true });
    await send(talkId, leadId, MSG.agendamentoGrupo());
    await transferToHuman(leadId, state, talkId, "Agendamento em grupo — precisa de atendente");
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) {
    await transferToHuman(leadId, state, talkId, "2 respostas inválidas na escolha do tipo");
    return;
  }
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.agendamentoTipo());
}

// ── Handler: escolha da loja ─────────────────────────────────────

async function handleAgendamentoLoja(leadId, state, text, talkId) {
  const op  = parseOption(text);
  const idx = op ? parseInt(op) - 1 : -1;
  SM.resetInvalidCount(leadId);

  if (idx >= 0 && idx < LOJAS.length) {
    const loja = LOJAS[idx];
    SM.setState(leadId, {
      etapa: "agendamento_data",
      loja,
      dados_agendamento: { ...state.dados_agendamento, loja },
    }, { persist: true });
    await send(talkId, leadId, MSG.agendamentoEscolhaData(loja));
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) {
    await transferToHuman(leadId, state, talkId, "2 respostas inválidas na escolha da loja");
    return;
  }
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.agendamentoEscolhaLoja(LOJAS));
}

// ── Handler: escolha da data ─────────────────────────────────────

async function handleAgendamentoData(leadId, state, text, talkId) {
  SM.resetInvalidCount(leadId);
  const input = text.trim();

  if (!isValidDate(input)) {
    await send(talkId, leadId, MSG.agendamentoDataInvalida());
    return;
  }

  if (isPastDate(input)) {
    await send(talkId, leadId, MSG.agendamentoDataPassada());
    return;
  }

  const loja = state.dados_agendamento?.loja || state.loja;

  // Consulta horários disponíveis no GAS em tempo real
  const horarios = await scheduling.getHorariosDisponiveis(loja, input);

  if (!horarios.length) {
    SM.setState(leadId, { dados_agendamento: { ...state.dados_agendamento, data: input } });
    await send(talkId, leadId, MSG.agendamentoSemVagas(input));
    return;
  }

  SM.setState(leadId, {
    etapa: "agendamento_horario",
    dados_agendamento: { ...state.dados_agendamento, data: input, horarios_disponiveis: horarios },
  }, { persist: true });

  await send(talkId, leadId, MSG.agendamentoEscolhaHorario(loja, input, horarios));
}

// ── Handler: escolha do horário ──────────────────────────────────

async function handleAgendamentoHorario(leadId, state, text, talkId) {
  const op      = parseOption(text);
  const horarios = state.dados_agendamento?.horarios_disponiveis || HORARIOS_PADRAO;
  const idx     = op ? parseInt(op) - 1 : -1;
  SM.resetInvalidCount(leadId);

  if (idx >= 0 && idx < horarios.length) {
    const horario = horarios[idx];
    const { loja, data } = state.dados_agendamento;

    SM.setState(leadId, {
      etapa: "agendamento_confirmar",
      dados_agendamento: { ...state.dados_agendamento, horario },
    }, { persist: true });

    await send(talkId, leadId, MSG.agendamentoConfirmar(state.nome, loja, data, horario));
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) {
    await transferToHuman(leadId, state, talkId, "2 respostas inválidas na escolha do horário");
    return;
  }
  await send(talkId, leadId, MSG.respostaInvalida());
  const { loja, data } = state.dados_agendamento;
  await send(talkId, leadId, MSG.agendamentoEscolhaHorario(loja, data, horarios));
}

// ── Handler: confirmação do agendamento ──────────────────────────

async function handleAgendamentoConfirmar(leadId, state, text, talkId) {
  const input = text.trim().toUpperCase();
  SM.resetInvalidCount(leadId);

  const confirmou = ["SIM", "S", "1", "OK", "CONFIRMAR", "CONFIRMO"].includes(input);
  const negou     = ["NÃO", "NAO", "N", "2", "NOPE", "CANCELAR"].includes(input);

  if (confirmou) {
    const { loja, data, horario } = state.dados_agendamento;

    // Busca contato para pegar WhatsApp
    const contato = await scheduling.getContatoDoLead(kommo, leadId);

    // Cria o agendamento no GAS
    const gasResult = await scheduling.criarAgendamento({
      nome:     state.nome || contato.nome,
      whatsapp: contato.whatsapp,
      email:    contato.email,
      loja,
      data,
      horario,
      leadId,
    });
    const gasOk = gasResult?.ok;

    if (gasOk) {
      SM.setState(leadId, { etapa: "agendado" }, { persist: true });
      await labels.applyTrafficLight(leadId, "Agendado");
      await moveStage(leadId, "KOMMO_STAGE_AGENDADO");
      await kommo.addNote(leadId, `📅 Agendamento criado via bot\n${data} às ${horario}\n🏪 ${loja}`);
      await send(talkId, leadId, MSG.agendamentoConfirmado(data, horario, loja));
    } else {
      await send(talkId, leadId, "⚠️ Ocorreu um erro ao criar o agendamento. Um atendente irá te ajudar!");
      await transferToHuman(leadId, state, talkId, "Erro ao criar agendamento no GAS");
    }
    return;
  }

  if (negou) {
    // Volta para escolha de data
    SM.setState(leadId, {
      etapa: "agendamento_data",
      dados_agendamento: { ...state.dados_agendamento, data: null, horario: null, horarios_disponiveis: null },
    }, { persist: true });
    await send(talkId, leadId, `Tudo bem! Vamos escolher outra data. 😊\n\n` + MSG.agendamentoEscolhaData(state.dados_agendamento?.loja));
    return;
  }

  await send(talkId, leadId, `Por favor, responda *SIM* para confirmar ou *NÃO* para escolher outra data.`);
}

// ── Handler: orçamento — menu ─────────────────────────────────────

async function handleOrcamentoMenu(leadId, state, text, talkId) {
  const op = parseOption(text);
  SM.resetInvalidCount(leadId);

  if (op === "1") {
    SM.setState(leadId, { etapa: "orcamento_passagem" }, { persist: true });
    await send(talkId, leadId, MSG.orcamentoPassagem());
    return;
  }
  if (op === "2") {
    SM.setState(leadId, { etapa: "orcamento_conjunto" }, { persist: true });
    await send(talkId, leadId, MSG.orcamentoConjunto());
    return;
  }
  if (op === "3") {
    SM.setState(leadId, { etapa: "orcamento_cobertura" }, { persist: true });
    await labels.applyLabel(leadId, labels.LABELS.LEAD_QUENTE);
    await send(talkId, leadId, MSG.orcamentoCobertura());
    return;
  }

  const count = SM.incrementInvalidCount(leadId);
  if (count >= 2) {
    await transferToHuman(leadId, state, talkId, "2 respostas inválidas no menu de orçamento");
    return;
  }
  await send(talkId, leadId, MSG.respostaInvalida());
  await send(talkId, leadId, MSG.orcamentoMenu());
}

// ── Handlers: sub-menus de orçamento → transferem para humano ────

async function handleOrcamentoSub(leadId, state, text, talkId) {
  // Após o cliente responder qualquer coisa nos sub-menus de orçamento,
  // transfere para atendente com o contexto coletado
  SM.setState(leadId, {
    dados_agendamento: { ...state.dados_agendamento, orcamento_resposta: text },
  });
  await labels.applyLabel(leadId, labels.LABELS.ORCAMENTO_SOLICITADO);
  await moveStage(leadId, "KOMMO_STAGE_ORCAMENTO_ENVIADO");
  await transferToHuman(leadId, state, talkId, `Orçamento sub-etapa: ${state.etapa}`);
}

// ── Handler: resposta ao lembrete de 24h ─────────────────────────

async function handleLembreteResposta(leadId, state, text, talkId) {
  const input = text.trim().toUpperCase();

  const confirmou = ["SIM", "S", "1", "OK"].includes(input);
  const negou     = ["NÃO", "NAO", "N", "2"].includes(input);

  if (confirmou) {
    SM.setState(leadId, { etapa: "agendado" }, { persist: true });
    await labels.applyTrafficLight(leadId, "Confirmado");
    await send(talkId, leadId, MSG.lembreteConfirmado());
    return;
  }

  if (negou) {
    await send(talkId, leadId, MSG.lembreteCancelado());
    SM.setState(leadId, { etapa: "lembrete_cancelar" }, { persist: true });
    return;
  }
}

async function handleLembreteCancelar(leadId, state, text, talkId) {
  const op = parseOption(text);
  if (op === "1") {
    // Remarcar — volta ao fluxo de agendamento
    SM.setState(leadId, {
      etapa: "agendamento_tipo",
      dados_agendamento: { loja: null, data: null, horario: null },
    }, { persist: true });
    await labels.applyTrafficLight(leadId, "Cancelado");
    await send(talkId, leadId, MSG.agendamentoTipo());
  } else {
    // Cancela de vez
    SM.setState(leadId, { etapa: "transferido" }, { persist: true });
    await labels.applyTrafficLight(leadId, "Cancelado");
    await transferToHuman(leadId, state, talkId, "Cliente cancelou agendamento pelo lembrete");
  }
}

// ── Roteador principal ───────────────────────────────────────────

async function route(leadId, state, text, talkId) {
  const { etapa } = state;

  if (etapa === "boas_vindas")            return handleBoasVindas(leadId, state, talkId);
  if (etapa === "menu_principal")         return handleMenuPrincipal(leadId, state, text, talkId);
  if (etapa === "info_menu")              return handleInfoMenu(leadId, state, text, talkId);

  const infoSubs = ["info_endereco","info_garantia","info_oculos_sol","info_lentes","info_oculos_rapido","info_promocoes"];
  if (infoSubs.includes(etapa))           return handleInfoSub(leadId, state, text, talkId);

  if (etapa === "agendamento_tipo")       return handleAgendamentoTipo(leadId, state, text, talkId);
  if (etapa === "agendamento_loja")       return handleAgendamentoLoja(leadId, state, text, talkId);
  if (etapa === "agendamento_data")       return handleAgendamentoData(leadId, state, text, talkId);
  if (etapa === "agendamento_horario")    return handleAgendamentoHorario(leadId, state, text, talkId);
  if (etapa === "agendamento_confirmar")  return handleAgendamentoConfirmar(leadId, state, text, talkId);
  if (etapa === "orcamento_menu")         return handleOrcamentoMenu(leadId, state, text, talkId);

  const orcamentoSubs = ["orcamento_passagem","orcamento_conjunto","orcamento_cobertura"];
  if (orcamentoSubs.includes(etapa))      return handleOrcamentoSub(leadId, state, text, talkId);

  if (etapa === "lembrete_resposta")      return handleLembreteResposta(leadId, state, text, talkId);
  if (etapa === "lembrete_cancelar")      return handleLembreteCancelar(leadId, state, text, talkId);
  if (etapa === "transferido")            return handleTransferido(leadId, state, text, talkId);

  // Estado desconhecido — reset para menu
  console.log(`[BOT][${leadId}] ⚠️ Etapa desconhecida "${etapa}" — resetando para menu_principal`);
  SM.setState(leadId, { etapa: "menu_principal" }, { persist: true });
  await send(talkId, leadId, MSG.menuPrincipal());
}

// ── Entradas públicas ────────────────────────────────────────────

// Processa uma mensagem recebida no inbox
async function processMessage({ leadId, talkId, text, authorType }) {
  if (process.env.BOT_ENABLED === "false") return;

  const log = (msg) => console.log(`[BOT][${leadId}] ${msg}`);

  // Mensagem do atendente humano → registra atividade, bot recua
  if (authorType === "user") {
    SM.markHumanActivity(leadId);
    log("👤 Atendente respondeu — bot pausado");
    return;
  }

  // Mensagem do próprio bot → ignora para não criar loop
  if (authorType === "bot") return;

  // A partir daqui é mensagem do cliente
  SM.markClientActivity(leadId);
  const state = await SM.getState(leadId);

  // Garante que o talkId fica salvo no estado
  if (talkId && !state.talk_id) {
    SM.setState(leadId, { talk_id: talkId });
    state.talk_id = talkId;
  }
  const effectiveTalkId = state.talk_id || talkId;

  // Verifica regra de 5 minutos
  if (!SM.shouldBotActivate(state)) {
    log("👤 Humano ativo há menos de 5min — bot aguardando");
    return;
  }

  // Fora do horário comercial
  if (!SM.isDuringBusinessHours()) {
    await send(effectiveTalkId, leadId, MSG.foraDoHorario(state.nome));
    return;
  }

  // Marca bot como ativo e aplica etiqueta
  if (!state.bot_active) {
    SM.setState(leadId, { bot_active: true });
    await labels.setBotControl(leadId).catch(() => {});
  }

  log(`← "${(text || "").slice(0, 50)}" | etapa: ${state.etapa}`);
  await route(leadId, state, (text || "").trim(), effectiveTalkId);
}

// Inicializa o estado quando um novo lead entra no pipeline
async function processNewLead(leadId) {
  if (process.env.BOT_ENABLED === "false") return;

  const existing = await SM.getState(leadId);
  // Só inicializa se não tiver estado ainda
  if (existing.etapa !== "boas_vindas" || existing.bot_active) return;

  console.log(`[BOT][${leadId}] 🆕 Novo lead — estado inicializado`);
  // O bot envia boas-vindas quando a primeira mensagem do cliente chegar
}

module.exports = { processMessage, processNewLead };
