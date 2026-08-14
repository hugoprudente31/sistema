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
      proposta_agendada_em TIMESTAMPTZ,
      proposta_enviada_em TIMESTAMPTZ,
      proposta_ultima_tentativa_em TIMESTAMPTZ,
      proposta_erro TEXT,
      criado_em TIMESTAMP DEFAULT NOW(),
      atualizado_em TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE agendamento_negociacao
      ADD COLUMN IF NOT EXISTS proposta_agendada_em TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS proposta_enviada_em TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS proposta_ultima_tentativa_em TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS proposta_erro TEXT,
      ADD COLUMN IF NOT EXISTS proposta_tentativas INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS proposta_proxima_tentativa_em TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS proposta_falha_em TIMESTAMPTZ;
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
    CREATE INDEX IF NOT EXISTS idx_negociacao_proposta_pendente
    ON agendamento_negociacao(proposta_agendada_em)
    WHERE proposta_enviada_em IS NULL;
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

      if (!canViewAllStores(req.session)) {
        var lojaCheck = await pool.query(
          `SELECT 1 FROM agendamentos WHERE id = $1
           AND TRANSLATE(LOWER(TRIM(COALESCE(loja,''))), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
             = TRANSLATE(LOWER(TRIM($2)), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`,
          [id, req.session.loja || '']
        );
        if (!lojaCheck.rows.length) {
          return res.status(403).json({ ok: false, message: 'Sem permissão para acessar dados desta loja.' });
        }
      }

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

      if (!canViewAllStores(session)) {
        var lojaCheck = await pool.query(
          `SELECT 1 FROM agendamentos WHERE id = $1
           AND TRANSLATE(LOWER(TRIM(COALESCE(loja,''))), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
             = TRANSLATE(LOWER(TRIM($2)), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`,
          [agendamento_id, session.loja || '']
        );
        if (!lojaCheck.rows.length) {
          return res.status(403).json({ ok: false, message: 'Sem permissão para operar dados desta loja.' });
        }
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

      // Agenda antes de responder ao clique em Salvar. Assim o acompanhamento
      // não se perde mesmo se o processo reiniciar logo após esta requisição.
      var propostaProgramada = await pool.query(
        `UPDATE agendamento_negociacao n
         SET proposta_agendada_em = NOW() + INTERVAL '25 minutes',
             proposta_erro = NULL,
             proposta_tentativas = 0,
             proposta_proxima_tentativa_em = NULL,
             proposta_falha_em = NULL
         WHERE n.id = $1
           AND n.proposta_enviada_em IS NULL
           AND EXISTS (
             SELECT 1
             FROM agendamentos a
             WHERE a.id = n.agendamento_id
               AND TRANSLATE(LOWER(TRIM(COALESCE(a.compareceu, ''))),
                 'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc') = 'sim'
               AND COALESCE(a.valor_venda, 0) = 0
               AND COALESCE(a.numero_os, '') = ''
           )
         RETURNING n.proposta_agendada_em`,
        [savedId]
      );
      var deveNotificarProposta = propostaProgramada.rows.length > 0;

      // Notificação assíncrona para admin/central quando negociação é salva
      setImmediate(async function() {
        try {
          var ag = await pool.query(
            `SELECT nome, loja, kommo_lead_id,
                    COALESCE(compareceu, '') AS compareceu,
                    COALESCE(valor_venda, 0)::numeric AS valor_venda,
                    COALESCE(numero_os, '') AS numero_os
             FROM agendamentos WHERE id = $1`,
            [agendamento_id]
          );
          if (!ag.rows.length) return;
          var a = ag.rows[0];
          var cliente = a.nome;
          var loja = a.loja;

          // Notificação padrão de negociação registrada
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

          // Fluxo proposta 25 min — somente quando compareceu mas não comprou.
          // O horário fica persistido no banco para sobreviver a reinícios.
          if (!deveNotificarProposta) return;

          // Notificação imediata para a central, sem duplicar a cada edição.
          await pool.query(
            `INSERT INTO notificacoes (tipo, titulo, mensagem, agendamento_id, destinatarios)
             SELECT $1,$2,$3,$4,$5
             WHERE NOT EXISTS (
               SELECT 1 FROM notificacoes
               WHERE agendamento_id = $4 AND tipo = $1
             )`,
            [
              'proposta_25min',
              '⏱️ Proposta em 25 min — ' + (cliente || 'Lead'),
              (cliente || 'Lead') + ' compareceu mas não comprou em ' + (loja || 'loja') + '. O acompanhamento via WhatsApp foi programado para 25 minutos após o salvamento.',
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
      var loja  = session.loja  || '';

      // Admin e central veem tudo pelo perfil ou e-mail.
      // Demais perfis (gerente, comprador, vendedor…) só veem notificações
      // endereçadas à sua loja específica OU diretamente ao seu e-mail.
      var query, params;
      if (canViewAllStores(session)) {
        query = `
          SELECT id, tipo, titulo, mensagem, agendamento_id, criado_em
          FROM notificacoes
          WHERE ($1 = ANY(destinatarios) OR $2 = ANY(destinatarios))
            AND NOT ($2 = ANY(lidos_por))
          ORDER BY criado_em DESC LIMIT 50`;
        params = [perfil, email];
      } else {
        query = `
          SELECT id, tipo, titulo, mensagem, agendamento_id, criado_em
          FROM notificacoes
          WHERE ($1 = ANY(destinatarios) OR $2 = ANY(destinatarios))
            AND ($3 = ANY(destinatarios) OR $2 = ANY(destinatarios))
            AND NOT ($2 = ANY(lidos_por))
          ORDER BY criado_em DESC LIMIT 50`;
        params = [perfil, email, loja];
      }

      var result = await pool.query(query, params);
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
