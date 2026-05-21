// ═══════════════════════════════════════════════════════════════
//  server.js — Agendamento System
//  Node.js + Express | Proxy para Google Apps Script
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const GAS_URL     = process.env.GAS_DEPLOY_URL || '';
const GAS_API_KEY = process.env.GAS_API_KEY    || '';

// ── Cache em memória ─────────────────────────────────────────
const CACHE_TTL = {
  getInfoInicial         : 10 * 60 * 1000, // 10 min — lojas, origens, owners raramente mudam
  getLojas               : 10 * 60 * 1000,
  getOrigens             : 10 * 60 * 1000,
  getOwners              : 10 * 60 * 1000,
  getAccessTags          : 10 * 60 * 1000,
  getOptometristasPorLoja: 10 * 60 * 1000,
  loginSeguro            :  5 * 60 * 1000, // 5 min por usuário
  getUsuarioLogado       :  5 * 60 * 1000,
  getAgendamentos        :        15_000,  // 15s — sincroniza em tempo quase-real
  getAgendamentosSeguro  :        15_000,
  getDashboard           :        15_000,
  getFinancePanel        :        15_000,
};

// Funções que gravam dados — invalidam o cache ao serem chamadas
const WRITE_FNS = new Set([
  'salvarAgendamento', 'updateRow', 'confirmarAgendamento',
  'marcarCompareceu', 'marcarNaoCompareceu', 'marcarCompraStatus',
  'cancelarAgendamento', 'excluirAgendamento', 'salvarOS',
  'atualizarPlanilhaSistemaCompleto'
]);

const cache = new Map();

function cacheKey(fn, args) {
  return fn + '|' + JSON.stringify(args);
}

function getCache(fn, args) {
  const entry = cache.get(cacheKey(fn, args));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(cacheKey(fn, args)); return null; }
  return entry.data;
}

function setCache(fn, args, data) {
  const ttl = CACHE_TTL[fn];
  if (!ttl) return;
  cache.set(cacheKey(fn, args), { data, expiresAt: Date.now() + ttl });
}

function invalidateCache() {
  cache.clear();
}

// ── Middlewares ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',  // browser faz cache do HTML/CSS/JS por 1 hora
  etag: true
}));

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Agendamento System',
    gasConfigured: !!GAS_URL,
    cacheEntries: cache.size,
    ts: new Date().toISOString()
  });
});

// ── Limpar cache manualmente ──────────────────────────────────
app.post('/api/cache/clear', (_req, res) => {
  invalidateCache();
  res.json({ ok: true, message: 'Cache limpo.' });
});

// ── Proxy GAS function calls ──────────────────────────────────
app.post('/api/gas', async (req, res) => {
  if (!GAS_URL) {
    return res.status(503).json({
      ok: false,
      error: 'GAS_DEPLOY_URL não configurado. Verifique o arquivo .env'
    });
  }

  const { fn, args = [] } = req.body;
  if (!fn) {
    return res.status(400).json({ ok: false, error: 'Parâmetro "fn" obrigatório.' });
  }

  // Retorna do cache se disponível
  const cached = getCache(fn, args);
  if (cached) {
    return res.json({ ...cached, _cached: true });
  }

  // Invalida cache ao gravar
  if (WRITE_FNS.has(fn)) invalidateCache();

  try {
    const params = new URLSearchParams({
      format: 'api',
      fn:     fn,
      key:    GAS_API_KEY,
      args:   JSON.stringify(args)
    });

    const gasUrl = `${GAS_URL}?${params.toString()}`;
    const response = await fetch(gasUrl, {
      method:  'GET',
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(55_000)
    });

    if (!response.ok) {
      return res.status(502).json({ ok: false, error: `GAS retornou HTTP ${response.status}`, fn });
    }

    const text = await response.text();
    let data;
    try   { data = JSON.parse(text); }
    catch { data = { ok: false, error: 'Resposta inválida do GAS', raw: text.slice(0, 500) }; }

    // Salva no cache só se a resposta for ok
    if (data && data.ok) setCache(fn, args, data);

    return res.json(data);
  } catch (err) {
    const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
    return res.status(isTimeout ? 504 : 500).json({
      ok:    false,
      error: isTimeout ? 'GAS demorou demais para responder.' : (err.message || String(err)),
      fn
    });
  }
});

// ── SPA fallback ──────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Agendamento System`);
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    GAS URL: ${GAS_URL ? '✅ configurado' : '❌ NÃO configurado (.env)'}`);
  console.log(`    API Key: ${GAS_API_KEY ? '✅ configurado' : '❌ NÃO configurado (.env)'}`);
  console.log(`    Cache:   ✅ ativo (lojas/origens/usuários: 10min)\n`);
});
