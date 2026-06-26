'use strict';

/**
 * Módulo de Negociação — rotas e tabelas isoladas.
 * Não modifica nenhuma tabela ou rota existente.
 */

async function initNegociacaoTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agendamento_negociacao (
      id SERIAL PRIMARY KEY,
      agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id) ON DELETE CASCADE,
      modelo_armacao TEXT,
      valor_armacao NUMERIC(12,2),
      tipo_lentes TEXT,
      valor_lentes NUMERIC(12,2),
      proposta_vendedor TEXT,
      possibilidades_oferecidas TEXT,
      status_negociacao TEXT DEFAULT 'Em andamento',
      criado_por_nome TEXT,
      criado_por_email TEXT,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notificacoes (
      id SERIAL PRIMARY KEY,
      tipo TEXT NOT NULL,
      titulo TEXT NOT NULL,
      mensagem TEXT,
      agendamento_id INTEGER,
      destinatarios TEXT[] DEFAULT '{}',
      lidos_por TEXT[] DEFAULT '{}',
      criado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_negociacao_agendamento
    ON agendamento_negociacao(agendamento_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_notificacoes_criado_em
    ON notificacoes(criado_em DESC);
  `);
}

function registerRoutes(app, pool, deps) {
  var requireSession = deps.requireSession;
  var canViewAllStores = deps.canViewAllStores;

  // GET /api/negociacao/:agendamento_id — busca negociação de um agendamento
  app.get('/api/negociacao/:agendamento_id', requireSession, async function(req, res) {
    try {
      var id = parseInt(req.params.agendamento_id, 10);
      if (!id || isNaN(id)) return res.status(400).json({ ok: false, message: 'ID inválido.' });

      var result = await pool.query(
        'SELECT * FROM agendamento_negociacao WHERE agendamento_id = $1 ORDER BY criado_em DESC LIMIT 1',
        [id]
      );
      return res.json({ ok: true, negociacao: result.rows[0] || null });
    } catch (err) {
      console.error('[negociacao GET]', err);
      return res.status(500).json({ ok: false, message: 'Erro ao buscar negociação.' });
    }
  });

  // POST /api/negociacao — cria ou atualiza negociação (upsert por agendamento_id)
  app.post('/api/negociacao', requireSession, async function(req, res) {
    try {
      var session = req.session;
      var body = req.body || {};
      var agendamento_id = parseInt(body.agendamento_id, 10);
      if (!agendamento_id || isNaN(agendamento_id)) {
        return res.status(400).json({ ok: false, message: 'agendamento_id obrigatório.' });
      }

      var status_negociacao = body.status_negociacao || 'Em andamento';
      var valores = {
        modelo_armacao: body.modelo_armacao || null,
        valor_armacao: body.valor_armacao != null ? parseFloat(body.valor_armacao) || null : null,
        tipo_lentes: body.tipo_lentes || null,
        valor_lentes: body.valor_lentes != null ? parseFloat(body.valor_lentes) || null : null,
        proposta_vendedor: body.proposta_vendedor || null,
        possibilidades_oferecidas: body.possibilidades_oferecidas || null,
        status_negociacao: status_negociacao,
        criado_por_nome: session.nome || null,
        criado_por_email: session.email || null
      };

      // Upsert — atualiza se já existe, cria se não existe
      var existing = await pool.query(
        'SELECT id FROM agendamento_negociacao WHERE agendamento_id = $1 ORDER BY criado_em DESC LIMIT 1',
        [agendamento_id]
      );

      var savedId;
      if (existing.rows.length > 0) {
        var upd = await pool.query(
          `UPDATE agendamento_negociacao SET
            modelo_armacao = $1, valor_armacao = $2, tipo_lentes = $3, valor_lentes = $4,
            proposta_vendedor = $5, possibilidades_oferecidas = $6, status_negociacao = $7,
            criado_por_nome = $8, criado_por_email = $9, atualizado_em = NOW()
           WHERE id = $10 RETURNING id`,
          [
            valores.modelo_armacao, valores.valor_armacao, valores.tipo_lentes, valores.valor_lentes,
            valores.proposta_vendedor, valores.possibilidades_oferecidas, valores.status_negociacao,
            valores.criado_por_nome, valores.criado_por_email, existing.rows[0].id
          ]
        );
        savedId = upd.rows[0].id;
      } else {
        var ins = await pool.query(
          `INSERT INTO agendamento_negociacao
            (agendamento_id, modelo_armacao, valor_armacao, tipo_lentes, valor_lentes,
             proposta_vendedor, possibilidades_oferecidas, status_negociacao, criado_por_nome, criado_por_email)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [
            agendamento_id, valores.modelo_armacao, valores.valor_armacao, valores.tipo_lentes, valores.valor_lentes,
            valores.proposta_vendedor, valores.possibilidades_oferecidas, valores.status_negociacao,
            valores.criado_por_nome, valores.criado_por_email
          ]
        );
        savedId = ins.rows[0].id;
      }

      // Notificação assíncrona para admin/central quando negociação é salva
      setImmediate(async function() {
        try {
          var ag = await pool.query(
            'SELECT nome, loja FROM agendamentos WHERE id = $1',
            [agendamento_id]
          );
          if (!ag.rows.length) return;
          var cliente = ag.rows[0].nome;
          var loja = ag.rows[0].loja;
          await pool.query(
            `INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios)
             VALUES ($1,$2,$3,$4,$5)`,
            [
              'negociacao',
              'Negociação registrada',
              'Nova negociação registrada para ' + cliente + ' (' + loja + ') por ' + (valores.criado_por_nome || 'usuário') + '.',
              agendamento_id,
              ['admin', 'atendimento central']
            ]
          );
        } catch (e) {
          console.error('[negociacao notif]', e);
        }
      });

      return res.json({ ok: true, id: savedId });
    } catch (err) {
      console.error('[negociacao POST]', err);
      return res.status(500).json({ ok: false, message: 'Erro ao salvar negociação.' });
    }
  });

  // GET /api/notificacoes — busca notificações não lidas para o usuário logado
  app.get('/api/notificacoes', requireSession, async function(req, res) {
    try {
      var session = req.session;
      var perfil = (session.perfil || '').toLowerCase();
      var email = session.email || '';

      var result = await pool.query(
        `SELECT id, tipo, titulo, mensagem, agendamento_id, criado_em
         FROM notificacoes
         WHERE (
           $1 = ANY(destinatarios) OR $2 = ANY(destinatarios)
         )
         AND NOT ($3 = ANY(lidos_por))
         ORDER BY criado_em DESC
         LIMIT 50`,
        [perfil, email, email]
      );

      return res.json({ ok: true, notificacoes: result.rows });
    } catch (err) {
      console.error('[notificacoes GET]', err);
      return res.status(500).json({ ok: false, message: 'Erro ao buscar notificações.' });
    }
  });

  // POST /api/notificacoes/:id/lida — marca notificação como lida para o usuário logado
  app.post('/api/notificacoes/:id/lida', requireSession, async function(req, res) {
    try {
      var session = req.session;
      var id = parseInt(req.params.id, 10);
      var email = session.email || '';
      if (!id || isNaN(id)) return res.status(400).json({ ok: false, message: 'ID inválido.' });

      await pool.query(
        `UPDATE notificacoes SET lidos_por = array_append(lidos_por, $1)
         WHERE id = $2 AND NOT ($1 = ANY(lidos_por))`,
        [email, id]
      );
      return res.json({ ok: true });
    } catch (err) {
      console.error('[notificacoes lida]', err);
      return res.status(500).json({ ok: false, message: 'Erro ao marcar notificação.' });
    }
  });
}

module.exports = { initNegociacaoTables, registerRoutes };
