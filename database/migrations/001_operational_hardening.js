"use strict";

module.exports = {
  id: "001_operational_hardening",
  description: "Índices operacionais e histórico dos jobs automáticos",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS automacao_execucoes (
        id BIGSERIAL PRIMARY KEY,
        automacao TEXT NOT NULL,
        iniciado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finalizado_em TIMESTAMPTZ,
        status TEXT NOT NULL DEFAULT 'executando'
          CHECK (status IN ('executando', 'sucesso', 'erro', 'ignorado')),
        processados INTEGER NOT NULL DEFAULT 0,
        enviados INTEGER NOT NULL DEFAULT 0,
        erros INTEGER NOT NULL DEFAULT 0,
        detalhes JSONB,
        erro TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_automacao_execucoes_nome_data
        ON automacao_execucoes (automacao, iniciado_em DESC);
      CREATE INDEX IF NOT EXISTS idx_automacao_execucoes_falhas
        ON automacao_execucoes (iniciado_em DESC)
        WHERE status = 'erro';

      CREATE INDEX IF NOT EXISTS idx_agendamentos_operacao_loja_data
        ON agendamentos (loja, data_agendamento, status)
        WHERE excluido_em IS NULL;
      CREATE INDEX IF NOT EXISTS idx_agendamentos_operacao_data_loja
        ON agendamentos (data_agendamento, loja, id DESC)
        WHERE excluido_em IS NULL;
      CREATE INDEX IF NOT EXISTS idx_agendamentos_followup_nao_compareceu
        ON agendamentos (nao_compareceu_em, id)
        WHERE nao_compareceu_lembrete_em IS NULL
          AND nao_compareceu_em IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_agendamentos_lembrete_2h_pendente
        ON agendamentos (data_agendamento, horario, id)
        WHERE lembrete_2h_em IS NULL
          AND excluido_em IS NULL
          AND kommo_lead_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_negociacao_proposta_due
        ON agendamento_negociacao (proposta_agendada_em, id)
        WHERE proposta_enviada_em IS NULL
          AND proposta_agendada_em IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_notificacoes_tipo_agendamento
        ON notificacoes (tipo, agendamento_id, criado_em DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_sistema_criado_em
        ON logs_sistema (criado_em DESC);
      CREATE INDEX IF NOT EXISTS idx_historico_usuarios_criado_em
        ON historico_usuarios (criado_em DESC);
    `);
  },
};
