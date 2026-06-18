
//  CODE.GS CONSOLIDADO — SISTEMA DE AGENDAMENTO / OS MULTILOJA
//  Versão: 7.0.0-segura
//  Planilha: 1H3GrqJVc07L92sYvDvl0cuGWUjIiyMAFnmZmhDj7zWc
// ═══════════════════════════════════════════════════════════════

const SPREADSHEET_ID = '1H3GrqJVc07L92sYvDvl0cuGWUjIiyMAFnmZmhDj7zWc';
const PROJECT_NAME = 'Sistema de Agendamento';
const SERVER_VERSION = '7.2.0-consolidado-seguro';

const KOMMO = {
  account: 'oticastargetcontato',
  etapas: {
    agendado: 103341012,
    confirmado: 103321328,
    compareceu: 106142076,
    naoCompareceu: 106137696,
    concluido: 102222124,
    cancelado: 103410000
  },
  campos: {
    idGAS: 0,
    loja: 0,
    optometrista: 0,
    dataAgendamento: 0,
    horario: 0,
    origem: 0
  }
};

const KOMMO_MAPA_LOJAS = {
  'óticas Target - Ademar de Barros': {
    pipeline: 9511355,
    agendado: 103341012,
    confirmado: 103321328,
    compareceu: 106142076,
    naoCompareceu: 106137696,
    concluido: 102222124,
    cancelado: 103410000
  },
  'óticas TGT - Gonzaga': {
    pipeline: 9907903,
    agendado: 103341100,
    confirmado: 103321304,
    compareceu: 106142080,
    naoCompareceu: 106144224,
    concluido: 101499612,
    cancelado: 103409688
  },
  'óticas TGT Enseada': {
    pipeline: 12931092,
    agendado: 103341140,
    confirmado: 103321252,
    compareceu: 106142096,
    naoCompareceu: 102118860,
    concluido: 102118868,
    cancelado: 103410028
  },
  'óticas TGT Pitangueiras': {
    pipeline: 12931096,
    agendado: 103340708,
    confirmado: 103321296,
    compareceu: 106142144,
    naoCompareceu: 106137604,
    concluido: 102115468,
    cancelado: 103410084
  }
};

const SHEETS = {
  usuarios: 'usuarios',
  configuracoes: 'configuracoes',
  lojas: 'lojas',
  optometristas: 'optometristas',
  origens: 'origens',
  feriados: 'feriados',
  agendamentos: 'agendamentos',
  sincronizacao: 'sincronizacao',
  ordens_servico: 'ordens_servico',
  presencas: 'presencas',
  auditoria_eventos: 'auditoria_eventos'
};

const REQUIRED_HEADERS = {
  usuarios: ['IdUsuario', 'Email', 'Nome', 'Perfil', 'Loja', 'Ativo', 'AccessTags', 'CanViewFinance'],
  configuracoes: ['Chave', 'Valor', 'Descricao'],
  lojas: ['Loja', 'Cidade', 'Ativa'],
  optometristas: ['Optometrista', 'Loja', 'Ativo'],
  origens: ['Origem', 'Ativa'],
  feriados: ['Data', 'Descricao'],
  sincronizacao: ['Data', 'Tipo', 'Mensagem', 'Usuario'],
  agendamentos: [
    'ID', 'DataCadastro', 'Origem', 'NomeCompleto', 'WhatsApp', 'Email', 'Loja', 'Optometrista',
    'Responsavel', 'DataAgendamento', 'Horario', 'Observacao', 'StatusAgenda', 'Compareceu',
    'AtendimentoRealizado', 'VendaGerada', 'ValorVenda', 'Desconto', 'MotivoPerda',
    'ConsultorResponsavel', 'CriadoPorEmail', 'UltimaAtualizacao', 'ProprietarioId',
    'ProprietarioNome', 'NumeroOS', 'DataAberturaOS', 'DataEntradaOS', 'DataFinalizacaoOS',
    'DataEntregaOS', 'StatusOS', 'AccessTags', 'LeadTimeDias', 'VendedorNome', 'KommoLeadId'
  ],
  ordens_servico: [
    'IdOSInterno', 'NumeroOS', 'IdAgendamento', 'Cliente', 'Loja', 'ProprietarioId', 'ProprietarioNome',
    'VendedorId', 'VendedorNome', 'DataAberturaOS', 'DataEntradaOS', 'DataFinalizacaoOS', 'DataEntregaOS',
    'StatusOS', 'ObservacaoOS', 'ValorOS', 'Desconto', 'LeadTimeDias', 'CriadoPor', 'AtualizadoPor',
    'CreatedAt', 'UpdatedAt'
  ],
  presencas: ['IdPresenca', 'IdAgendamento', 'Cliente', 'DataAgendamento', 'StatusPresenca', 'MarcadoPorId', 'MarcadoPorNome', 'PerfilMarcador', 'DataMarcacao', 'Observacao'],
  auditoria_eventos: ['IdEvento', 'Entidade', 'IdEntidade', 'Acao', 'CampoAlterado', 'ValorAnterior', 'ValorNovo', 'ExecutadoPorId', 'ExecutadoPorNome', 'Perfil', 'DataEvento']
};

const SYSTEM_ACCESS_TAGS = [
  'origem:google', 'origem:instagram', 'origem:facebook', 'origem:indicacao',
  'origem:whatsapp', 'origem:trafego-pago', 'origem:organico', 'origem:site',
  'origem:campanha-familia', 'origem:retorno-cliente',
  'perfil:primeira-compra', 'perfil:cliente-recorrente', 'perfil:alto-ticket',
  'perfil:sensivel-preco', 'perfil:urgente', 'perfil:infantil', 'perfil:adulto',
  'perfil:idoso', 'perfil:familia', 'perfil:corporativo',
  'prioridade:alta', 'prioridade:media', 'prioridade:baixa', 'prioridade:encaixe',
  'prioridade:atendimento-rapido', 'fluxo:agendamento-confirmado', 'fluxo:precisa-retorno',
  'fluxo:nao-atendeu', 'fluxo:reagendar', 'fluxo:pendente-confirmacao', 'fluxo:os-aberta',
  'fluxo:os-em-andamento', 'fluxo:os-atrasada', 'fluxo:os-pronta', 'fluxo:os-entregue',
  'fluxo:os-pendente-laboratorio', 'fluxo:os-pendente-cliente', 'fluxo:aguardando-aprovacao',
  'fluxo:aguardando-retirada', 'comercial:potencial-venda', 'comercial:venda-fechada',
  'comercial:perda-preco', 'comercial:perda-prazo', 'comercial:perda-sem-retorno',
  'comercial:upsell', 'comercial:cross-sell', 'comercial:garantia', 'comercial:pos-venda',
  'loja:gonzaga', 'loja:target', 'loja:pitangueiras', 'loja:enseada',
  'operacao:laboratorio', 'operacao:central', 'operacao:optometria'
];

const KOMMO_DEFAULTS = {
  accessToken: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiIsImp0aSI6ImE0YmYxMTA2MDk0Y2E2ZTg4MWMwZjg3MDdhODNhOWMwZjc4MGUxMGM0OTBiOGQ1MzEwNzcyZmUzZmJlMDRkMGUwZmVlZGUxZmE1YzE3ZTYzIn0.eyJhdWQiOiI1OWRhNzQ5Ni03NDkzLTQ5M2UtYjI4NC00MDYwN2Q4NzNlN2UiLCJqdGkiOiJhNGJmMTEwNjA5NGNhNmU4ODFjMGY4NzA3YTgzYTljMGY3ODBlMTBjNDkwYjhkNTMxMDc3MmZlM2ZiZTA0ZDBlMGZlZWRlMWZhNWMxN2U2MyIsImlhdCI6MTc3OTIxMzk2NywibmJmIjoxNzc5MjEzOTY3LCJleHAiOjE4NDMzNDQwMDAsInN1YiI6IjExODkxMjU5IiwiZ3JhbnRfdHlwZSI6IiIsImFjY291bnRfaWQiOjMzNDM3Nzc1LCJiYXNlX2RvbWFpbiI6ImtvbW1vLmNvbSIsInZlcnNpb24iOjIsInNjb3BlcyI6WyJwdXNoX25vdGlmaWNhdGlvbnMiLCJmaWxlcyIsImNybSIsImZpbGVzX2RlbGV0ZSIsIm5vdGlmaWNhdGlvbnMiXSwiaGFzaF91dWlkIjoiNjkxYjFkMGEtNDFlYS00N2U2LWExZTQtNzc0YmJhMGUwYjU2IiwiYXBpX2RvbWFpbiI6ImFwaS1nLmtvbW1vLmNvbSJ9.iCZrv-6oItXmVIZ7ZHlCu9bANVyWjiY_cLFEls65M04yEgB96w7aihwkoc6h4l8996rjOejkB-y5eRxhlflGHY-1UNly4TBvdY2GH3ITdfbPAJkvHSt4736GPT4Up9W846zLLruhUSW89mK0MSW6Ig7_786zhuvh_F1CLJZRAy9Xk8RQeMLQ0ZzJ5UEdIHbOd96Dp5_Qa4ZZZ19fZlbXo1IFITzhaHdHD3t5JDDvl3RJAGO2QpBHAsQODVOXJ3GQMo3gypJjQMOQjH1xk8kJLVOZvkaQcRS8uB8crBVAcoeyrzj85En-IV9sE7bzIgmIKFzhxXPW_0HpbWbQDMqWuQ',
  clientId: '59da7496-7493-493e-b284-40607d873e7e',
  clientSecret: '2twz7AVfekK5WGhfrgYvRX8vGoOjWT0LIzdpxCspXAiFEmb96GCUoNyrkdWpdEWK',
  gasDeployUrl: ''
};

const ROI_PLATAFORMAS = {
  meta: ['origem:facebook', 'origem:instagram', 'origem:trafego-pago', 'origem:campanha-familia'],
  google: ['origem:google', 'origem:site', 'origem:organico']
};


// ═══════════════════════════════════════════════════════════════
//  RESPOSTAS JSON E PARSE SEGURO DE POST
// ═══════════════════════════════════════════════════════════════

function jsonOutput_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function parsePostBody_(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return {};
    const contentType = String(e.postData.type || '').toLowerCase();
    const raw = String(e.postData.contents || '');
    if (!raw) return {};
    if (contentType.indexOf('application/json') > -1 || raw.trim().charAt(0) === '{' || raw.trim().charAt(0) === '[') {
      return JSON.parse(raw);
    }
    return raw.split('&').reduce(function(acc, pair) {
      const parts = pair.split('=');
      const key = decodeURIComponent(parts[0] || '').trim();
      if (!key) return acc;
      acc[key] = decodeURIComponent((parts.slice(1).join('=') || '').replace(/\+/g, ' '));
      return acc;
    }, {});
  } catch (err) {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
//  ENTRADAS WEB
// ═══════════════════════════════════════════════════════════════

function doGet(e) {
  const params  = (e && e.parameter) || {};
  const formato = params.format || 'html';

  if (params.code) return kommoHandleOAuthCallback_(params.code);

  if (formato === 'agendar') {
    return HtmlService.createHtmlOutput(paginaAgendamentoPublico_())
      .setTitle('Agendar Consulta — Ótica Target')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (formato === 'roi') {
    try {
      ensureSystemStructure_();
      const email = normalizeEmail_(params.email || Session.getEffectiveUser().getEmail() || 'sistema@local');
      return jsonOutput_(getRoiData(Number(params.dias || 30), email));
    } catch (err) {
      return jsonOutput_({ ok: false, erro: err.message || String(err) });
    }
  }


  if (formato === 'api') {
    try {
      const apiKey         = params.key || '';
      const expectedApiKey = PropertiesService.getScriptProperties().getProperty('API_KEY');
      if (!expectedApiKey || apiKey !== expectedApiKey) {
        return jsonOutput_({ ok: false, error: 'Unauthorized' });
      }
      ensureSystemStructure_();
      return handleHttpApiCall_(params);
    } catch (err) {
      return jsonOutput_({ ok: false, error: err.message || String(err) });
    }
  }

  ensureSystemStructure_();
  try {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle(PROJECT_NAME)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  } catch (err) {
    return HtmlService.createHtmlOutput(paginaFallback_())
      .setTitle(PROJECT_NAME)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
}

function doPost(e) {
  try {
    ensureSystemStructure_();

    const params = (e && e.parameter) || {};
    const body   = parsePostBody_(e);

    const secretRecebido = normalizeText_(
      params.secret || params.token || body.secret || body.token || body.apiKey || ''
    );
    const secretEsperado = getKommoWebhookSecret_();

    if (secretEsperado && secretRecebido !== secretEsperado) {
      return jsonOutput_({ ok: false, erro: 'Acesso negado. Token inválido.' });
    }

    const action = normalizeText_(
      body.action || body.acao || params.action || params.acao || ''
    );

    if (!action) {
      registrarSincronizacao_('KOMMO_WEBHOOK', JSON.stringify(body).slice(0, 1000), 'kommo');
      const result = processarWebhookKommo_(body);
      return jsonOutput_({ ok: true, tipo: 'kommoWebhook', result: result || null });
    }

    const result = executarAcaoApiNode_(action, body, params);
    return jsonOutput_({ ok: true, action: action, result: result });

  } catch (err) {
    return jsonOutput_({ ok: false, erro: err.message || String(err), stack: err.stack || '' });
  }
}

/**
 * Roteador principal da API Node.js → Google Apps Script
 */
function executarAcaoApiNode_(action, body, params) {
  action = normalizeText_(action);

  switch (action) {
    case 'testeConexao':
      return {
        ok: true,
        message: 'Conexão com Google Apps Script autorizada.',
        projectName: PROJECT_NAME,
        serverVersion: SERVER_VERSION,
        dataHora: new Date()
      };

    case 'getInfoInicial':
      return getInfoInicial();

    case 'getBootstrapSistema': {
      const user = resolverUsuarioApi_(body);
      const filtros = body.filtros || {};
      return getBootstrapSistema(user, filtros);
    }

    case 'login':
      return loginSeguro(body.email || body.userEmail || body.loginEmail);

    case 'getUsuarioLogado':
      return getUsuarioLogado(body.email || body.userEmail || body.loginEmail);

    case 'getLojas':
      return getLojas();

    case 'getOrigens':
      return getOrigens();

    case 'getOptometristasPorLoja':
      return getOptometristasPorLoja(body.loja || params.loja || '');

    case 'getOwners':
      return getOwners();

    case 'getAccessTags':
      return getAccessTags();

    case 'getAgendamentos': {
      const user = resolverUsuarioApi_(body);
      const filtros = body.filtros || {};
      return getAgendamentosSeguro(user, filtros);
    }

    case 'salvarAgendamento': {
      const user = resolverUsuarioApi_(body);
      const payload = body.payload || body.agendamento || body;
      return salvarAgendamento(payload, user);
    }

    case 'updateRow': {
      const user = resolverUsuarioApi_(body);
      const payload = body.payload || body;
      return updateRow(payload, user);
    }

    case 'salvarOS': {
      const user = resolverUsuarioApi_(body);
      const payload = body.payload || body;
      return salvarOS(payload, user);
    }

    case 'confirmarAgendamento': {
      const user = resolverUsuarioApi_(body);
      const id = body.id || body.agendamentoId || body.payload?.id;
      return confirmarAgendamento(id, user);
    }

    case 'marcarCompareceu': {
      const user = resolverUsuarioApi_(body);
      const id = body.id || body.agendamentoId || body.payload?.id;
      return marcarCompareceu(id, user);
    }

    case 'marcarNaoCompareceu': {
      const user = resolverUsuarioApi_(body);
      const id = body.id || body.agendamentoId || body.payload?.id;
      return marcarNaoCompareceu(id, user);
    }

    case 'marcarCompraStatus': {
      const user = resolverUsuarioApi_(body);
      const id = body.id || body.agendamentoId || body.payload?.id;
      const comprou = body.comprou === true || body.comprou === 'true' || body.comprou === 'Sim';
      return marcarCompraStatus(id, comprou, user);
    }

    case 'cancelarAgendamento': {
      const user = resolverUsuarioApi_(body);
      const id = body.id || body.agendamentoId || body.payload?.id;
      return cancelarAgendamento(id, user);
    }

    case 'excluirAgendamento': {
      const user = resolverUsuarioApi_(body);
      const id = body.id || body.agendamentoId || body.payload?.id;
      return excluirAgendamento(id, user);
    }

    case 'kommoWebhook': {
      registrarSincronizacao_('KOMMO_WEBHOOK', JSON.stringify(body.payload || body).slice(0, 1000), 'kommo');
      return processarWebhookKommo_(body.payload || body);
    }

    default:
      throw new Error('Ação não reconhecida: ' + action);
  }
}


/**
 * Resolve usuário enviado pelo Node.js.
 * Pode receber:
 * - body.user completo
 * - body.email
 * - body.userEmail
 * - body.loginEmail
 */
function resolverUsuarioApi_(body) {
  body = body || {};

  if (body.user && body.user.email && body.user.perfil) {
    return body.user;
  }

  const email = normalizeEmail_(
    body.email ||
    body.userEmail ||
    body.loginEmail ||
    body.filtros?.loginEmail ||
    body.payload?.loginEmail ||
    body.payload?.email ||
    ''
  );

  if (!email) {
    throw new Error('E-mail do usuário não enviado para autenticação da ação.');
  }

  const loginResult = loginSeguro(email);

  if (!loginResult || !loginResult.ok || !loginResult.user) {
    throw new Error(loginResult.message || 'Usuário inválido ou sem permissão.');
  }

  return loginResult.user;
}


/**
 * Execute esta função uma vez para configurar o token do Node.js.
 * Use o mesmo valor no arquivo .env do Node.js em GAS_API_KEY.
 */
function configurarApiKeyNode() {
  const token = 'agendamento_tgt_target_2026_api_segura_XYZ520741';

  PropertiesService
    .getScriptProperties()
    .setProperty('KOMMO_WEBHOOK_SECRET', token);

  Logger.log('GAS_API_KEY configurada com sucesso: ' + token);
}
// ═══════════════════════════════════════════════════════════════
//  UTILITÁRIOS
// ═══════════════════════════════════════════════════════════════

function getSpreadsheet_() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSheet_(name) {
  const sh = getSpreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Aba não encontrada: ' + name);
  return sh;
}

function normalizeText_(v) {
  return String(v == null ? '' : v).trim();
}

function normalizeRole_(role) {
  return normalizeText_(role).toLowerCase();
}

function normalizeEmail_(email) {
  email = normalizeText_(email).toLowerCase();
  const parts = email.split('@');
  if (parts.length !== 2) return email;
  let local = parts[0];
  const domain = parts[1];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '').replace(/\+.*/, '');
  }
  return local + '@' + domain;
}

function serializarValor_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return Utilities.formatDate(v, 'America/Sao_Paulo', 'yyyy-MM-dd HH:mm:ss');
  }
  if (v === null || v === undefined) return '';
  return v;
}

function formatDateOnly_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return Utilities.formatDate(v, 'America/Sao_Paulo', 'yyyy-MM-dd');
  }
  const s = normalizeText_(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function formatDateBR_(v) {
  const iso = formatDateOnly_(v);
  if (!iso) return '';
  const parts = iso.split('-');
  if (parts.length === 3) return parts[2] + '/' + parts[1] + '/' + parts[0];
  return iso;
}

function formatTimeOnly_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return Utilities.formatDate(v, 'America/Sao_Paulo', 'HH:mm');
  }

  const s = normalizeText_(v);
  if (!s) return '';

  const hhmm = s.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) {
    return String(hhmm[1]).padStart(2, '0') + ':' + hhmm[2];
  }

  return s;
}

function normalizeHourValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, 'America/Sao_Paulo', 'HH:mm');
  }

  var s = normalizeText_(value);
  if (!s) return '';

  // Se vier datetime completo, pega só HH:mm
  var matchDateTime = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
  if (matchDateTime) {
    return String(matchDateTime[1]).padStart(2, '0') + ':' + String(matchDateTime[2]).padStart(2, '0');
  }

  // Se vier número decimal do Google Sheets (fração do dia)
  var n = Number(String(value).replace(',', '.'));
  if (!isNaN(n) && n >= 0 && n < 1) {
    var totalMinutes = Math.round(n * 24 * 60);
    var hh = Math.floor(totalMinutes / 60) % 24;
    var mm = totalMinutes % 60;
    return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  }

  return s;
}

function parseDateSafe_(v) {
  const s = formatDateOnly_(v);
  if (!s) return null;
  const d = new Date(s + 'T12:00:00');
  return isNaN(d) ? null : d;
}

function diffDays_(dateStart, dateEnd) {
  const a = parseDateSafe_(dateStart);
  const b = parseDateSafe_(dateEnd);
  if (!a || !b) return '';
  return Math.max(0, Math.round((b - a) / 86400000));
}

function parseTimeToMinutes_(hhmm) {
  const parts = String(hhmm || '').split(':').map(Number);
  if (parts.length < 2 || Number.isNaN(parts[0]) || Number.isNaN(parts[1])) return null;
  return parts[0] * 60 + parts[1];
}

function toJsonSafe_(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function splitTags_(value) {
  return normalizeText_(value).split(/[;,|]/).map(function(v) {
    return normalizeText_(v).toLowerCase();
  }).filter(Boolean);
}

function numberSafe_(v) {
  const n = Number(String(v == null ? '' : v).replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

function getScriptSecret_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function setScriptSecret_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, String(value || ''));
  return { ok: true, key: key };
}

function getKommoAccessToken_() {
  return getScriptSecret_('KOMMO_ACCESS_TOKEN') || KOMMO_DEFAULTS.accessToken;
}

function getKommoWebhookSecret_() {
  return getScriptSecret_('KOMMO_WEBHOOK_SECRET');
}

function getKommoClientId_() {
  return getScriptSecret_('KOMMO_CLIENT_ID') || KOMMO_DEFAULTS.clientId;
}

function getKommoClientSecret_() {
  return getScriptSecret_('KOMMO_CLIENT_SECRET') || KOMMO_DEFAULTS.clientSecret;
}

function getGasDeployUrl_() {
  return getScriptSecret_('GAS_DEPLOY_URL') || KOMMO_DEFAULTS.gasDeployUrl;
}

// ═══════════════════════════════════════════════════════════════
//  ESTRUTURA DA PLANILHA
// ═══════════════════════════════════════════════════════════════

function ensureSheetWithHeaders_(sheetName, headers) {
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(sheetName);
  if (!sh) {
    sh = ss.insertSheet(sheetName);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    const existing = sh.getLastColumn()
      ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_)
      : [];
    if (!existing.length) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    } else {
      headers.forEach(function(h) {
        if (existing.indexOf(h) === -1) {
          sh.getRange(1, existing.length + 1).setValue(h);
          existing.push(h);
        }
      });
    }
  }

  sh.setFrozenRows(1);
}

function ensureSystemStructure_() {
  Object.keys(REQUIRED_HEADERS).forEach(function(k) {
    ensureSheetWithHeaders_(SHEETS[k], REQUIRED_HEADERS[k]);
  });
  seedDefaultsIfEmpty_();
}

function seedDefaultsIfEmpty_() {
  seedIfEmpty_(SHEETS.configuracoes, [
    ['seg_sex_inicio', '10:00', 'Início de segunda a sexta'],
    ['seg_sex_fim', '18:00', 'Fim de segunda a sexta'],
    ['sab_inicio', '10:00', 'Início aos sábados'],
    ['sab_fim', '16:00', 'Fim aos sábados'],
    ['domingo_bloqueado', 'Sim', 'Bloquear domingo'],
    ['versao_servidor', SERVER_VERSION, 'Versão do backend']
  ]);
  seedIfEmpty_(SHEETS.origens, [
    ['Google', 'Sim'], ['Instagram', 'Sim'], ['Facebook', 'Sim'], ['WhatsApp', 'Sim'], ['Indicação', 'Sim'], ['Site', 'Sim']
  ]);
  seedIfEmpty_(SHEETS.lojas, [
    ['óticas Target - Ademar de Barros', '', 'Sim'],
    ['óticas TGT - Gonzaga', '', 'Sim'],
    ['óticas TGT Enseada', '', 'Sim'],
    ['óticas TGT Pitangueiras', '', 'Sim']
  ]);
}

function seedIfEmpty_(sheetName, rows) {
  const sh = getSheet_(sheetName);
  if (sh.getLastRow() <= 1 && rows && rows.length) {
    sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
}



function getConfigMap_() {
  const rows = getRowsAsObjects_(SHEETS.configuracoes);
  const map = {};
  rows.forEach(function(r) {
    const chave = normalizeText_(r.Chave);
    if (!chave) return;
    map[chave] = r.Valor;
  });
  return map;
}

function getBusinessRules_() {
  const cfg = getConfigMap_();
  return {
    segSexInicio: normalizeHourValue_(cfg.seg_sex_inicio) || '10:00',
    segSexFim: normalizeHourValue_(cfg.seg_sex_fim) || '18:00',
    sabInicio: normalizeHourValue_(cfg.sab_inicio) || '10:00',
    sabFim: normalizeHourValue_(cfg.sab_fim) || '16:00',
    domingoBloqueado: String(cfg.domingo_bloqueado || 'Sim').toLowerCase() === 'sim',
    versaoServidor: normalizeText_(cfg.versao_servidor) || SERVER_VERSION
  };
}

// ═══════════════════════════════════════════════════════════════
//  USUÁRIOS, LOGIN E PERMISSÕES
// ═══════════════════════════════════════════════════════════════

function getUsuariosAtivos_() {
  return getRowsAsObjects_(SHEETS.usuarios).filter(function(r) {
    return normalizeText_(r.Ativo).toLowerCase() === 'sim';
  }).map(function(r, idx) {
    return {
      IdUsuario: normalizeText_(r.IdUsuario) || ('USR-' + (idx + 1)),
      Email: normalizeText_(r.Email),
      Nome: normalizeText_(r.Nome),
      Perfil: normalizeText_(r.Perfil),
      Loja: normalizeText_(r.Loja),
      Ativo: normalizeText_(r.Ativo),
      AccessTags: normalizeText_(r.AccessTags),
      CanViewFinance: normalizeText_(r.CanViewFinance)
    };
  });
}

function getUserContext_(email) {
  const target = normalizeEmail_(email);
  const user = getUsuariosAtivos_().find(function(u) {
    return normalizeEmail_(u.Email) === target;
  });
  if (!user) return null;

  const role = normalizeRole_(user.Perfil);
  const canViewFinance =
    role === 'admin' ||
    role === 'gerente de loja' ||
    normalizeText_(user.CanViewFinance).toLowerCase() === 'sim';

  const permissions = {
    isAdmin: role === 'admin',
    canViewAll: ['admin', 'atendimento central'].indexOf(role) > -1,
    canCreateAgendamento: ['admin', 'atendimento central', 'consultor de vendas', 'vendedor', 'outros', 'gerente de loja'].indexOf(role) > -1,
    canEditAgendamento: ['admin', 'atendimento central', 'consultor de vendas', 'vendedor', 'outros', 'gerente de loja'].indexOf(role) > -1,
    canDeleteOwn: false,
    canDeleteAny: ['admin', 'atendimento central'].indexOf(role) > -1,
    canCancelOwn: false,
    canCancelAny: ['admin', 'atendimento central'].indexOf(role) > -1,
    canMarkPresence: ['admin', 'atendimento central', 'optometrista', 'consultor de vendas', 'vendedor', 'outros', 'gerente de loja'].indexOf(role) > -1,
    canMarkPurchaseOutcome: ['admin', 'atendimento central', 'consultor de vendas', 'vendedor', 'outros', 'gerente de loja'].indexOf(role) > -1,
    canManageOS: ['admin', 'atendimento central', 'consultor de vendas', 'vendedor', 'outros', 'gerente de loja'].indexOf(role) > -1,
    canViewDashboardCentral: ['admin', 'atendimento central', 'gerente de loja'].indexOf(role) > -1,
    canViewCurrentMonthOnly: role === 'optometrista',
    canViewMineOnly: ['consultor de vendas', 'vendedor', 'outros'].indexOf(role) > -1,
    canViewFinance: canViewFinance,
    canExportFinance: role === 'admin',
    canViewStoreHistory: role === 'admin' || role === 'gerente de loja'
  };

  return {
    id: user.IdUsuario,
    nome: user.Nome,
    email: user.Email,
    loginKey: normalizeEmail_(user.Email),
    perfil: user.Perfil,
    loja: (role === 'admin' || role === 'atendimento central') ? 'Todas' : user.Loja,
    accessTags: splitTags_(user.AccessTags),
    permissions: permissions
  };
}

function login(email) {
  try {
    ensureSystemStructure_();
    const requestedEmail = normalizeEmail_(email);
    if (!requestedEmail) {
      return { ok: false, message: 'Informe um e-mail para acessar o sistema.' };
    }

    const user = getUserContext_(requestedEmail);
    if (!user) {
      return { ok: false, message: 'Usuário não encontrado ou inativo: ' + requestedEmail };
    }

    return toJsonSafe_({
      ok: true,
      user: user,
      session: { resolvedEmail: requestedEmail, sessionEmail: '' },
      serverVersion: getBusinessRules_().versaoServidor
    });
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

function loginSeguro(email) {
  return login(email);
}

function getUsuarioLogado(email) {
  return login(email);
}

function can_(user, action, record) {
  if (!user) return false;
  const role = normalizeRole_(user.perfil);
  if (role === 'admin') return true;

  if (role === 'atendimento central') {
    return [
      'agendamento.create', 'agendamento.edit', 'agendamento.delete', 'agendamento.cancel',
      'agendamento.confirm', 'agendamento.view', 'presenca.mark', 'purchase.mark',
      'dashboard.operacional.view', 'os.view', 'os.edit', 'os.create', 'os.update_status',
      'leadtime.view'
    ].indexOf(action) > -1;
  }

  if (role === 'gerente de loja') {
    const isOwnStore = !record || normalizeText_(record.Loja) === normalizeText_(user.loja);
    if (['agendamento.create', 'agendamento.edit', 'os.create', 'os.edit', 'os.update_status', 'purchase.mark', 'presenca.mark'].indexOf(action) > -1) return isOwnStore || !record;
    if ([
      'agendamento.view', 'agendamento.confirm', 'agendamento.delete', 'agendamento.cancel',
      'os.view', 'leadtime.view', 'dashboard.operacional.view'
    ].indexOf(action) > -1) return isOwnStore;
    return false;
  }

  if (role === 'optometrista') {
    if (!record) return false;
    const isOwnStore = normalizeText_(record.Loja) === normalizeText_(user.loja);
    const isMonth = isCurrentMonth_(record.DataAgendamento);
    if (action === 'presenca.mark') return isOwnStore && isMonth;
    if (action === 'agendamento.view') return isOwnStore && isMonth;
    return false;
  }

  if (['consultor de vendas', 'vendedor', 'outros'].indexOf(role) > -1) {
    const sameStore = !record || normalizeText_(record.Loja) === normalizeText_(user.loja);
    if (['agendamento.create', 'agendamento.edit', 'presenca.mark', 'purchase.mark', 'os.create', 'os.edit', 'os.update_status'].indexOf(action) > -1) {
      return sameStore || !record;
    }
    if (['agendamento.view', 'os.view'].indexOf(action) > -1) {
      return sameStore;
    }
    return false;
  }

  return false;
}

function normalizeLoginContext_(user, filtros) {
  filtros = filtros || {};
  return {
    role: normalizeRole_(user && user.perfil),
    loginEmail: normalizeEmail_(filtros.loginEmail || filtros.userEmail || (user && user.email) || Session.getActiveUser().getEmail()),
    loginId: normalizeText_(filtros.userId || (user && user.id)),
    lojaUser: normalizeText_((user && user.loja) || filtros.lojaUsuario || ''),
    loginNome: normalizeText_((user && user.nome) || filtros.userNome || '')
  };
}

function matchesAccessTags_(user, record) {
  const userTags = (user && user.accessTags) || [];
  const recordTags = splitTags_(record.AccessTags || '');
  if (!recordTags.length || !userTags.length) return true;
  return recordTags.some(function(t) { return userTags.indexOf(t) > -1; });
}

function applyVisibility_(user, rows, filtros) {
  const ctx = normalizeLoginContext_(user, filtros);
  let filtered = rows.filter(function(r) { return matchesAccessTags_(user, r); });
  if (ctx.role === 'admin' || ctx.role === 'atendimento central') return filtered;
  if (ctx.role === 'gerente de loja') return filtered.filter(function(r) { return normalizeText_(r.Loja) === ctx.lojaUser; });
  if (ctx.role === 'optometrista') return filtered.filter(function(r) { return normalizeText_(r.Loja) === ctx.lojaUser && isCurrentMonth_(r.DataAgendamento); });
  if (['consultor de vendas', 'vendedor', 'outros'].indexOf(ctx.role) > -1) {
    return filtered.filter(function(r) {
      return normalizeText_(r.Loja) === ctx.lojaUser;
    });
  }
  return [];
}

function removerCamposFinanceirosSeNecessario_(rows, user) {
  const canViewFinance = user && user.permissions && user.permissions.canViewFinance;
  if (canViewFinance) return rows;
  return rows.map(function(r) {
    const clean = Object.assign({}, r);
    delete clean.ValorVenda;
    delete clean.Desconto;
    delete clean.ValorOS;
    delete clean.totalFaturado;
    delete clean.totalDesconto;
    delete clean.ticketMedio;
    return clean;
  });
}

function filtrarChangesPorPerfil_(changes, user) {
  const role = normalizeRole_(user && user.perfil);
  const camposPermitidos = {
    vendedor: ['Origem', 'NomeCompleto', 'WhatsApp', 'Email', 'Loja', 'Optometrista', 'DataAgendamento', 'Horario', 'Observacao', 'StatusAgenda', 'Compareceu', 'AtendimentoRealizado', 'VendaGerada', 'NumeroOS', 'DataAberturaOS', 'DataEntradaOS', 'DataFinalizacaoOS', 'DataEntregaOS', 'StatusOS', 'UltimaAtualizacao', 'VendedorNome', 'ValorVenda', 'Desconto'],
    'consultor de vendas': ['Origem', 'NomeCompleto', 'WhatsApp', 'Email', 'Loja', 'Optometrista', 'DataAgendamento', 'Horario', 'Observacao', 'StatusAgenda', 'Compareceu', 'AtendimentoRealizado', 'VendaGerada', 'NumeroOS', 'DataAberturaOS', 'DataEntradaOS', 'DataFinalizacaoOS', 'DataEntregaOS', 'StatusOS', 'UltimaAtualizacao', 'VendedorNome', 'ValorVenda', 'Desconto'],
    outros: ['Origem', 'NomeCompleto', 'WhatsApp', 'Email', 'Loja', 'Optometrista', 'DataAgendamento', 'Horario', 'Observacao', 'StatusAgenda', 'Compareceu', 'AtendimentoRealizado', 'VendaGerada', 'NumeroOS', 'DataAberturaOS', 'DataEntradaOS', 'DataFinalizacaoOS', 'DataEntregaOS', 'StatusOS', 'UltimaAtualizacao', 'VendedorNome', 'ValorVenda', 'Desconto'],
    'gerente de loja': ['Origem', 'NomeCompleto', 'WhatsApp', 'Email', 'Loja', 'Optometrista', 'DataAgendamento', 'Horario', 'Observacao', 'StatusAgenda', 'Compareceu', 'AtendimentoRealizado', 'VendaGerada', 'NumeroOS', 'DataAberturaOS', 'DataEntradaOS', 'DataFinalizacaoOS', 'DataEntregaOS', 'StatusOS', 'UltimaAtualizacao', 'VendedorNome', 'ValorVenda', 'Desconto'],
    optometrista: ['Compareceu', 'StatusAgenda', 'UltimaAtualizacao']
  };
  const allowed = camposPermitidos[role];
  if (!allowed) return changes;
  const safe = {};
  allowed.forEach(function(k) {
    if (Object.prototype.hasOwnProperty.call(changes, k)) safe[k] = changes[k];
  });
  return safe;
}

// ═══════════════════════════════════════════════════════════════
//  DADOS BASE
// ═══════════════════════════════════════════════════════════════

function getLojas() {
  ensureSystemStructure_();
  return toJsonSafe_(getRowsAsObjects_(SHEETS.lojas).map(function(r) {
    return { Loja: normalizeText_(r.Loja), Cidade: normalizeText_(r.Cidade), Ativa: normalizeText_(r.Ativa) };
  }).filter(function(r) { return r.Loja && r.Ativa.toLowerCase() === 'sim'; }));
}

function getOrigens() {
  ensureSystemStructure_();
  return toJsonSafe_(getRowsAsObjects_(SHEETS.origens).map(function(r) {
    return { Origem: normalizeText_(r.Origem), Ativa: normalizeText_(r.Ativa) };
  }).filter(function(r) { return r.Origem && r.Ativa.toLowerCase() === 'sim'; }));
}

function getOptometristasPorLoja(loja) {
  ensureSystemStructure_();
  const target = normalizeText_(loja);
  let rows = getRowsAsObjects_(SHEETS.optometristas).map(function(r) {
    return { Optometrista: normalizeText_(r.Optometrista), Loja: normalizeText_(r.Loja), Ativo: normalizeText_(r.Ativo) };
  }).filter(function(r) { return r.Optometrista && r.Ativo.toLowerCase() === 'sim'; });
  if (target) rows = rows.filter(function(r) { return r.Loja === target; });
  return toJsonSafe_(rows);
}

function getOwners_() {
  return toJsonSafe_(getUsuariosAtivos_().filter(function(u) {
    return ['admin', 'atendimento central', 'consultor de vendas', 'vendedor', 'outros', 'gerente de loja'].indexOf(normalizeRole_(u.Perfil)) > -1;
  }).map(function(u) {
    return { id: u.IdUsuario, nome: u.Nome, perfil: u.Perfil, loja: u.Loja };
  }));
}

function getOwners() {
  ensureSystemStructure_();
  return getOwners_();
}

function getAccessTags_() {
  const set = {};
  SYSTEM_ACCESS_TAGS.forEach(function(t) { set[normalizeText_(t).toLowerCase()] = true; });
  getUsuariosAtivos_().forEach(function(u) { splitTags_(u.AccessTags).forEach(function(t) { set[t] = true; }); });
  getRowsAsObjects_(SHEETS.agendamentos).forEach(function(r) { splitTags_(r.AccessTags).forEach(function(t) { set[t] = true; }); });
  return Object.keys(set).sort().map(function(t) { return { id: t, nome: t }; });
}

function getAccessTags() {
  ensureSystemStructure_();
  return getAccessTags_();
}

function getFeriadosMap_() {
  const map = {};
  getRowsAsObjects_(SHEETS.feriados).forEach(function(r) {
    const key = formatDateOnly_(r.Data);
    if (key) map[key] = normalizeText_(r.Descricao) || 'Feriado';
  });
  return map;
}

function isCurrentMonth_(dateStr) {
  const d = parseDateSafe_(dateStr);
  const now = new Date();
  return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
}

function getInfoInicial() {
  try {
    ensureSystemStructure_();
    return toJsonSafe_({
      ok: true,
      projectName: PROJECT_NAME,
      serverVersion: getBusinessRules_().versaoServidor,
      businessRules: getBusinessRules_(),
      lojas: getLojas(),
      origens: getOrigens(),
      owners: getOwners_(),
      accessTags: getAccessTagsLeve_()
    });
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

function getAccessTagsLeve_() {
  const set = {};
  SYSTEM_ACCESS_TAGS.forEach(function(t) {
    set[normalizeText_(t).toLowerCase()] = true;
  });
  getUsuariosAtivos_().forEach(function(u) {
    splitTags_(u.AccessTags).forEach(function(t) { set[t] = true; });
  });
  return Object.keys(set).sort().map(function(t) { return { id: t, nome: t }; });
}

function getBootstrapSistema(user, filtros) {
  try {
    ensureSystemStructure_();
    filtros = filtros || {};
    const regras = getBusinessRules_();
    const agendamentos = getAgendamentos(user, filtros);
    const dashboard = buildDashboard_(user, agendamentos);
    return toJsonSafe_({
      ok: true,
      projectName: PROJECT_NAME,
      serverVersion: regras.versaoServidor,
      businessRules: regras,
      lojas: getLojas(),
      origens: getOrigens(),
      owners: getOwners_(),
      accessTags: getAccessTagsLeve_(),
      agendamentos: agendamentos,
      dashboard: dashboard,
      dataAtualizacao: Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm:ss')
    });
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

// ═══════════════════════════════════════════════════════════════
//  AGENDAMENTOS
// ═══════════════════════════════════════════════════════════════

function getAtendimentoSemaforo_(r) {
  const compareceu = normalizeText_(r.Compareceu).toLowerCase();
  const statusAgenda = normalizeText_(r.StatusAgenda).toLowerCase();
  const vendaGerada = normalizeText_(r.VendaGerada).toLowerCase();
  const valorVenda = numberSafe_(r.ValorVenda);
  if (statusAgenda === 'não compareceu' || statusAgenda === 'nao compareceu' || compareceu === 'não' || compareceu === 'nao') return { cor: 'vermelho', label: 'Não compareceu' };
  if (compareceu === 'sim' || statusAgenda === 'compareceu' || statusAgenda === 'concluído' || statusAgenda === 'concluido') {
    if (vendaGerada === 'sim' || valorVenda > 0) return { cor: 'verde', label: 'Compareceu e comprou' };
    return { cor: 'amarelo', label: 'Compareceu e não comprou' };
  }
  return { cor: '', label: '' };
}

function serializeAgendamento_(r) {
  const leadTime = normalizeText_(r.LeadTimeDias) || diffDays_(r.DataAberturaOS, r.DataFinalizacaoOS);
  const entrega = parseDateSafe_(r.DataEntregaOS);
  const hoje = parseDateSafe_(new Date());
  const overdue = !!(r.DataEntregaOS && !r.DataFinalizacaoOS && entrega && hoje && entrega < hoje);
  const atendimentoSemaforo = getAtendimentoSemaforo_(r);
  return {
    __rowNumber: r.__rowNumber,
    ID: normalizeText_(r.ID),
    DataCadastro: serializarValor_(r.DataCadastro),
    DataCadastroBR: formatDateBR_(r.DataCadastro),
    Origem: normalizeText_(r.Origem),
    NomeCompleto: normalizeText_(r.NomeCompleto),
    WhatsApp: normalizeText_(r.WhatsApp),
    Email: normalizeText_(r.Email),
    Loja: normalizeText_(r.Loja),
    Optometrista: normalizeText_(r.Optometrista),
    Responsavel: normalizeText_(r.Responsavel),
    DataAgendamento: formatDateOnly_(r.DataAgendamento),
    DataAgendamentoBR: formatDateBR_(r.DataAgendamento),
    Horario: formatTimeOnly_(r.Horario),
    Observacao: normalizeText_(r.Observacao),
    StatusAgenda: normalizeText_(r.StatusAgenda),
    Compareceu: normalizeText_(r.Compareceu),
    AtendimentoRealizado: normalizeText_(r.AtendimentoRealizado),
    VendaGerada: normalizeText_(r.VendaGerada),
    ValorVenda: numberSafe_(r.ValorVenda),
    Desconto: numberSafe_(r.Desconto),
    MotivoPerda: normalizeText_(r.MotivoPerda),
    ConsultorResponsavel: normalizeText_(r.ConsultorResponsavel),
    CriadoPorEmail: normalizeText_(r.CriadoPorEmail),
    UltimaAtualizacao: serializarValor_(r.UltimaAtualizacao),
    ProprietarioId: normalizeText_(r.ProprietarioId) || normalizeText_(r.CriadoPorEmail),
    ProprietarioNome: normalizeText_(r.ProprietarioNome) || normalizeText_(r.Responsavel),
    NumeroOS: normalizeText_(r.NumeroOS),
    DataAberturaOS: formatDateOnly_(r.DataAberturaOS),
    DataAberturaOSBR: formatDateBR_(r.DataAberturaOS),
    DataEntradaOS: formatDateOnly_(r.DataEntradaOS),
    DataEntradaOSBR: formatDateBR_(r.DataEntradaOS),
    DataFinalizacaoOS: formatDateOnly_(r.DataFinalizacaoOS),
    DataFinalizacaoOSBR: formatDateBR_(r.DataFinalizacaoOS),
    DataEntregaOS: formatDateOnly_(r.DataEntregaOS),
    DataEntregaOSBR: formatDateBR_(r.DataEntregaOS),
    StatusOS: normalizeText_(r.StatusOS),
    AccessTags: normalizeText_(r.AccessTags),
    LeadTimeDias: leadTime,
    VendedorNome: normalizeText_(r.VendedorNome),
    KommoLeadId: normalizeText_(r.KommoLeadId),
    IsOverdue: overdue,
    IsConcluidaVisual: normalizeText_(r.StatusAgenda) === 'Concluído' || !!normalizeText_(r.DataFinalizacaoOS),
    AtendimentoSemaforo: atendimentoSemaforo.cor,
    AtendimentoSemaforoLabel: atendimentoSemaforo.label
  };
}

function getAgendamentos(user, filtros) {
  ensureSystemStructure_();
  filtros = filtros || {};
  const ctx = normalizeLoginContext_(user, filtros);
  let rows = getRowsAsObjects_(SHEETS.agendamentos).map(serializeAgendamento_);
  rows = applyVisibility_(user, rows, filtros);

  if (ctx.role === 'optometrista' || ['consultor de vendas', 'vendedor', 'outros'].indexOf(ctx.role) > -1 || ctx.role === 'gerente de loja') {
    rows = rows.filter(function(r) { return normalizeText_(r.Loja) === ctx.lojaUser; });
  } else if (normalizeText_(filtros.loja)) {
    rows = rows.filter(function(r) { return r.Loja === normalizeText_(filtros.loja); });
  }

  // Consultor, vendedor e outros veem todos os agendamentos da própria loja.
  // O filtro "Meus Serviços" (filtros.meus) permite cada um visualizar só os seus.
  // A restrição de edição permanece: só podem editar registros onde são proprietários.

  if (normalizeText_(filtros.optometrista)) {
    const opto = normalizeText_(filtros.optometrista).toLowerCase();
    rows = rows.filter(function(r) { return r.Optometrista.toLowerCase().indexOf(opto) > -1; });
  }
  if (normalizeText_(filtros.status)) rows = rows.filter(function(r) { return r.StatusAgenda === normalizeText_(filtros.status); });
  if (normalizeText_(filtros.statusOS)) rows = rows.filter(function(r) { return r.StatusOS === normalizeText_(filtros.statusOS); });
  if (normalizeText_(filtros.cliente)) {
    const q = normalizeText_(filtros.cliente).toLowerCase();
    rows = rows.filter(function(r) {
      return r.NomeCompleto.toLowerCase().indexOf(q) > -1 || r.WhatsApp.toLowerCase().indexOf(q) > -1 || r.Email.toLowerCase().indexOf(q) > -1;
    });
  }
  if (ctx.role !== 'optometrista' && normalizeText_(filtros.ownerId)) rows = rows.filter(function(r) { return r.ProprietarioId === normalizeText_(filtros.ownerId); });
  if (normalizeText_(filtros.accessTag)) rows = rows.filter(function(r) { return splitTags_(r.AccessTags).indexOf(normalizeText_(filtros.accessTag).toLowerCase()) > -1; });

  if (String(filtros.meus || '') === 'true') {
    if (ctx.role === 'optometrista') {
      rows = rows.filter(function(r) {
        return normalizeText_(r.Loja) === ctx.lojaUser &&
          (normalizeText_(r.Responsavel).toLowerCase() === ctx.loginNome.toLowerCase() ||
            normalizeText_(r.Optometrista).toLowerCase() === ctx.loginNome.toLowerCase() ||
            isCurrentMonth_(r.DataAgendamento));
      });
    } else if (['consultor de vendas', 'vendedor', 'outros'].indexOf(ctx.role) > -1) {
      rows = rows.filter(function(r) {
        return normalizeText_(r.Loja) === ctx.lojaUser && (
          normalizeText_(r.ProprietarioId) === ctx.loginId ||
          normalizeEmail_(r.CriadoPorEmail) === ctx.loginEmail ||
          normalizeText_(r.ProprietarioNome).toLowerCase() === ctx.loginNome.toLowerCase() ||
          normalizeText_(r.Responsavel).toLowerCase() === ctx.loginNome.toLowerCase()
        );
      });
    }
  }

  if (String(filtros.minhasOSAtivas || '') === 'true') {
    rows = rows.filter(function(r) { return !!r.NumeroOS && !r.DataFinalizacaoOS && r.StatusAgenda === 'OS em Andamento'; });
  }

  const hoje = new Date();
  const noventaDiasAtras = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - 89);
  const dataDeDefault = Utilities.formatDate(noventaDiasAtras, 'America/Sao_Paulo'
, 'yyyy-MM-dd');
  const dataAteDefault = Utilities.formatDate(hoje, 'America/Sao_Paulo'
, 'yyyy-MM-dd');
  const dataDeFiltro = normalizeText_(filtros.dataDe) || dataDeDefault;
  const dataAteFiltro = normalizeText_(filtros.dataAte) || dataAteDefault;
  rows = rows.filter(function(r) {
    const dataBase = formatDateOnly_(String(r.DataCadastro || '').slice(0, 10) || r.DataAgendamento);
    return (!dataDeFiltro || dataBase >= dataDeFiltro) && (!dataAteFiltro || dataBase <= dataAteFiltro);
  });

  rows = rows.sort(function(a, b) {
    return String(b.DataCadastro || b.DataAgendamento).localeCompare(String(a.DataCadastro || a.DataAgendamento));
  });

  return toJsonSafe_(removerCamposFinanceirosSeNecessario_(rows, user));
}

function getAgendamentosSeguro(user, filtros) {
  return getAgendamentos(user, filtros || {});
}

function getRecordById_(id) {
  return getRowsAsObjects_(SHEETS.agendamentos).map(serializeAgendamento_).find(function(r) {
    return String(r.ID) === String(id);
  }) || null;
}

function getAgendamentoById_(id, user, filtros) {
  return getAgendamentos(user, filtros || {}).find(function(r) { return String(r.ID) === String(id); }) || null;
}

// ═══════════════════════════════════════════════════════════════
//  VALIDAÇÕES
// ═══════════════════════════════════════════════════════════════

function validarHorarioPermitido_(dataAgendamento, horario) {
  const rules = getBusinessRules_();
  const data = new Date(dataAgendamento + 'T12:00:00');
  const diaSemana = data.getDay();
  const minutos = parseTimeToMinutes_(horario);
  if (minutos === null) throw new Error('Horário inválido.');
  if (diaSemana === 0 && rules.domingoBloqueado) throw new Error('Domingo está bloqueado para agendamento.');
  if (diaSemana >= 1 && diaSemana <= 5) {
    const ini = parseTimeToMinutes_(rules.segSexInicio);
    const fim = parseTimeToMinutes_(rules.segSexFim);
    if (minutos < ini || minutos > fim) throw new Error('De segunda a sexta, o horário deve estar entre ' + rules.segSexInicio + ' e ' + rules.segSexFim + '.');
  }
  if (diaSemana === 6) {
    const iniSab = parseTimeToMinutes_(rules.sabInicio);
    const fimSab = parseTimeToMinutes_(rules.sabFim);
    if (minutos < iniSab || minutos > fimSab) throw new Error('Aos sábados, o horário deve estar entre ' + rules.sabInicio + ' e ' + rules.sabFim + '.');
  }
}

function validarFeriado_(dataAgendamento) {
  if (getFeriadosMap_()[normalizeText_(dataAgendamento)]) throw new Error('A data escolhida é feriado e está bloqueada.');
}

function validarConflitoHorario_(payload) {
  const rows = getRowsAsObjects_(SHEETS.agendamentos).map(serializeAgendamento_);
  const conflito = rows.some(function(r) {
    return r.Loja === normalizeText_(payload.loja) &&
      r.Optometrista.toLowerCase() === normalizeText_(payload.optometrista).toLowerCase() &&
      r.DataAgendamento === normalizeText_(payload.dataAgendamento) &&
      r.Horario === normalizeText_(payload.horario) &&
      r.StatusAgenda !== 'Cancelado' &&
      r.ID !== normalizeText_(payload.id);
  });
  if (conflito) throw new Error('Esse horário já está ocupado para esse optometrista nessa loja.');
}

function validarUser_(user) {
  if (!user || !user.email || !user.perfil) throw new Error('Usuário inválido ou não autenticado.');
}

// ═══════════════════════════════════════════════════════════════
//  PERSISTÊNCIA E AUDITORIA
// ═══════════════════════════════════════════════════════════════



function logAudit_(entidade, idEntidade, acao, campo, anterior, novo, user) {
  try {
    getSheet_(SHEETS.auditoria_eventos).appendRow([
      'AUD-' + new Date().getTime(), entidade, idEntidade, acao, campo,
      serializarValor_(anterior), serializarValor_(novo),
      user && user.id ? user.id : '', user && user.nome ? user.nome : '', user && user.perfil ? user.perfil : '', new Date()
    ]);
  } catch (e) {}
}

function savePresenceHistory_(record, status, user, obs) {
  try {
    getSheet_(SHEETS.presencas).appendRow([
      'PRS-' + new Date().getTime(), record.ID, record.NomeCompleto, record.DataAgendamento,
      status, user.id, user.nome, user.perfil, new Date(), obs || ''
    ]);
  } catch (e) {}
}

function saveOrUpdateOS_(record, user) {
  const sh = getSheet_(SHEETS.ordens_servico);
  const shData = sh.getDataRange().getValues();
  const headers = shData[0].map(normalizeText_);
  const leadTime = diffDays_(record.DataAberturaOS, record.DataFinalizacaoOS);
  const idAgenIdx = headers.indexOf('IdAgendamento');
  const existIdx = shData.findIndex(function(r, i) { return i > 0 && String(r[idAgenIdx]) === String(record.ID); });
  const isUpdate = existIdx > 0;

  const osMap = {
    NumeroOS: record.NumeroOS,
    IdAgendamento: record.ID,
    Cliente: record.NomeCompleto,
    Loja: record.Loja,
    ProprietarioId: record.ProprietarioId,
    ProprietarioNome: record.ProprietarioNome,
    VendedorId: record.ProprietarioId,
    VendedorNome: record.VendedorNome || record.ProprietarioNome,
    DataAberturaOS: record.DataAberturaOS,
    DataEntradaOS: record.DataEntradaOS,
    DataFinalizacaoOS: record.DataFinalizacaoOS,
    DataEntregaOS: record.DataEntregaOS,
    StatusOS: record.StatusOS,
    ObservacaoOS: record.Observacao || '',
    ValorOS: record.ValorVenda || '',
    Desconto: record.Desconto || '',
    LeadTimeDias: leadTime,
    AtualizadoPor: user.email,
    UpdatedAt: new Date()
  };

  if (isUpdate) {
    osMap.IdOSInterno = String(shData[existIdx][headers.indexOf('IdOSInterno')] || ('OSI-' + new Date().getTime()));
    osMap.CriadoPor = String(shData[existIdx][headers.indexOf('CriadoPor')] || user.email);
    osMap.CreatedAt = shData[existIdx][headers.indexOf('CreatedAt')] || new Date();
    const row = headers.map(function(h, idx) { return Object.prototype.hasOwnProperty.call(osMap, h) ? osMap[h] : shData[existIdx][idx]; });
    sh.getRange(existIdx + 1, 1, 1, row.length).setValues([row]);
  } else {
    osMap.IdOSInterno = 'OSI-' + new Date().getTime();
    osMap.CriadoPor = user.email;
    osMap.CreatedAt = new Date();
    const newRow = headers.map(function(h) { return Object.prototype.hasOwnProperty.call(osMap, h) ? osMap[h] : ''; });
    sh.appendRow(newRow);
  }
}

function updateAgendamentoFields_(id, changes, user, actionName, successMessage) {
  validarUser_(user);
  const record = getRecordById_(id);
  if (!record) throw new Error('Agendamento não encontrado.');

  const sh = getSheet_(SHEETS.agendamentos);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_);

  Object.keys(changes).forEach(function(field) {
    const col = headers.indexOf(field);
    if (col > -1) {
      const anterior = sh.getRange(record.__rowNumber, col + 1).getValue();
      sh.getRange(record.__rowNumber, col + 1).setValue(changes[field]);
      logAudit_('agendamento', id, actionName, field, anterior, changes[field], user);
    }
  });

  const merged = Object.assign({}, record, changes);
  const leadTime = diffDays_(merged.DataAberturaOS, merged.DataFinalizacaoOS);
  const ltCol = headers.indexOf('LeadTimeDias');
  if (ltCol > -1) sh.getRange(record.__rowNumber, ltCol + 1).setValue(leadTime);
  merged.LeadTimeDias = leadTime;

  if (['NumeroOS', 'DataAberturaOS', 'DataEntradaOS', 'DataFinalizacaoOS', 'DataEntregaOS', 'StatusOS', 'ValorVenda', 'Desconto', 'VendedorNome'].some(function(k) {
    return Object.prototype.hasOwnProperty.call(changes, k);
  })) {
    saveOrUpdateOS_(merged, user);
  }

  registrarSincronizacao_(actionName, successMessage, user.email);
  try {
    if (changes.StatusAgenda) {
      const leadId = getKommoLeadId_(id);
      if (leadId) kommoAtualizarEtapa_(leadId, changes.StatusAgenda, record.Loja);
    }
  } catch (eK) {
    Logger.log('[KOMMO] ' + eK.message);
  }
  return { ok: true, message: successMessage };
}

// ═══════════════════════════════════════════════════════════════
//  AÇÕES SOBRE AGENDAMENTOS
// ═══════════════════════════════════════════════════════════════

function salvarAgendamento(payload, user) {
  ensureSystemStructure_();
  validarUser_(user);

  if (!can_(user, 'agendamento.create')) {
    throw new Error('Seu perfil não pode criar agendamentos.');
  }

  payload = payload || {};

  const origem = normalizeText_(payload.origem);
  const nomeCompleto = normalizeText_(payload.nomeCompleto);
  const whatsApp = normalizeText_(payload.whatsApp);
  const email = normalizeText_(payload.email);
  const loja = normalizeText_(payload.loja);
  const optometrista = normalizeText_(payload.optometrista);
  const dataAgendamento = normalizeText_(payload.dataAgendamento);
  const horario = normalizeHourValue_(payload.horario);
  const observacao = normalizeText_(payload.observacao);
  const statusAgenda = normalizeText_(payload.statusAgenda) || 'Agendado';
  const accessTags = normalizeText_(payload.accessTags || (user.accessTags || []).join(';'));

  const obrigatorios = [
    [origem, 'Origem'],
    [nomeCompleto, 'Nome completo'],
    [whatsApp, 'WhatsApp'],
    [email, 'Email'],
    [loja, 'Loja'],
    [optometrista, 'Optometrista'],
    [dataAgendamento, 'Data do agendamento'],
    [horario, 'Horário'],
    [observacao, 'Observação'],
    [statusAgenda, 'Status']
  ];

  obrigatorios.forEach(function(item) {
    if (!item[0]) throw new Error('Campo obrigatório: ' + item[1] + '.');
  });

  if (!user.permissions.canViewAll && normalizeText_(user.loja) && normalizeText_(user.loja) !== 'Todas' && normalizeText_(user.loja) !== loja) {
    throw new Error('Você só pode agendar para sua própria loja.');
  }

  validarHorarioPermitido_(dataAgendamento, horario);
  validarFeriado_(dataAgendamento);
  validarConflitoHorario_({
    loja: loja,
    optometrista: optometrista,
    dataAgendamento: dataAgendamento,
    horario: horario
  });

  const agora = new Date();
  const id = 'AG-' + Utilities.formatDate(agora, 'America/Sao_Paulo', 'yyyyMMddHHmmssSSS');

  const rowMap = {
    ID: id,
    DataCadastro: agora,
    Origem: origem,
    NomeCompleto: nomeCompleto,
    WhatsApp: whatsApp,
    Email: email,
    Loja: loja,
    Optometrista: optometrista,
    Responsavel: normalizeText_(user.nome),
    DataAgendamento: dataAgendamento,
    Horario: horario,
    Observacao: observacao,
    StatusAgenda: statusAgenda,
    Compareceu: 'Pendente',
    AtendimentoRealizado: 'Não',
    VendaGerada: 'Não',
    ValorVenda: '',
    Desconto: '',
    MotivoPerda: '',
    ConsultorResponsavel: normalizeText_(user.nome),
    CriadoPorEmail: normalizeText_(user.email),
    UltimaAtualizacao: agora,
    ProprietarioId: normalizeText_(user.id || user.IdUsuario || ''),
    ProprietarioNome: normalizeText_(user.nome),
    NumeroOS: '',
    DataAberturaOS: '',
    DataEntradaOS: '',
    DataFinalizacaoOS: '',
    DataEntregaOS: '',
    StatusOS: '',
    AccessTags: accessTags,
    LeadTimeDias: '',
    VendedorNome: normalizeText_(user.nome),
    KommoLeadId: ''
  };

  const sh = getSheet_(SHEETS.agendamentos);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_);
  sh.appendRow(headers.map(function(h) {
    return Object.prototype.hasOwnProperty.call(rowMap, h) ? rowMap[h] : '';
  }));

  registrarSincronizacao_('AGENDAMENTO_CRIADO', 'Agendamento criado: ' + id, normalizeText_(user.email || user.nome));
  logAudit_('agendamento', id, 'CREATE', 'registro', '', JSON.stringify(rowMap), user);

  try {
    const leadId = kommoCriarLead_(Object.assign({}, payload, {
      id: id,
      loja: loja,
      optometrista: optometrista,
      dataAgendamento: dataAgendamento,
      horario: horario,
      origem: origem,
      nomeCompleto: nomeCompleto,
      whatsApp: whatsApp,
      email: email
    }));
    if (leadId) salvarKommoLeadId_(id, leadId);
  } catch (eK) {
    Logger.log('[KOMMO] ' + (eK.message || String(eK)));
  }

  return {
    ok: true,
    message: 'Agendamento salvo com sucesso.',
    id: id,
    horario: horario,
    atualizadoPor: normalizeText_(user.nome),
    atualizadoEm: Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm:ss')
  };
}


function confirmarAgendamento(id, user) {
  const record = getRecordById_(id);
  const role = normalizeRole_(user && user.perfil);
  const isGerenteOwnStore = role === 'gerente de loja' && record && normalizeText_(record.Loja) === normalizeText_(user && user.loja);
  if (!record || !(['admin', 'atendimento central'].indexOf(role) > -1 || isGerenteOwnStore)) throw new Error('Seu perfil não pode confirmar agendamentos.');
  return updateAgendamentoFields_(id, { StatusAgenda: 'Confirmado', UltimaAtualizacao: new Date() }, user, 'CONFIRMAR', 'Agendamento confirmado com sucesso.');
}

function marcarCompareceu(id, user) {
  const record = getRecordById_(id);
  if (!record || !can_(user, 'presenca.mark', record)) throw new Error('Seu perfil não pode marcar comparecimento.');
  savePresenceHistory_(record, 'Sim', user, 'Check-in marcado como sim');
  return updateAgendamentoFields_(id, { StatusAgenda: 'Compareceu', Compareceu: 'Sim', UltimaAtualizacao: new Date() }, user, 'CHECKIN_SIM', 'Comparecimento marcado com sucesso.');
}

function marcarNaoCompareceu(id, user) {
  const record = getRecordById_(id);
  if (!record || !can_(user, 'presenca.mark', record)) throw new Error('Seu perfil não pode marcar não comparecimento.');
  savePresenceHistory_(record, 'Não', user, 'Check-in marcado como não');
  return updateAgendamentoFields_(id, { StatusAgenda: 'Não Compareceu', Compareceu: 'Não', UltimaAtualizacao: new Date() }, user, 'CHECKIN_NAO', 'Não comparecimento marcado com sucesso.');
}

function marcarCompraStatus(id, comprou, user) {
  validarUser_(user);
  const record = getRecordById_(id);
  if (!record) throw new Error('Agendamento não encontrado.');
  if (!can_(user, 'purchase.mark', record)) throw new Error('Seu perfil não pode marcar resultado de compra.');

  const valorVenda = comprou ? numberSafe_(record.ValorVenda) : 0;
  const changes = {
    Compareceu: 'Sim',
    AtendimentoRealizado: 'Sim',
    VendaGerada: comprou ? 'Sim' : 'Não',
    StatusAgenda: comprou ? 'Concluído' : 'Compareceu',
    UltimaAtualizacao: new Date()
  };

  if (!comprou) {
    changes.ValorVenda = 0;
    changes.Desconto = numberSafe_(record.Desconto);
  } else if (!valorVenda && user.permissions && user.permissions.canManageOS) {
    changes.ValorVenda = numberSafe_(record.ValorVenda);
  }

  return updateAgendamentoFields_(
    id,
    changes,
    user,
    comprou ? 'MARCAR_COMPROU' : 'MARCAR_NAO_COMPROU',
    comprou ? 'Compra marcada com sucesso.' : 'Atendimento sem compra marcado com sucesso.'
  );
}

function cancelarAgendamento(id, user) {
  const record = getRecordById_(id);
  const role = normalizeRole_(user && user.perfil);
  const isGerenteOwnStore = role === 'gerente de loja' && record && normalizeText_(record.Loja) === normalizeText_(user && user.loja);
  if (!record || !(['admin', 'atendimento central'].indexOf(role) > -1 || isGerenteOwnStore)) throw new Error('Apenas Admin, Atendimento Central e Gerente de Loja podem cancelar agendamentos.');
  return updateAgendamentoFields_(id, { StatusAgenda: 'Cancelado', UltimaAtualizacao: new Date() }, user, 'CANCELAR', 'Agendamento cancelado com sucesso.');
}

function excluirAgendamento(id, user) {
  const record = getRecordById_(id);
  const role = normalizeRole_(user && user.perfil);
  const isGerenteOwnStore = role === 'gerente de loja' && record && normalizeText_(record.Loja) === normalizeText_(user && user.loja);
  if (!record || !(['admin', 'atendimento central'].indexOf(role) > -1 || isGerenteOwnStore)) throw new Error('Apenas Admin, Atendimento Central e Gerente de Loja podem excluir agendamentos.');
  getSheet_(SHEETS.agendamentos).deleteRow(record.__rowNumber);
  registrarSincronizacao_('EXCLUSAO', 'Agendamento excluído: ' + id, user.email);
  logAudit_('agendamento', id, 'DELETE', 'registro', JSON.stringify(record), '', user);
  return { ok: true, message: 'Agendamento excluído com sucesso.' };
}

function updateRow(payload, user) {
  ensureSystemStructure_();

  if (!user) throw new Error('Usuário não informado.');
  payload = payload || {};

  var id = normalizeText_(payload.id || payload.ID);
  if (!id) throw new Error('ID do agendamento não informado.');

  var sh = getSheet_(SHEETS.agendamentos);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_);

  var values = sh.getDataRange().getValues();
  var rowNumber = -1;

  for (var i = 1; i < values.length; i++) {
    if (normalizeText_(values[i][0]) === id) {
      rowNumber = i + 1;
      break;
    }
  }

  if (rowNumber === -1) throw new Error('Agendamento não encontrado: ' + id);

  var atual = {};
  headers.forEach(function(h, idx) {
    atual[h] = values[rowNumber - 1][idx];
  });

  if (!can_(user, 'agendamento.edit', serializeAgendamento_(Object.assign({ __rowNumber: rowNumber }, atual))) &&
      !can_(user, 'os.edit', serializeAgendamento_(Object.assign({ __rowNumber: rowNumber }, atual))) &&
      !can_(user, 'os.update_status', serializeAgendamento_(Object.assign({ __rowNumber: rowNumber }, atual)))) {
    throw new Error('Seu perfil não pode editar este registro.');
  }

  var novoHorario = payload.horario !== undefined ? normalizeHourValue_(payload.horario) : normalizeHourValue_(atual.Horario);
  var novaDataAgendamento = payload.dataAgendamento !== undefined ? normalizeText_(payload.dataAgendamento) : normalizeText_(atual.DataAgendamento);
  var novaLoja = payload.loja !== undefined ? normalizeText_(payload.loja) : normalizeText_(atual.Loja);
  var novoOptometrista = payload.optometrista !== undefined ? normalizeText_(payload.optometrista) : normalizeText_(atual.Optometrista);

  if (payload.horario !== undefined || payload.dataAgendamento !== undefined || payload.loja !== undefined || payload.optometrista !== undefined) {
    if (!novoHorario) throw new Error('Horário inválido.');
    validarHorarioPermitido_(novaDataAgendamento, novoHorario);
    validarFeriado_(novaDataAgendamento);
    validarConflitoHorario_({
      id: id,
      loja: novaLoja,
      optometrista: novoOptometrista,
      dataAgendamento: novaDataAgendamento,
      horario: novoHorario
    });
  }

  function setCampo(nome, valor) {
    var idx = headers.indexOf(nome);
    if (idx > -1) {
      sh.getRange(rowNumber, idx + 1).setValue(valor);
    }
  }

  if (payload.origem !== undefined) setCampo('Origem', normalizeText_(payload.origem));
  if (payload.nomeCompleto !== undefined) setCampo('NomeCompleto', normalizeText_(payload.nomeCompleto));
  if (payload.whatsApp !== undefined) setCampo('WhatsApp', normalizeText_(payload.whatsApp));
  if (payload.email !== undefined) setCampo('Email', normalizeText_(payload.email));
  if (payload.loja !== undefined) setCampo('Loja', novaLoja);
  if (payload.optometrista !== undefined) setCampo('Optometrista', novoOptometrista);
  if (payload.dataAgendamento !== undefined) setCampo('DataAgendamento', novaDataAgendamento);
  if (payload.horario !== undefined) setCampo('Horario', novoHorario); // <- corrigido
  if (payload.observacao !== undefined) setCampo('Observacao', normalizeText_(payload.observacao));
  if (payload.statusAgenda !== undefined) setCampo('StatusAgenda', normalizeText_(payload.statusAgenda));
  if (payload.compareceu !== undefined) setCampo('Compareceu', payload.compareceu);
  if (payload.atendimentoRealizado !== undefined) setCampo('AtendimentoRealizado', payload.atendimentoRealizado);
  if (payload.vendaGerada !== undefined) setCampo('VendaGerada', payload.vendaGerada);
  if (payload.valorVenda !== undefined) setCampo('ValorVenda', payload.valorVenda);
  if (payload.motivoPerda !== undefined) setCampo('MotivoPerda', normalizeText_(payload.motivoPerda));
  if (payload.consultorResponsavel !== undefined) setCampo('ConsultorResponsavel', normalizeText_(payload.consultorResponsavel));
  if (payload.numeroOS !== undefined) setCampo('NumeroOS', normalizeText_(payload.numeroOS));
  if (payload.dataAberturaOS !== undefined) setCampo('DataAberturaOS', normalizeText_(payload.dataAberturaOS));
  if (payload.dataEntradaOS !== undefined) setCampo('DataEntradaOS', normalizeText_(payload.dataEntradaOS));
  if (payload.dataFinalizacaoOS !== undefined) setCampo('DataFinalizacaoOS', normalizeText_(payload.dataFinalizacaoOS));
  if (payload.dataEntregaOS !== undefined) setCampo('DataEntregaOS', normalizeText_(payload.dataEntregaOS));
  if (payload.statusOS !== undefined) setCampo('StatusOS', normalizeText_(payload.statusOS));
  if (payload.accessTags !== undefined) setCampo('AccessTags', normalizeText_(payload.accessTags));
  if (payload.desconto !== undefined) setCampo('Desconto', payload.desconto);
  if (payload.vendedorNome !== undefined) setCampo('VendedorNome', normalizeText_(payload.vendedorNome));

  setCampo('UltimaAtualizacao', new Date());

  registrarSincronizacao_('AGENDAMENTO_EDITADO', 'Agendamento atualizado: ' + id, normalizeText_(user.email || user.nome));

  return {
    ok: true,
    message: 'Registro atualizado com sucesso.',
    id: id,
    horario: novoHorario
  };
}

function toCamelField_(field) {
  return String(field || '').charAt(0).toLowerCase() + String(field || '').slice(1);
}

function salvarOS(payload, user) {
  validarUser_(user);
  payload = payload || {};
  const record = getRecordById_(payload.id);
  if (!record) throw new Error('Agendamento não encontrado.');
  if (!can_(user, 'os.edit', record) && !can_(user, 'os.create', record) && !can_(user, 'os.update_status', record)) throw new Error('Seu perfil não pode gerenciar OS.');

  const changes = {
    NumeroOS: normalizeText_(payload.numeroOS),
    DataAberturaOS: normalizeText_(payload.dataAberturaOS),
    DataEntradaOS: normalizeText_(payload.dataEntradaOS),
    DataFinalizacaoOS: normalizeText_(payload.dataFinalizacaoOS),
    DataEntregaOS: normalizeText_(payload.dataEntregaOS),
    StatusOS: normalizeText_(payload.statusOS),
    VendedorNome: normalizeText_(payload.vendedorNome || record.VendedorNome || user.nome),
    Desconto: numberSafe_(payload.desconto),
    ValorVenda: numberSafe_(payload.valorVenda),
    UltimaAtualizacao: new Date()
  };

  if (changes.NumeroOS && !changes.StatusOS) {
    changes.StatusOS = 'Aberta';
  }
  if (changes.NumeroOS && !changes.DataAberturaOS && !record.DataAberturaOS) {
    changes.DataAberturaOS = Utilities.formatDate(new Date(), 'America/Sao_Paulo'
, 'yyyy-MM-dd');
  }
  if (changes.NumeroOS && (changes.DataEntradaOS || record.DataEntradaOS) && !changes.DataFinalizacaoOS) {
    changes.StatusAgenda = 'OS em Andamento';
    if (!changes.StatusOS) changes.StatusOS = 'Em produção';
  }
  if (changes.DataFinalizacaoOS) {
    changes.StatusAgenda = 'Concluído';
    changes.AtendimentoRealizado = 'Sim';
    if (!changes.StatusOS) changes.StatusOS = 'Concluído';
  }
  if (changes.ValorVenda > 0) {
    changes.VendaGerada = 'Sim';
    if (!changes.StatusAgenda) changes.StatusAgenda = 'Concluído';
  } else if (payload.valorVenda !== undefined && numberSafe_(payload.valorVenda) === 0) {
    changes.VendaGerada = 'Não';
  }

  return updateAgendamentoFields_(payload.id, changes, user, 'SALVAR_OS', 'OS atualizada com sucesso.');
}

// ═══════════════════════════════════════════════════════════════
//  DASHBOARD, RELATÓRIOS E FINANCEIRO
// ═══════════════════════════════════════════════════════════════

function metricsWindow_(rows, days) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1);
  const opened = rows.filter(function(r) { const d = parseDateSafe_(r.DataAberturaOS || r.DataCadastro); return d && d >= start; }).length;
  const finalized = rows.filter(function(r) { const d = parseDateSafe_(r.DataFinalizacaoOS); return d && d >= start; }).length;
  return { opened: opened, finalized: finalized };
}

function buildDashboard_(user, agendamentos) {
  const ag = agendamentos.filter(function(r) { return ['Agendado', 'Confirmado'].indexOf(r.StatusAgenda) > -1; }).length;
  const compareceram = agendamentos.filter(function(r) { return (r.Compareceu || '').toLowerCase() === 'sim' || r.StatusAgenda === 'Compareceu'; }).length;
  const naoCompareceram = agendamentos.filter(function(r) { return r.StatusAgenda === 'Não Compareceu' || (r.Compareceu || '').toLowerCase() === 'não'; }).length;
  const concluidos = agendamentos.filter(function(r) { return r.StatusAgenda === 'Concluído'; }).length;
  const osAtivas = agendamentos.filter(function(r) { return r.StatusAgenda === 'OS em Andamento' || (!!r.NumeroOS && !r.DataFinalizacaoOS); }).length;
  const atrasadas = agendamentos.filter(function(r) { return r.IsOverdue; }).length;
  const faturamento = agendamentos.reduce(function(a, b) { return a + numberSafe_(b.ValorVenda); }, 0);
  const taxaComparecimento = ag ? Math.round((compareceram / ag) * 100) : 0;
  const origemCount = {};
  agendamentos.forEach(function(r) { if (r.Origem) origemCount[r.Origem] = (origemCount[r.Origem] || 0) + 1; });
  const origemTop = Object.keys(origemCount).sort(function(a, b) { return origemCount[b] - origemCount[a]; })[0] || '—';
  const role = normalizeRole_(user.perfil);
  const dashboard = { agendados: ag, compareceram: compareceram, naoCompareceram: naoCompareceram, concluidos: concluidos, osAtivas: osAtivas, atrasadas: atrasadas, taxaComparecimento: taxaComparecimento, origemTop: origemTop };
  if (user.permissions.canViewFinance) dashboard.faturamento = faturamento;
  if (['admin', 'atendimento central', 'gerente de loja'].indexOf(role) > -1) {
    dashboard.os7 = metricsWindow_(agendamentos, 7);
    dashboard.os15 = metricsWindow_(agendamentos, 15);
    dashboard.os30 = metricsWindow_(agendamentos, 30);
    dashboard.os45 = metricsWindow_(agendamentos, 45);
    dashboard.os90 = metricsWindow_(agendamentos, 90);
    dashboard.os120 = metricsWindow_(agendamentos, 120);
  }
  return dashboard;
}

function getDashboard(user) {
  const rows = getAgendamentos(user, {});
  return toJsonSafe_(buildDashboard_(user, rows));
}

function getFinancePanel(user, filtros) {
  if (!(user && user.permissions && user.permissions.canViewFinance)) throw new Error('Acesso negado ao módulo de faturamento.');
  const rows = getRowsAsObjects_(SHEETS.agendamentos).map(serializeAgendamento_);
  const visible = applyVisibility_(user, rows, filtros || {});
  const total = visible.reduce(function(a, b) { return a + numberSafe_(b.ValorVenda); }, 0);
  const totalDesconto = visible.reduce(function(a, b) { return a + numberSafe_(b.Desconto); }, 0);
  const tickets = visible.filter(function(r) { return numberSafe_(r.ValorVenda) > 0; });
  const media = tickets.length ? total / tickets.length : 0;
  return toJsonSafe_({
    totalFaturado: total,
    totalDesconto: totalDesconto,
    totalOSComValor: tickets.length,
    ticketMedio: media,
    rows: visible.map(function(r) {
      return {
        ID: r.ID,
        Cliente: r.NomeCompleto,
        NumeroOS: r.NumeroOS,
        StatusOS: r.StatusOS,
        ValorVenda: r.ValorVenda,
        Desconto: r.Desconto,
        VendedorNome: r.VendedorNome,
        ProprietarioNome: r.ProprietarioNome,
        Loja: r.Loja,
        DataFinalizacaoOS: r.DataFinalizacaoOSBR || formatDateBR_(r.DataFinalizacaoOS)
      };
    })
  });
}

function exportFinanceCSV(filtros, user) {
  if (!(user && user.permissions && user.permissions.canExportFinance)) throw new Error('Acesso negado à exportação financeira.');
  const panel = getFinancePanel(user, filtros || {});
  const headers = ['ID', 'Cliente', 'NumeroOS', 'StatusOS', 'ValorVenda', 'Desconto', 'VendedorNome', 'Proprietario', 'Loja', 'DataFinalizacaoOS'];
  const data = panel.rows.map(function(r) { return [r.ID, r.Cliente, r.NumeroOS, r.StatusOS, r.ValorVenda, r.Desconto, r.VendedorNome, r.ProprietarioNome, r.Loja, r.DataFinalizacaoOS]; });
  const csv = [headers].concat(data).map(function(row) { return row.map(csvCell_).join(','); }).join('\n');
  return { ok: true, csv: csv, fileName: 'relatorio_faturamento.csv' };
}

function csvCell_(v) {
  return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
}

function getLeadTimeReport(user, filtros) {
  const role = normalizeRole_(user && user.perfil);
  if (['admin', 'atendimento central', 'gerente de loja'].indexOf(role) === -1) throw new Error('Acesso negado ao relatório de lead time.');
  let rows = getAgendamentos(user, filtros || {}).filter(function(r) { return !!r.DataAberturaOS; });
  if (normalizeText_(filtros && filtros.ownerId)) rows = rows.filter(function(r) { return r.ProprietarioId === normalizeText_(filtros.ownerId); });
  if (normalizeText_(filtros && filtros.loja)) rows = rows.filter(function(r) { return r.Loja === normalizeText_(filtros.loja); });
  const enriched = rows.map(function(r) {
    return { ID: r.ID, Cliente: r.NomeCompleto, Loja: r.Loja, Vendedor: r.ProprietarioNome, NumeroOS: r.NumeroOS, Abertura: r.DataAberturaOSBR || formatDateBR_(r.DataAberturaOS), Finalizacao: r.DataFinalizacaoOSBR || formatDateBR_(r.DataFinalizacaoOS), LeadTimeDias: diffDays_(r.DataAberturaOS, r.DataFinalizacaoOS) };
  });
  const valid = enriched.filter(function(r) { return r.LeadTimeDias !== ''; });
  const avg = valid.length ? valid.reduce(function(a, b) { return a + numberSafe_(b.LeadTimeDias); }, 0) / valid.length : 0;
  return toJsonSafe_({ mediaLeadTime: avg, totalLinhas: enriched.length, rows: enriched });
}

function gerarRelatorioCSV(filtros, user) {
  const rows = getAgendamentos(user, filtros || {});
  const headers = ['ID', 'Cliente', 'Proprietario', 'StatusAgendamento', 'Presenca', 'NumeroOS', 'StatusOS', 'DataAberturaOS', 'DataFinalizacaoOS', 'DataEntregaOS', 'Loja', 'Optometrista', 'LeadTimeDias'];
  const data = rows.map(function(r) { return [r.ID, r.NomeCompleto, r.ProprietarioNome, r.StatusAgenda, r.Compareceu, r.NumeroOS, r.StatusOS, r.DataAberturaOS, r.DataFinalizacaoOS, r.DataEntregaOS, r.Loja, r.Optometrista, r.LeadTimeDias]; });
  const csv = [headers].concat(data).map(function(row) { return row.map(csvCell_).join(','); }).join('\n');
  registrarSincronizacao_('RELATORIO', 'Relatório CSV gerado.', user && user.email ? user.email : 'sistema');
  return { ok: true, csv: csv, fileName: 'relatorio_sistema_agendamento.csv' };
}

// ═══════════════════════════════════════════════════════════════
//  ROI
// ═══════════════════════════════════════════════════════════════

function getRoiData(diasHistorico, emailUsuario) {
  ensureSystemStructure_();
  diasHistorico = Number(diasHistorico || 30);
  emailUsuario = emailUsuario || 'sistema@local';
  registrarSincronizacao_('ROI_ACESSO', 'AdAnalyzer consultado', emailUsuario);

  const hoje = new Date();
  const inicio = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() - diasHistorico + 1);
  const inicioStr = Utilities.formatDate(inicio, 'America/Sao_Paulo'
, 'yyyy-MM-dd');
  const hojeStr = Utilities.formatDate(hoje, 'America/Sao_Paulo'
, 'yyyy-MM-dd');
  const todos = getRowsAsObjects_(SHEETS.agendamentos).map(serializeAgendamento_).filter(function(r) {
    const data = formatDateOnly_(r.DataCadastro || r.DataAgendamento);
    return data >= inicioStr && data <= hojeStr;
  });

  const plataformas = {
    meta: criarEstruturaPlatforma_('Meta Ads (Facebook + Instagram)'),
    google: criarEstruturaPlatforma_('Google Ads (Site + Orgânico)'),
    outros: criarEstruturaPlatforma_('Outras origens')
  };

  todos.forEach(function(r) {
    const tags = splitTags_(r.AccessTags || '');
    const plat = detectarPlataforma_(tags);
    const loja = normalizeText_(r.Loja) || 'Sem loja';
    const verde = r.AtendimentoSemaforo === 'verde';
    const valor = numberSafe_(r.ValorVenda);
    const p = plataformas[plat];
    p.leads++;
    if (!p.lojas[loja]) p.lojas[loja] = { leads: 0, compareceram: 0, convertidos: 0, receita: 0 };
    p.lojas[loja].leads++;
    const comp = normalizeText_(r.Compareceu).toLowerCase();
    if (comp === 'sim' || r.StatusAgenda === 'Compareceu' || r.StatusAgenda === 'Concluído') {
      p.compareceram++;
      p.lojas[loja].compareceram++;
    }
    if (verde || valor > 0) {
      p.convertidos++;
      p.receita += valor;
      p.lojas[loja].convertidos++;
      p.lojas[loja].receita += valor;
    }
    tags.forEach(function(t) { p.origensEncontradas[t] = (p.origensEncontradas[t] || 0) + 1; });
  });

  Object.keys(plataformas).forEach(function(k) { calcularMetricasPlataforma_(plataformas[k]); });
  const totalLeads = todos.length;
  const totalConv = Object.keys(plataformas).reduce(function(s, k) { return s + plataformas[k].convertidos; }, 0);
  const totalReceita = Object.keys(plataformas).reduce(function(s, k) { return s + plataformas[k].receita; }, 0);
  const totalComparec = Object.keys(plataformas).reduce(function(s, k) { return s + plataformas[k].compareceram; }, 0);

  return {
    formato: 'roi',
    sistema: PROJECT_NAME,
    versao: SERVER_VERSION,
    geradoEm: new Date().toISOString(),
    acessadoPor: emailUsuario,
    periodo: { diasHistorico: diasHistorico, de: inicioStr, ate: hojeStr },
    resumo: {
      totalLeads: totalLeads,
      totalCompareceram: totalComparec,
      totalConvertidos: totalConv,
      totalReceita: Math.round(totalReceita * 100) / 100,
      ticketMedio: totalConv > 0 ? Math.round((totalReceita / totalConv) * 100) / 100 : 0,
      taxaConversaoGeral: totalLeads > 0 ? Math.round((totalConv / totalLeads) * 10000) / 100 : 0
    },
    plataformas: plataformas
  };
}

function criarEstruturaPlatforma_(nome) {
  return { nome: nome, leads: 0, compareceram: 0, convertidos: 0, receita: 0, taxaConversao: 0, taxaComparecimento: 0, ticketMedio: 0, lojas: {}, origensEncontradas: {} };
}

function detectarPlataforma_(tags) {
  for (let i = 0; i < tags.length; i++) {
    if (ROI_PLATAFORMAS.meta.indexOf(tags[i]) > -1) return 'meta';
    if (ROI_PLATAFORMAS.google.indexOf(tags[i]) > -1) return 'google';
  }
  return 'outros';
}

function calcularMetricasPlataforma_(p) {
  p.taxaConversao = p.leads > 0 ? Math.round((p.convertidos / p.leads) * 10000) / 100 : 0;
  p.taxaComparecimento = p.leads > 0 ? Math.round((p.compareceram / p.leads) * 10000) / 100 : 0;
  p.ticketMedio = p.convertidos > 0 ? Math.round((p.receita / p.convertidos) * 100) / 100 : 0;
  Object.keys(p.lojas).forEach(function(loja) {
    const l = p.lojas[loja];
    l.taxaConversao = l.leads > 0 ? Math.round((l.convertidos / l.leads) * 10000) / 100 : 0;
    l.taxaComparecimento = l.leads > 0 ? Math.round((l.compareceram / l.leads) * 10000) / 100 : 0;
    l.ticketMedio = l.convertidos > 0 ? Math.round((l.receita / l.convertidos) * 100) / 100 : 0;
  });
}

// ═══════════════════════════════════════════════════════════════
//  KOMMO
// ═══════════════════════════════════════════════════════════════

function kommoApiRequest_(method, path, payload) {
  const token = getKommoAccessToken_();
  if (!token) throw new Error('KOMMO_ACCESS_TOKEN não configurado em PropertiesService.');
  const url = 'https://' + KOMMO.account + '.kommo.com/api/v4' + path;
  const options = {
    method: method,
    muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  };
  if (payload !== undefined && payload !== null) options.payload = JSON.stringify(payload);
  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
  if (code < 200 || code >= 300) throw new Error('Erro Kommo API ' + code + ': ' + text);
  return json;
}

function kommoGetPipelineByLoja_(loja) {
  return KOMMO_MAPA_LOJAS[normalizeText_(loja)] || null;
}

function kommoStatusIdPorStatusAgenda_(statusAgenda, loja) {
  const mapaLoja = kommoGetPipelineByLoja_(loja);
  const mapa = mapaLoja || KOMMO.etapas;
  const status = normalizeText_(statusAgenda).toLowerCase();
  if (status === 'agendado') return mapa.agendado;
  if (status === 'confirmado') return mapa.confirmado;
  if (status === 'compareceu') return mapa.compareceu;
  if (status === 'não compareceu' || status === 'nao compareceu') return mapa.naoCompareceu;
  if (status === 'concluído' || status === 'concluido') return mapa.concluido;
  if (status === 'cancelado') return mapa.cancelado;
  return mapa.agendado;
}

function kommoCriarLead_(payload) {
  const lojaInfo = kommoGetPipelineByLoja_(payload.loja);
  if (!lojaInfo) throw new Error('Loja não mapeada no Kommo: ' + payload.loja);
  const lead = {
    name: normalizeText_(payload.nomeCompleto || 'Novo agendamento'),
    pipeline_id: lojaInfo.pipeline,
    status_id: lojaInfo.agendado,
    custom_fields_values: []
  };
  const result = kommoApiRequest_('post', '/leads', [lead]);
  const leadId = result && result._embedded && result._embedded.leads && result._embedded.leads[0] && result._embedded.leads[0].id;
  return leadId || '';
}

function kommoAtualizarEtapa_(leadId, statusAgenda, loja) {
  if (!leadId) return false;
  const lojaInfo = kommoGetPipelineByLoja_(loja);
  const statusId = kommoStatusIdPorStatusAgenda_(statusAgenda, loja);
  const payload = [{ id: Number(leadId), status_id: Number(statusId) }];
  if (lojaInfo && lojaInfo.pipeline) payload[0].pipeline_id = Number(lojaInfo.pipeline);
  kommoApiRequest_('patch', '/leads', payload);
  return true;
}

function getKommoLeadId_(idAgendamento) {
  const record = getRecordById_(idAgendamento);
  return record ? normalizeText_(record.KommoLeadId) : '';
}

function salvarKommoLeadId_(idAgendamento, leadId) {
  const sh = getSheet_(SHEETS.agendamentos);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_);
  const col = headers.indexOf('KommoLeadId');
  if (col === -1) throw new Error('Coluna KommoLeadId não encontrada.');
  const record = getRecordById_(idAgendamento);
  if (!record) throw new Error('Agendamento não encontrado para salvar KommoLeadId.');
  sh.getRange(record.__rowNumber, col + 1).setValue(String(leadId));
}

function processarWebhookKommo_(body) {
  return { recebido: true, bodyKeys: Object.keys(body || {}) };
}

function kommoHandleOAuthCallback_(code) {
  try {
    const clientId = getKommoClientId_();
    const clientSecret = getKommoClientSecret_();
    const redirectUri = getGasDeployUrl_();
    if (!clientId || !clientSecret || !redirectUri) {
      return HtmlService.createHtmlOutput('Configure KOMMO_CLIENT_ID, KOMMO_CLIENT_SECRET e GAS_DEPLOY_URL em PropertiesService.');
    }
    const url = 'https://' + KOMMO.account + '.kommo.com/oauth2/access_token';
    const payload = {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri
    };
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify(payload)
    });
    const json = JSON.parse(res.getContentText() || '{}');
    if (json.access_token) setScriptSecret_('KOMMO_ACCESS_TOKEN', json.access_token);
    if (json.refresh_token) setScriptSecret_('KOMMO_REFRESH_TOKEN', json.refresh_token);
    return HtmlService.createHtmlOutput('OAuth Kommo concluído. Token salvo em PropertiesService.');
  } catch (err) {
    return HtmlService.createHtmlOutput('Erro OAuth Kommo: ' + (err.message || String(err)));
  }
}

function testarKommoConexao() {
  try {
    return { ok: true, account: kommoApiRequest_('get', '/account', null) };
  } catch (err) {
    return { ok: false, erro: err.message || String(err) };
  }
}

// ═══════════════════════════════════════════════════════════════
//  PÁGINA PÚBLICA SIMPLES
// ═══════════════════════════════════════════════════════════════



function getSystemUserForPublic_() {
  const users = getUsuariosAtivos_();
  const central = users.find(function(u) { return normalizeRole_(u.Perfil) === 'atendimento central'; }) || users.find(function(u) { return normalizeRole_(u.Perfil) === 'admin'; });
  if (central) return getUserContext_(central.Email);
  return {
    id: 'PUBLICO',
    nome: 'Agendamento Público',
    email: 'publico@sistema.local',
    perfil: 'atendimento central',
    loja: 'Todas',
    accessTags: ['origem:site'],
    permissions: {
      isAdmin: false,
      canViewAll: true,
      canCreateAgendamento: true,
      canDeleteAny: false,
      canCancelAny: false,
      canMarkPresence: false,
      canManageOS: false,
      canViewDashboardCentral: false,
      canViewCurrentMonthOnly: false,
      canViewMineOnly: false,
      canViewFinance: false,
      canExportFinance: false
    }
  };
}


function salvarAgendamentoPublico(payload) {
  ensureSystemStructure_();
  payload = payload || {};
  payload.origem = normalizeText_(payload.origem) || 'Site';
  payload.statusAgenda = normalizeText_(payload.statusAgenda) || 'Agendado';
  payload.accessTags = normalizeText_(payload.accessTags) || 'origem:site';
  payload.observacao = normalizeText_(payload.observacao) || 'Agendamento público via formulário.';

  const user = getSystemUserForPublic_();
  return salvarAgendamento(payload, user);
}

function paginaAgendamentoPublico_() {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Agendar Consulta</title><style>body{font-family:Arial;margin:0;background:#f6f7fb;color:#111}.wrap{max-width:720px;margin:40px auto;background:#fff;padding:24px;border-radius:16px;box-shadow:0 8px 30px #0001}label{display:block;margin-top:12px;font-weight:700}input,select,textarea,button{width:100%;box-sizing:border-box;padding:12px;margin-top:6px;border:1px solid #ddd;border-radius:10px}button{background:#111;color:#fff;border:0;margin-top:18px;cursor:pointer}.msg{margin-top:16px}</style></head>' +
    '<body><div class="wrap"><h1>Agendar Consulta</h1><form id="f">' +
    '<label>Nome completo<input name="nomeCompleto" required></label><label>WhatsApp<input name="whatsApp" required></label><label>E-mail<input name="email" type="email"></label>' +
    '<label>Loja<input name="loja" required placeholder="Digite exatamente o nome da loja"></label><label>Optometrista<input name="optometrista" required></label>' +
    '<label>Data<input name="dataAgendamento" type="date" required></label><label>Horário<input name="horario" type="time" required></label><label>Observação<textarea name="observacao"></textarea></label>' +
    '<button type="submit">Enviar agendamento</button><div class="msg" id="msg"></div></form></div>' +
    '<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();var o={};new FormData(e.target).forEach(function(v,k){o[k]=v});document.getElementById("msg").textContent="Enviando...";google.script.run.withSuccessHandler(function(r){document.getElementById("msg").textContent=r&&r.ok?"Agendamento enviado com sucesso.":"Erro ao enviar.";if(r&&r.ok)e.target.reset();}).withFailureHandler(function(err){document.getElementById("msg").textContent=err.message||err;}).salvarAgendamentoPublico(o);});</script></body></html>';
}

function sincronizarTudoSistema() {
  ensureSystemStructure_();
  return {
    ok: true,
    message: 'Estrutura, abas e cabeçalhos conferidos com sucesso.',
    version: SERVER_VERSION,
    spreadsheetId: SPREADSHEET_ID
  };
}

function paginaFallback_() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + PROJECT_NAME + '</title></head><body style="font-family:Arial;padding:24px"><h1>' + PROJECT_NAME + '</h1><p>Backend ativo. Crie o arquivo HTML <b>index</b> para carregar o frontend principal.</p><p>Versão: ' + SERVER_VERSION + '</p></body></html>';
}

// ═══════════════════════════════════════════════════════════════
//  TESTES E DIAGNÓSTICO
// ═══════════════════════════════════════════════════════════════


function getHistoricoOperacional(user, filtros) {
  validarUser_(user);
  filtros = filtros || {};
  const role = normalizeRole_(user.perfil);
  if (['admin', 'gerente de loja'].indexOf(role) === -1) throw new Error('Acesso negado ao histórico operacional.');

  const lojaFiltro = role === 'gerente de loja' ? normalizeText_(user.loja) : normalizeText_(filtros.loja);
  const limit = Math.max(1, Math.min(500, numberSafe_(filtros.limit || 200)));

  const agMap = {};
  getRowsAsObjects_(SHEETS.agendamentos).map(serializeAgendamento_).forEach(function(r) { agMap[String(r.ID)] = r; });

  const osRows = getRowsAsObjects_(SHEETS.ordens_servico);
  const osByAg = {};
  osRows.forEach(function(r) { if (normalizeText_(r.IdAgendamento)) osByAg[String(r.IdAgendamento)] = r; });

  const items = [];

  getRowsAsObjects_(SHEETS.auditoria_eventos).forEach(function(r) {
    var loja = '';
    var cliente = '';
    var entidade = normalizeText_(r.Entidade).toLowerCase();
    var idEntidade = normalizeText_(r.IdEntidade);

    if (entidade === 'agendamento' && agMap[idEntidade]) {
      loja = normalizeText_(agMap[idEntidade].Loja);
      cliente = normalizeText_(agMap[idEntidade].NomeCompleto);
    } else if (entidade === 'os') {
      var os = osRows.find(function(x) { return normalizeText_(x.IdOSInterno) === idEntidade || normalizeText_(x.IdAgendamento) === idEntidade; });
      if (os) {
        loja = normalizeText_(os.Loja);
        cliente = normalizeText_(os.Cliente);
      }
    }

    if (lojaFiltro && loja !== lojaFiltro) return;

    items.push({
      DataEvento: serializarValor_(r.DataEvento),
      Loja: loja,
      Cliente: cliente,
      Tipo: 'Auditoria',
      Entidade: normalizeText_(r.Entidade),
      Acao: normalizeText_(r.Acao),
      Campo: normalizeText_(r.CampoAlterado),
      ValorAnterior: serializarValor_(r.ValorAnterior),
      ValorNovo: serializarValor_(r.ValorNovo),
      ExecutadoPor: normalizeText_(r.ExecutadoPorNome),
      Perfil: normalizeText_(r.Perfil)
    });
  });

  getRowsAsObjects_(SHEETS.presencas).forEach(function(r) {
    var ag = agMap[String(normalizeText_(r.IdAgendamento))];
    var loja = ag ? normalizeText_(ag.Loja) : '';
    if (lojaFiltro && loja !== lojaFiltro) return;

    items.push({
      DataEvento: serializarValor_(r.DataMarcacao),
      Loja: loja,
      Cliente: normalizeText_(r.Cliente),
      Tipo: 'Presença',
      Entidade: 'presenca',
      Acao: normalizeText_(r.StatusPresenca),
      Campo: '',
      ValorAnterior: '',
      ValorNovo: normalizeText_(r.StatusPresenca),
      ExecutadoPor: normalizeText_(r.MarcadoPorNome),
      Perfil: normalizeText_(r.PerfilMarcador)
    });
  });

  items.sort(function(a, b) {
    return String(b.DataEvento || '').localeCompare(String(a.DataEvento || ''));
  });

  return toJsonSafe_({ ok: true, rows: items.slice(0, limit) });
}

function testarBackend() {
  try {
    ensureSystemStructure_();
    return toJsonSafe_({
      ok: true,
      projeto: PROJECT_NAME,
      versao: getBusinessRules_().versaoServidor,
      spreadsheetId: SPREADSHEET_ID,
      lojas: getLojas(),
      origens: getOrigens(),
      owners: getOwners_(),
      accessTags: getAccessTags_(),
      totalUsuariosAtivos: getUsuariosAtivos_().length,
      totalAgendamentos: getRowsAsObjects_(SHEETS.agendamentos).length
    });
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

function testarPermissoes(email) {
  try {
    ensureSystemStructure_();
    const user = getUserContext_(email || Session.getActiveUser().getEmail());
    if (!user) return { ok: false, erro: 'Usuário não encontrado ou inativo.' };
    const rows = getAgendamentos(user, {});
    return toJsonSafe_({
      ok: true,
      usuario: { id: user.id, nome: user.nome, email: user.email, perfil: user.perfil, loja: user.loja, permissions: user.permissions },
      totalVisivel: rows.length,
      amostra: rows.slice(0, 5)
    });
  } catch (err) {
    return { ok: false, erro: err.message || String(err) };
  }
}

function instalarSistema() {
  ensureSystemStructure_();
  return testarBackend();
}

function configurarSegredosKommo(clientId, clientSecret, accessToken, webhookSecret, gasDeployUrl) {
  if (clientId) setScriptSecret_('KOMMO_CLIENT_ID', clientId);
  if (clientSecret) setScriptSecret_('KOMMO_CLIENT_SECRET', clientSecret);
  if (accessToken) setScriptSecret_('KOMMO_ACCESS_TOKEN', accessToken);
  if (webhookSecret) setScriptSecret_('KOMMO_WEBHOOK_SECRET', webhookSecret);
  if (gasDeployUrl) setScriptSecret_('GAS_DEPLOY_URL', gasDeployUrl);
  return { ok: true, message: 'Segredos configurados.' };
}





function atualizarPlanilhaSistemaCompleto() {
  ensureSystemStructure_();
  corrigirHorariosPlanilha_();
  corrigirFormatoHorarioPlanilhaSP_();
  sincronizarUsuariosPermissoesLojas_();
  sincronizarLojasOptometristas_();
  normalizarAgendamentosLoja_();
  recalcularLeadTimePlanilha_();
  atualizarVersaoServidorConfig_();
  registrarSincronizacao_('MIGRACAO', 'Planilha atualizada para a versão ' + SERVER_VERSION, 'sistema');
  return { ok: true, message: 'Planilha e abas atualizadas com sucesso.', versao: SERVER_VERSION };
}

function corrigirFormatoHorarioPlanilhaSP_() {
  var sh = getSheet_(SHEETS.configuracoes);
  var values = sh.getDataRange().getValues();
  if (!values.length) return;
  var headers = values[0].map(normalizeText_);
  var idxChave = headers.indexOf('Chave');
  var idxValor = headers.indexOf('Valor');
  if (idxChave === -1 || idxValor === -1) return;
  var horarios = {
    seg_sex_inicio: '10:00',
    seg_sex_fim: '18:00',
    sab_inicio: '10:00',
    sab_fim: '16:00',
    domingo_bloqueado: 'Sim'
  };
  var seen = {};
  for (var i = 1; i < values.length; i++) {
    var chave = normalizeText_(values[i][idxChave]);
    if (Object.prototype.hasOwnProperty.call(horarios, chave)) {
      sh.getRange(i + 1, idxValor + 1).setValue(horarios[chave]).setNumberFormat('@STRING@');
      seen[chave] = true;
    }
  }
  Object.keys(horarios).forEach(function(chave) {
    if (!seen[chave]) {
      var row = new Array(headers.length).fill('');
      row[idxChave] = chave;
      row[idxValor] = horarios[chave];
      sh.appendRow(row);
      sh.getRange(sh.getLastRow(), idxValor + 1).setNumberFormat('@STRING@');
    }
  });
}

function sincronizarUsuariosPermissoesLojas_() {
  ensureSheetWithHeaders_(SHEETS.usuarios, REQUIRED_HEADERS.usuarios);
  var sh = getSheet_(SHEETS.usuarios);
  var rows = sh.getDataRange().getValues();
  if (rows.length < 2) return;
  var headers = rows[0].map(normalizeText_);
  var map = {};
  headers.forEach(function(h, idx) { map[h] = idx + 1; });

  for (var i = 2; i <= sh.getLastRow(); i++) {
    var perfil = normalizeRole_(sh.getRange(i, map.Perfil).getValue());
    var email = normalizeText_(sh.getRange(i, map.Email).getValue());
    if (!normalizeText_(sh.getRange(i, map.IdUsuario).getValue()) && email) {
      sh.getRange(i, map.IdUsuario).setValue('USR-' + i);
    }
    if (!normalizeText_(sh.getRange(i, map.Ativo).getValue())) {
      sh.getRange(i, map.Ativo).setValue('Sim');
    }
    sh.getRange(i, map.CanViewFinance).setValue((perfil === 'admin' || perfil === 'gerente de loja') ? 'Sim' : 'Não');
  }
}

function sincronizarLojasOptometristas_() {
  seedDefaultsIfEmpty_();
}

function normalizarAgendamentosLoja_() {
  ensureSheetWithHeaders_(SHEETS.agendamentos, REQUIRED_HEADERS.agendamentos);
  var sh = getSheet_(SHEETS.agendamentos);
  if (sh.getLastRow() < 2) return;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_);
  var map = {};
  headers.forEach(function(h, idx) { map[h] = idx + 1; });
  for (var i = 2; i <= sh.getLastRow(); i++) {
    var loja = normalizeText_(sh.getRange(i, map.Loja).getValue());
    if (loja) sh.getRange(i, map.Loja).setValue(loja);
    if (!normalizeText_(sh.getRange(i, map.Desconto).getValue())) sh.getRange(i, map.Desconto).setValue(0);
    if (!normalizeText_(sh.getRange(i, map.LeadTimeDias).getValue())) {
      var ab = normalizeText_(sh.getRange(i, map.DataAberturaOS).getValue());
      var fi = normalizeText_(sh.getRange(i, map.DataFinalizacaoOS).getValue());
      var diff = diffDays_(ab, fi);
      if (diff !== '') sh.getRange(i, map.LeadTimeDias).setValue(diff);
    }
  }
}

function atualizarVersaoServidorConfig_() {
  var sh = getSheet_(SHEETS.configuracoes);
  var values = sh.getDataRange().getValues();
  var headers = values[0].map(normalizeText_);
  var idxChave = headers.indexOf('Chave');
  var idxValor = headers.indexOf('Valor');
  if (idxChave === -1 || idxValor === -1) return;
  var found = false;
  for (var i = 1; i < values.length; i++) {
    if (normalizeText_(values[i][idxChave]) === 'versao_servidor') {
      sh.getRange(i + 1, idxValor + 1).setValue(SERVER_VERSION).setNumberFormat('@STRING@');
      found = true;
      break;
    }
  }
  if (!found) {
    var row = new Array(headers.length).fill('');
    row[idxChave] = 'versao_servidor';
    row[idxValor] = SERVER_VERSION;
    sh.appendRow(row);
    sh.getRange(sh.getLastRow(), idxValor + 1).setNumberFormat('@STRING@');
  }
}
function recalcularLeadTimePlanilha_() {
  ensureSheetWithHeaders_(SHEETS.agendamentos, REQUIRED_HEADERS.agendamentos);
  ensureSheetWithHeaders_(SHEETS.ordens_servico, REQUIRED_HEADERS.ordens_servico);

  // AGENDAMENTOS
  var shAg = getSheet_(SHEETS.agendamentos);
  if (shAg.getLastRow() >= 2) {
    var headersAg = shAg.getRange(1, 1, 1, shAg.getLastColumn()).getValues()[0].map(normalizeText_);
    var mapAg = {};
    headersAg.forEach(function(h, idx) { mapAg[h] = idx + 1; });

    for (var i = 2; i <= shAg.getLastRow(); i++) {
      var aberturaAg = shAg.getRange(i, mapAg.DataAberturaOS).getValue();
      var finalizacaoAg = shAg.getRange(i, mapAg.DataFinalizacaoOS).getValue();
      var leadAg = diffDays_(aberturaAg, finalizacaoAg);

      if (mapAg.LeadTimeDias) {
        shAg.getRange(i, mapAg.LeadTimeDias).setValue(leadAg === '' ? '' : leadAg);
      }
    }
  }

  // ORDENS DE SERVIÇO
  var shOs = getSheet_(SHEETS.ordens_servico);
  if (shOs.getLastRow() >= 2) {
    var headersOs = shOs.getRange(1, 1, 1, shOs.getLastColumn()).getValues()[0].map(normalizeText_);
    var mapOs = {};
    headersOs.forEach(function(h, idx) { mapOs[h] = idx + 1; });

    for (var j = 2; j <= shOs.getLastRow(); j++) {
      var aberturaOs = shOs.getRange(j, mapOs.DataAberturaOS).getValue();
      var finalizacaoOs = shOs.getRange(j, mapOs.DataFinalizacaoOS).getValue();
      var leadOs = diffDays_(aberturaOs, finalizacaoOs);

      if (mapOs.LeadTimeDias) {
        shOs.getRange(j, mapOs.LeadTimeDias).setValue(leadOs === '' ? '' : leadOs);
      }
    }
  }
}
function validarToken_(e) {
  const tokenSistema = PropertiesService
    .getScriptProperties()
    .getProperty('CHAVE_API_SISTEMA');

  const tokenRecebido =
    e?.parameter?.token ||
    e?.postData?.contents && JSON.parse(e.postData.contents).token;

  if (!tokenSistema) {
    throw new Error('Token do sistema não configurado nas Propriedades do Script.');
  }

  if (!tokenRecebido || tokenRecebido !== tokenSistema) {
    return false;
  }

  return true;
}
function handleHttpApiCall_(params) {
  function saida_(data) {
    return ContentService.createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const fn      = normalizeText_(params.fn || '');
  const argsStr = params.args || '[]';
  let args;

  try { args = JSON.parse(argsStr); }
  catch (ex) { return saida_({ ok: false, error: 'args inválido' }); }

  const ALLOWED = {
    'loginSeguro'                    : loginSeguro,
    'getUsuarioLogado'               : getUsuarioLogado,
    'getInfoInicial'                 : getInfoInicial,
    'getAgendamentos'                : getAgendamentos,
    'getAgendamentosSeguro'          : getAgendamentosSeguro,
    'getDashboard'                   : getDashboard,
    'getFinancePanel'                : getFinancePanel,
    'getLeadTimeReport'              : getLeadTimeReport,
    'getHistoricoOperacional'        : getHistoricoOperacional,
    'getOptometristasPorLoja'        : getOptometristasPorLoja,
    'getLojas'                       : getLojas,
    'getOrigens'                     : getOrigens,
    'getOwners'                      : getOwners,
    'getAccessTags'                  : getAccessTags,
    'salvarAgendamento'              : salvarAgendamento,
    'updateRow'                      : updateRow,
    'confirmarAgendamento'           : confirmarAgendamento,
    'marcarCompareceu'               : marcarCompareceu,
    'marcarNaoCompareceu'            : marcarNaoCompareceu,
    'marcarCompraStatus'             : marcarCompraStatus,
    'cancelarAgendamento'            : cancelarAgendamento,
    'excluirAgendamento'             : excluirAgendamento,
    'salvarOS'                       : salvarOS,
    'gerarRelatorioCSV'              : gerarRelatorioCSV,
    'exportFinanceCSV'               : exportFinanceCSV,
    'atualizarPlanilhaSistemaCompleto': atualizarPlanilhaSistemaCompleto,
    'testarBackend'                  : testarBackend
  };

  if (!Object.prototype.hasOwnProperty.call(ALLOWED, fn)) {
    return saida_({ ok: false, error: 'Função não permitida: ' + fn });
  }

  try {
    const result = ALLOWED[fn].apply(null, Array.isArray(args) ? args : []);
    return saida_({ ok: true, result: result });
  } catch (ex) {
    return saida_({ ok: false, error: ex.message || String(ex), fn: fn });
  }
}
function configurarChaveApi() {
  PropertiesService.getScriptProperties()
    .setProperty('API_KEY', 'agendamento_tgt_target_2026_api_segura_XYZ520741');
  Logger.log('API_KEY configurada com sucesso!');
}
function corrigirHorariosPlanilha_() {
  var sh = getSheet_(SHEETS.agendamentos);
  if (sh.getLastRow() < 2) return;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_);
  var col = headers.indexOf('Horario') + 1;
  if (col === 0) { Logger.log('Coluna Horario nao encontrada'); return; }
  var count = 0;
  for (var i = 2; i <= sh.getLastRow(); i++) {
    var cell = sh.getRange(i, col);
    var val  = cell.getValue();
    if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val)) {
      cell.setValue(Utilities.formatDate(val, 'America/Sao_Paulo', 'HH:mm'));
      count++;
    }
  }
  Logger.log('Horarios corrigidos: ' + count);
}
function corrigirHorariosAgendamentos_() {
  ensureSystemStructure_();

  const sh = getSheet_(SHEETS.agendamentos);
  if (sh.getLastRow() < 2) {
    return { ok: true, message: 'Nenhum agendamento para corrigir.' };
  }

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_);
  const colHorario = headers.indexOf('Horario') + 1;

  if (!colHorario) {
    throw new Error('Coluna "Horario" não encontrada na aba agendamentos.');
  }

  const range = sh.getRange(2, colHorario, sh.getLastRow() - 1, 1);
  const values = range.getValues();

  let alterados = 0;

  const corrigidos = values.map(function(row) {
    const original = row[0];
    const novo = normalizeHourValue_(original);

    if (String(original) !== String(novo)) {
      alterados++;
    }

    return [novo];
  });

  range.setValues(corrigidos);
  range.setNumberFormat('@STRING@');

  registrarSincronizacao_(
    'CORRECAO_HORARIOS',
    'Horários corrigidos na aba agendamentos. Total alterados: ' + alterados,
    'sistema'
  );

  return {
    ok: true,
    message: 'Correção concluída com sucesso.',
    totalAlterados: alterados
  };
}
function corrigirConfiguracoesHorarioSP_() {
  ensureSystemStructure_();

  const sh = getSheet_(SHEETS.configuracoes);
  if (sh.getLastRow() < 2) {
    return { ok: true, message: 'Nenhuma configuração encontrada para corrigir.' };
  }

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normalizeText_);
  const colChave = headers.indexOf('Chave') + 1;
  const colValor = headers.indexOf('Valor') + 1;

  if (!colChave || !colValor) {
    throw new Error('As colunas "Chave" e/ou "Valor" não foram encontradas na aba configuracoes.');
  }

  const regrasCorretas = {
    seg_sex_inicio: '10:00',
    seg_sex_fim: '18:00',
    sab_inicio: '10:00',
    sab_fim: '16:00',
    domingo_bloqueado: 'Sim'
  };

  const lastRow = sh.getLastRow();
  const values = sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).getValues();

  const chavesExistentes = {};
  let alterados = 0;

  values.forEach(function(row, idx) {
    const linha = idx + 2;
    const chave = normalizeText_(row[colChave - 1]);

    if (!chave) return;
    chavesExistentes[chave] = true;

    if (Object.prototype.hasOwnProperty.call(regrasCorretas, chave)) {
      const valorAtual = row[colValor - 1];
      const valorCorreto = regrasCorretas[chave];

      if (String(valorAtual) !== String(valorCorreto)) {
        sh.getRange(linha, colValor).setValue(valorCorreto).setNumberFormat('@STRING@');
        alterados++;
      }
    }
  });

  Object.keys(regrasCorretas).forEach(function(chave) {
    if (!chavesExistentes[chave]) {
      const novaLinha = new Array(sh.getLastColumn()).fill('');
      novaLinha[colChave - 1] = chave;
      novaLinha[colValor - 1] = regrasCorretas[chave];
      sh.appendRow(novaLinha);
      sh.getRange(sh.getLastRow(), colValor).setNumberFormat('@STRING@');
      alterados++;
    }
  });

  registrarSincronizacao_(
    'CORRECAO_CONFIG_HORARIO',
    'Configurações de horário corrigidas na aba configuracoes. Total alterados: ' + alterados,
    'sistema'
  );

  return {
    ok: true,
    message: 'Configurações de horário corrigidas com sucesso.',
    totalAlterados: alterados
  };
}
function corrigirConfiguracoesHorarioSP() {
  return corrigirConfiguracoesHorarioSP_();
}

function corrigirHorariosAgendamentos() {
  return corrigirHorariosAgendamentos_();
}
function alinharTimezonePlanilhaSP() {
  const ss = getSpreadsheet_();
  ss.setSpreadsheetTimeZone('America/Sao_Paulo');

  registrarSincronizacao_(
    'TIMEZONE_PLANILHA',
    'Timezone da planilha ajustado para America/Sao_Paulo',
    'sistema'
  );

  return {
    ok: true,
    message: 'Timezone da planilha ajustado para America/Sao_Paulo.'
  };
}

function verificarTimezoneSistema() {
  const ss = getSpreadsheet_();

  return {
    ok: true,
    timezonePlanilha: ss.getSpreadsheetTimeZone(),
    timezoneProjeto: Session.getScriptTimeZone(),
    agoraProjeto: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yyyy HH:mm:ss'),
    agoraSP: Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm:ss')
  };
}
// ═══════════════════════════════════════════════════════════════
//  BLOCO 1 — CACHE INTELIGENTE (10x mais rápido)
//  Substitui getRowsAsObjects_ e registrarSincronizacao_
//  com versões que usam CacheService do Google
// ═══════════════════════════════════════════════════════════════

function getRowsAsObjects_(sheetName) {
  var TTL = {
    agendamentos:   15,   // 15s — dados em tempo real
    ordens_servico: 15,
    presencas:      30,
    usuarios:       300,  // 5 min
    configuracoes:  600,  // 10 min
    lojas:          600,
    optometristas:  600,
    origens:        600,
    feriados:       3600  // 1 hora
  };
  var ttl = TTL[sheetName] || 0;
  var key = 'r|' + sheetName;

  if (ttl) {
    try {
      var hit = CacheService.getScriptCache().get(key);
      if (hit) return JSON.parse(hit);
    } catch(e) {}
  }

  var sh     = getSheet_(sheetName);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(normalizeText_);
  var rows = values.slice(1)
    .filter(function(r) { return r.join('') !== ''; })
    .map(function(row, idx) {
      var obj = { __rowNumber: idx + 2 };
      headers.forEach(function(h, i) { obj[h] = row[i]; });
      return obj;
    });

  if (ttl) {
    try { CacheService.getScriptCache().put(key, JSON.stringify(rows), ttl); } catch(e) {}
  }
  return rows;
}

function registrarSincronizacao_(tipo, mensagem, usuario) {
  try {
    getSheet_(SHEETS.sincronizacao).appendRow([new Date(), tipo, mensagem, usuario || 'sistema']);
  } catch(e) {}
  // Invalida cache ao gravar dados
  try {
    CacheService.getScriptCache().removeAll(['r|agendamentos','r|ordens_servico','r|presencas']);
  } catch(e) {}
}
// ═══════════════════════════════════════════════════════════════
//  BLOCO 2 — KEEP-ALIVE (GAS sempre ativo, sem dormir)
//  Execute configurarKeepAlive() UMA VEZ para ativar
// ═══════════════════════════════════════════════════════════════

function keepAliveGAS_() {
  try {
    // Pré-aquece cache das abas mais acessadas
    getLojas();
    getOrigens();
    Logger.log('[keep-alive] GAS ativo — ' + new Date().toLocaleTimeString('pt-BR'));
  } catch(e) {
    Logger.log('[keep-alive] erro: ' + e.message);
  }
}

function configurarKeepAlive() {
  // Remove triggers antigos de keep-alive
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'keepAliveGAS_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  // Cria trigger a cada 1 minuto (mínimo possível no GAS)
  ScriptApp.newTrigger('keepAliveGAS_')
    .timeBased()
    .everyMinutes(1)
    .create();
  Logger.log('Keep-alive ativado: GAS roda a cada 1 minuto.');
}

function desativarKeepAlive() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'keepAliveGAS_') {
      ScriptApp.deleteTrigger(t);
    }
  });
  Logger.log('Keep-alive desativado.');
}


// ═══════════════════════════════════════════════════════════════
//  TESTE DO PACOTE TURBO
// ═══════════════════════════════════════════════════════════════
function testarPacoteTurbo() {
  ensureSystemStructure_();
  const usuarios = getUsuariosAtivos_();
  if (!usuarios.length) return { ok: false, message: 'Nenhum usuário ativo encontrado na aba usuarios.' };
  const user = getUserContext_(usuarios[0].Email);
  const boot = getBootstrapSistema(user, {});
  return {
    ok: !!(boot && boot.ok),
    usuarioTeste: user ? user.email : '',
    totalAgendamentos: boot && boot.agendamentos ? boot.agendamentos.length : 0,
    serverVersion: SERVER_VERSION,
    dataHora: Utilities.formatDate(new Date(), 'America/Sao_Paulo', 'dd/MM/yyyy HH:mm:ss')
  };
}
