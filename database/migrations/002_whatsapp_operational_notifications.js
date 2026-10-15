"use strict";

module.exports = {
  id: "002_whatsapp_operational_notifications",
  description: "Controle idempotente de alertas e relatórios enviados pelo WhatsApp",
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_notificacoes_operacionais (
        id BIGSERIAL PRIMARY KEY,
        tipo TEXT NOT NULL,
        chave TEXT NOT NULL,
        agendamento_id INTEGER REFERENCES agendamentos(id) ON DELETE SET NULL,
        loja TEXT,
        destinatario_nome TEXT,
        destinatario_whatsapp TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pendente'
          CHECK (status IN ('pendente', 'enviado', 'erro')),
        tentativas INTEGER NOT NULL DEFAULT 0,
        payload JSONB,
        provider_message_id TEXT,
        erro TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        enviado_em TIMESTAMPTZ,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tipo, chave, destinatario_whatsapp)
      );

      CREATE INDEX IF NOT EXISTS idx_whatsapp_notificacoes_status
        ON whatsapp_notificacoes_operacionais (status, atualizado_em);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_notificacoes_agendamento
        ON whatsapp_notificacoes_operacionais (agendamento_id, tipo);
    `);
  },
};
