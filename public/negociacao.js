(function() {
  'use strict';

  // ── CSS ──────────────────────────────────────────────────────────────────
  var CSS = [
    '.neg-modal-body{display:flex;flex-direction:column;gap:14px;}',
    '.neg-row{display:flex;gap:12px;flex-wrap:wrap;}',
    '.neg-row>div{flex:1;min-width:140px;}',
    '.neg-row label{display:block;font-size:13px;font-weight:600;margin-bottom:4px;color:var(--color-text,#333);}',
    '.neg-row input,.neg-row select,.neg-row textarea{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#ddd);border-radius:8px;font-size:14px;}',
    '.neg-row textarea{resize:vertical;min-height:72px;}',
    '.neg-actions{display:flex;gap:10px;margin-top:6px;flex-wrap:wrap;}',
    '.neg-badge{display:inline-flex;align-items:center;justify-content:center;background:#e53935;color:#fff;',
    '  border-radius:50%;width:18px;height:18px;font-size:11px;font-weight:700;margin-left:5px;',
    '  vertical-align:middle;line-height:1;}',
    '.neg-bell{position:relative;display:inline-block;cursor:pointer;padding:4px 8px;border-radius:8px;}',
    '.neg-bell:hover{background:rgba(0,0,0,.06);}',
    '.neg-notif-panel{position:absolute;right:0;top:32px;width:320px;max-height:320px;overflow-y:auto;',
    '  background:#fff;border:1px solid var(--line,#ddd);border-radius:12px;',
    '  box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:10000;padding:8px 0;}',
    '.neg-notif-item{padding:10px 14px;border-bottom:1px solid #f0f0f0;cursor:pointer;font-size:13px;}',
    '.neg-notif-item:last-child{border-bottom:none;}',
    '.neg-notif-item:hover{background:#f8f8f8;}',
    '.neg-notif-titulo{font-weight:600;color:#222;}',
    '.neg-notif-msg{color:#555;margin-top:2px;}',
    '.neg-notif-data{color:#999;font-size:11px;margin-top:3px;}',
    '.neg-notif-empty{padding:18px;text-align:center;color:#999;font-size:13px;}'
  ].join('\n');

  function injectCss() {
    if (document.getElementById('tgt-neg-css')) return;
    var s = document.createElement('style');
    s.id = 'tgt-neg-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function apiGet(url) {
    return fetch(url, { credentials: 'include' }).then(function(r){ return r.json(); });
  }

  function apiPost(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r){ return r.json(); });
  }

  function formatDateTimeBR(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  }

  // ── Modal de Negociação ───────────────────────────────────────────────────
  function abrirModalNegociacao(id, row) {
    row = row || {};
    var backdrop = document.getElementById('negModalBackdrop');
    if (backdrop) backdrop.remove();

    backdrop = document.createElement('div');
    backdrop.id = 'negModalBackdrop';
    backdrop.className = 'modal-backdrop';

    var statusOpts = ['Em andamento','Proposta enviada','Aguardando cliente','Fechada','Perdida']
      .map(function(s){ return '<option value="' + esc(s) + '">' + esc(s) + '</option>'; }).join('');

    backdrop.innerHTML =
      '<div class="modal-card" style="max-width:620px">' +
      '<div class="topbar">' +
      '<h3 style="margin:0">Negociação — ' + esc(row.NomeCompleto || 'Cliente') + '</h3>' +
      '<button class="secondary icon-btn" onclick="document.getElementById(\'negModalBackdrop\').remove()">Fechar</button>' +
      '</div>' +
      '<div id="negModalBody" class="neg-modal-body">' +
      '<div class="neg-row">' +
      '<div><label>Modelo da armação</label><input id="negModeloArmacao" type="text" placeholder="Ex: Ray-Ban RB3025"></div>' +
      '<div><label>Valor armação (R$)</label><input id="negValorArmacao" type="number" min="0" step="0.01" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="neg-row">' +
      '<div><label>Tipo de lentes</label><input id="negTipoLentes" type="text" placeholder="Ex: Transitions, Crizal, Varilux..."></div>' +
      '<div><label>Valor lentes (R$)</label><input id="negValorLentes" type="number" min="0" step="0.01" placeholder="0.00"></div>' +
      '</div>' +
      '<div class="neg-row">' +
      '<div style="flex:2"><label>Proposta do vendedor</label><textarea id="negPropostaVendedor" placeholder="Descreva a proposta apresentada ao cliente..."></textarea></div>' +
      '</div>' +
      '<div class="neg-row">' +
      '<div style="flex:2"><label>Possibilidades oferecidas</label><textarea id="negPossibilidades" placeholder="Ex: parcelamento, desconto, troca de modelo..."></textarea></div>' +
      '</div>' +
      '<div class="neg-row">' +
      '<div><label>Status da negociação</label><select id="negStatus">' + statusOpts + '</select></div>' +
      '</div>' +
      '<div class="neg-actions">' +
      '<button onclick="window.__negSalvar(\'' + esc(String(id)) + '\')">Salvar Negociação</button>' +
      '<button class="secondary" onclick="document.getElementById(\'negModalBackdrop\').remove()">Cancelar</button>' +
      '</div>' +
      '<div id="negMsg" class="msg" style="margin-top:8px"></div>' +
      '</div>' +
      '</div>';

    document.body.appendChild(backdrop);

    // Carregar dados existentes
    apiGet('/api/negociacao/' + encodeURIComponent(id)).then(function(res) {
      if (res && res.negociacao) {
        var n = res.negociacao;
        function set(sid, val) { var el = document.getElementById(sid); if (el) el.value = val || ''; }
        set('negModeloArmacao', n.modelo_armacao);
        set('negValorArmacao', n.valor_armacao);
        set('negTipoLentes', n.tipo_lentes);
        set('negValorLentes', n.valor_lentes);
        set('negPropostaVendedor', n.proposta_vendedor);
        set('negPossibilidades', n.possibilidades_oferecidas);
        set('negStatus', n.status_negociacao);
      }
    }).catch(function() {});
  }

  window.__negSalvar = function(id) {
    var msg = document.getElementById('negMsg');
    function setMsg(txt, tipo) {
      if (!msg) return;
      msg.textContent = txt;
      msg.className = 'msg ' + (tipo || '');
    }

    function val(sid) { var el = document.getElementById(sid); return el ? el.value.trim() : ''; }

    var payload = {
      agendamento_id: id,
      modelo_armacao: val('negModeloArmacao') || null,
      valor_armacao: val('negValorArmacao') || null,
      tipo_lentes: val('negTipoLentes') || null,
      valor_lentes: val('negValorLentes') || null,
      proposta_vendedor: val('negPropostaVendedor') || null,
      possibilidades_oferecidas: val('negPossibilidades') || null,
      status_negociacao: val('negStatus') || 'Em andamento'
    };

    setMsg('Salvando...', '');

    apiPost('/api/negociacao', payload).then(function(res) {
      if (!res || !res.ok) throw new Error((res && res.message) || 'Erro ao salvar.');
      setMsg('Negociação salva com sucesso!', 'ok');
      setTimeout(function() {
        var bd = document.getElementById('negModalBackdrop');
        if (bd) bd.remove();
      }, 1200);
    }).catch(function(err) {
      setMsg(err.message || String(err), 'err');
    });
  };

  window.abrirModalNegociacao = abrirModalNegociacao;

  // ── Sino de notificações ──────────────────────────────────────────────────
  var _notifCount = 0;
  var _notifOpen = false;

  function criarSino() {
    if (document.getElementById('tgt-neg-bell')) return;
    var topbar = document.querySelector('.topbar') || document.querySelector('header') || document.body;
    var bell = document.createElement('span');
    bell.id = 'tgt-neg-bell';
    bell.className = 'neg-bell';
    bell.title = 'Notificações de negociação';
    bell.innerHTML = '&#128276;<span id="tgt-neg-badge" class="neg-badge" style="display:none">0</span>';
    bell.onclick = function(e) { e.stopPropagation(); togglePainelNotif(); };
    topbar.appendChild(bell);

    document.addEventListener('click', function() {
      var panel = document.getElementById('tgt-neg-panel');
      if (panel) panel.remove();
      _notifOpen = false;
    });
  }

  function togglePainelNotif() {
    var panel = document.getElementById('tgt-neg-panel');
    if (panel) { panel.remove(); _notifOpen = false; return; }
    _notifOpen = true;
    carregarPainelNotif();
  }

  function carregarPainelNotif() {
    var bell = document.getElementById('tgt-neg-bell');
    if (!bell) return;
    apiGet('/api/notificacoes').then(function(res) {
      var items = (res && res.notificacoes) || [];
      var panel = document.createElement('div');
      panel.id = 'tgt-neg-panel';
      panel.className = 'neg-notif-panel';
      panel.onclick = function(e) { e.stopPropagation(); };

      if (!items.length) {
        panel.innerHTML = '<div class="neg-notif-empty">Nenhuma notificação nova.</div>';
      } else {
        panel.innerHTML = items.map(function(n) {
          return '<div class="neg-notif-item" onclick="window.__negMarcarLida(' + n.id + ', this)">' +
            '<div class="neg-notif-titulo">' + esc(n.titulo) + '</div>' +
            '<div class="neg-notif-msg">' + esc(n.mensagem || '') + '</div>' +
            '<div class="neg-notif-data">' + esc(formatDateTimeBR(n.criado_em)) + '</div>' +
            '</div>';
        }).join('');
      }

      bell.appendChild(panel);
    }).catch(function() {});
  }

  window.__negMarcarLida = function(id, el) {
    apiPost('/api/notificacoes/' + id + '/lida', {}).then(function() {
      if (el) el.style.opacity = '0.4';
      _notifCount = Math.max(0, _notifCount - 1);
      atualizarBadge();
    }).catch(function() {});
  };

  function atualizarBadge() {
    var badge = document.getElementById('tgt-neg-badge');
    if (!badge) return;
    if (_notifCount > 0) {
      badge.textContent = _notifCount > 9 ? '9+' : String(_notifCount);
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  }

  function pollNotificacoes() {
    apiGet('/api/notificacoes').then(function(res) {
      var items = (res && res.notificacoes) || [];
      _notifCount = items.length;
      atualizarBadge();
    }).catch(function() {});
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    injectCss();
    criarSino();
    pollNotificacoes();
    setInterval(pollNotificacoes, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 800);
  }

})();
