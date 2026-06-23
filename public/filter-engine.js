(function(root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.TGTFilterEngine = api;
})(typeof window !== 'undefined' ? window : globalThis, function() {
  function normalize(value) {
    return String(value == null ? '' : value).trim().toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
  }
  function value(row, names) {
    for (var i = 0; i < names.length; i += 1) {
      if (row[names[i]] !== undefined && row[names[i]] !== null) return row[names[i]];
    }
    return '';
  }
  function dateOnly(raw) {
    var text = String(raw || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) {
      var parts = text.split('/');
      return parts[2] + '-' + parts[1] + '-' + parts[0];
    }
    return '';
  }
  function addDays(iso, days) {
    var date = new Date(iso + 'T12:00:00');
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
  }
  function isMine(row, user) {
    var email = normalize(user && user.email);
    var name = normalize(user && user.nome);
    var emails = normalize([value(row, ['AgendadoPorEmail', 'agendado_por_email']), value(row, ['CriadoPorEmail', 'criado_por_email']), value(row, ['vendedor_atendeu_email'])].join(' '));
    var names = normalize([value(row, ['AgendadoPorNome', 'agendado_por_nome']), value(row, ['ProprietarioNome', 'proprietario_nome']), value(row, ['Responsavel', 'responsavel']), value(row, ['VendedorNome', 'vendedor_nome'])].join(' '));
    return Boolean((email && emails.indexOf(email) >= 0) || (name && names.indexOf(name) >= 0));
  }
  function activeOS(row) {
    var number = String(value(row, ['NumeroOS', 'numero_os']) || '').trim();
    var status = normalize(value(row, ['StatusOS', 'status_os']));
    return Boolean(number && ['concluido', 'entregue', 'cancelada', 'cancelado'].indexOf(status) === -1);
  }
  function filterAppointments(rows, filters, user, today) {
    rows = Array.isArray(rows) ? rows : [];
    filters = filters || {};
    today = dateOnly(today) || new Date().toISOString().slice(0, 10);
    var from = dateOnly(filters.dataDe);
    var to = dateOnly(filters.dataAte);
    var period = Number(filters.periodoDias || 0);
    if (period > 0 && !from && !to) {
      from = addDays(today, -(period - 1));
      to = today;
    }
    return rows.filter(function(row) {
      var date = dateOnly(value(row, ['DataAgendamento', 'DataAgendamentoBR', 'data_agendamento']));
      if (from && (!date || date < from)) return false;
      if (to && (!date || date > to)) return false;
      if (filters.status && normalize(value(row, ['StatusAgenda', 'status'])) !== normalize(filters.status)) return false;
      if (filters.statusOS && normalize(value(row, ['StatusOS', 'status_os'])) !== normalize(filters.statusOS)) return false;
      if (filters.loja && normalize(value(row, ['Loja', 'loja'])) !== normalize(filters.loja)) return false;
      if (filters.optometrista && normalize(value(row, ['Optometrista', 'optometrista'])).indexOf(normalize(filters.optometrista)) < 0) return false;
      if (filters.accessTag && normalize(value(row, ['AccessTags', 'access_tags'])).indexOf(normalize(filters.accessTag)) < 0) return false;
      if (filters.ownerId) {
        var owner = normalize(value(row, ['ProprietarioId', 'proprietario_id', 'ProprietarioNome', 'proprietario_nome']));
        if (owner !== normalize(filters.ownerId)) return false;
      }
      if (filters.cliente) {
        var client = normalize([value(row, ['NomeCompleto', 'nome']), value(row, ['WhatsApp', 'whatsapp']), value(row, ['Email', 'email'])].join(' '));
        if (client.indexOf(normalize(filters.cliente)) < 0) return false;
      }
      if (String(filters.meus) === 'true' && !isMine(row, user)) return false;
      if (String(filters.minhasOSAtivas) === 'true' && (!isMine(row, user) || !activeOS(row))) return false;
      if (filters.resultado) {
        var res = filters.resultado;
        var comp = normalize(value(row, ['Compareceu', 'compareceu']));
        var stag = normalize(value(row, ['StatusAgenda', 'status']));
        var nos  = String(value(row, ['NumeroOS', 'numero_os']) || '').trim();
        var sos  = normalize(value(row, ['StatusOS', 'status_os']));
        var tags = normalize(value(row, ['AccessTags', 'access_tags']));
        if (res === 'compareceu'     && !(comp === 'sim' || stag === 'compareceu')) return false;
        if (res === 'nao-compareceu' && !(comp === 'nao' || stag === 'nao compareceu')) return false;
        if (res === 'comprou'        && !(nos && sos !== '' && ['cancelada','cancelado','reembolso'].indexOf(sos) === -1)) return false;
        if (res === 'cancelou'       && stag !== 'cancelado') return false;
        if (res === 'reagendou'      && tags.indexOf('reagendado') < 0) return false;
      }
      return true;
    });
  }
  return { normalize: normalize, filterAppointments: filterAppointments, activeOS: activeOS, isMine: isMine };
});
