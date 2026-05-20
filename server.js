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

const GAS_URL     = process.env.GAS_DEPLOY_URL  || '';
const GAS_API_KEY = process.env.GAS_API_KEY     || '';

// ── Middlewares ──────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'Agendamento System',
    gasConfigured: !!GAS_URL,
    ts: new Date().toISOString()
  });
});

// ── Proxy GAS function calls ──────────────────────────────────
// Todas as chamadas frontend vão para POST /api/gas
// { fn: 'nomeFuncao', args: [...argumentos] }
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

  try {
    // Monta a URL do GAS com a action API
    const params = new URLSearchParams({
      format: 'api',
      fn:     fn,
      key:    GAS_API_KEY,
      args:   JSON.stringify(args)
    });

    const gasUrl  = `${GAS_URL}?${params.toString()}`;
    const options = {
      method:  'GET',
      headers: { 'Accept': 'application/json' },
      // Node 18+ tem fetch nativo; sem timeout padrão, GAS pode ser lento
      signal: AbortSignal.timeout(55_000) // 55s (GAS limite = 6min, mas nosso timeout é menor)
    };

    const response = await fetch(gasUrl, options);

    if (!response.ok) {
      return res.status(502).json({
        ok:    false,
        error: `GAS retornou HTTP ${response.status}`,
        fn
      });
    }

    const text = await response.text();
    let data;
    try   { data = JSON.parse(text); }
    catch { data = { ok: false, error: 'Resposta inválida do GAS', raw: text.slice(0, 500) }; }

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

// ── SPA fallback (react-router style) ────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Agendamento System`);
  console.log(`    Local:   http://localhost:${PORT}`);
  console.log(`    GAS URL: ${GAS_URL ? '✅ configurado' : '❌ NÃO configurado (.env)'}`);
  console.log(`    API Key: ${GAS_API_KEY ? '✅ configurado' : '❌ NÃO configurado (.env)'}\n`);
});
