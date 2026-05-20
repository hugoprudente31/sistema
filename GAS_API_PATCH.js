// ═══════════════════════════════════════════════════════════════
//  GAS_API_PATCH.js — Patch para código.gs
//  Permite que o servidor Node.js chame funções GAS via HTTP
//
//  COMO APLICAR:
//  1. Abra seu script.google.com/macros
//  2. Localize a função doGet(e) em código.gs
//  3. Adicione o bloco "formato === 'api'" dentro do doGet
//  4. Cole a função handleHttpApiCall_ ao final do arquivo
//  5. Configure a chave: PropertiesService.getScriptProperties()
//       .setProperty('API_KEY', 'mesma-chave-do-.env')
//  6. Re-publique o deploy (nova versão)
// ═══════════════════════════════════════════════════════════════


// ── PATCH 1: Adicione este bloco dentro de doGet(e), após os outros blocos if ──

/*
  // [PATCH] API HTTP para chamadas externas (Node.js proxy)
  if (formato === 'api') {
    try {
      var apiKey         = params.key || '';
      var expectedApiKey = getScriptSecret_('API_KEY');
      if (!expectedApiKey || apiKey !== expectedApiKey) {
        return jsonOutput_({ ok: false, error: 'Unauthorized' });
      }
      ensureSystemStructure_();
      return handleHttpApiCall_(params);
    } catch (err) {
      return jsonOutput_({ ok: false, error: err.message || String(err) });
    }
  }
*/


// ── PATCH 2: Cole esta função inteira ao final de código.gs ──────────────────

function handleHttpApiCall_(params) {
  var fn      = normalizeText_(params.fn || '');
  var argsStr = params.args || '[]';
  var args;

  try   { args = JSON.parse(argsStr); }
  catch { return jsonOutput_({ ok: false, error: 'args inválido: ' + argsStr.slice(0, 100) }); }

  // Whitelist de funções permitidas via HTTP
  // Adicione/remova conforme necessário
  var ALLOWED = {
    'loginSeguro'                   : loginSeguro,
    'getUsuarioLogado'              : getUsuarioLogado,
    'getInfoInicial'                : getInfoInicial,
    'getAgendamentos'               : getAgendamentos,
    'getAgendamentosSeguro'         : getAgendamentosSeguro,
    'getDashboard'                  : getDashboard,
    'getFinancePanel'               : getFinancePanel,
    'getLeadTimeReport'             : getLeadTimeReport,
    'getHistoricoOperacional'       : getHistoricoOperacional,
    'getOptometristasPorLoja'       : getOptometristasPorLoja,
    'getLojas'                      : getLojas,
    'getOrigens'                    : getOrigens,
    'getOwners'                     : getOwners,
    'getAccessTags'                 : getAccessTags,
    'salvarAgendamento'             : salvarAgendamento,
    'updateRow'                     : updateRow,
    'confirmarAgendamento'          : confirmarAgendamento,
    'marcarCompareceu'              : marcarCompareceu,
    'marcarNaoCompareceu'           : marcarNaoCompareceu,
    'marcarCompraStatus'            : marcarCompraStatus,
    'cancelarAgendamento'           : cancelarAgendamento,
    'excluirAgendamento'            : excluirAgendamento,
    'salvarOS'                      : salvarOS,
    'gerarRelatorioCSV'             : gerarRelatorioCSV,
    'exportFinanceCSV'              : exportFinanceCSV,
    'atualizarPlanilhaSistemaCompleto': atualizarPlanilhaSistemaCompleto,
    'testarBackend'                 : testarBackend
  };

  if (!Object.prototype.hasOwnProperty.call(ALLOWED, fn)) {
    return jsonOutput_({ ok: false, error: 'Função não permitida: ' + fn });
  }

  try {
    var result = ALLOWED[fn].apply(null, Array.isArray(args) ? args : []);
    return jsonOutput_({ ok: true, result: result });
  } catch (e) {
    return jsonOutput_({ ok: false, error: e.message || String(e), fn: fn });
  }
}
