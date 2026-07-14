
-- PostgreSQL — Regras finais TGT: cargos, auditoria, OS, financeiro real e bloqueio de teste
BEGIN;

ALTER TABLE agendamentos
  ADD COLUMN IF NOT EXISTS agendado_por_nome TEXT,
  ADD COLUMN IF NOT EXISTS agendado_por_email TEXT,
  ADD COLUMN IF NOT EXISTS vendedor_atendeu_nome TEXT,
  ADD COLUMN IF NOT EXISTS vendedor_atendeu_email TEXT,
  ADD COLUMN IF NOT EXISTS ultima_alteracao_por_nome TEXT,
  ADD COLUMN IF NOT EXISTS ultima_alteracao_por_email TEXT,
  ADD COLUMN IF NOT EXISTS ultima_alteracao_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS patologia TEXT DEFAULT 'Pendente';

CREATE TABLE IF NOT EXISTS historico_alteracoes_agendamentos (
  id SERIAL PRIMARY KEY,
  agendamento_id INTEGER,
  loja TEXT,
  cliente_nome TEXT,
  acao TEXT,
  payload JSONB,
  feito_por_nome TEXT,
  feito_por_email TEXT,
  criado_em TIMESTAMP DEFAULT NOW()
);

ALTER TABLE historico_alteracoes_agendamentos
  ADD COLUMN IF NOT EXISTS feito_por_perfil TEXT,
  ADD COLUMN IF NOT EXISTS feito_por_loja TEXT,
  ADD COLUMN IF NOT EXISTS registro_anterior JSONB,
  ADD COLUMN IF NOT EXISTS registro_novo JSONB;

CREATE OR REPLACE FUNCTION backup_agendamento_tgt()
RETURNS trigger AS $$
DECLARE
  anterior JSONB;
  novo JSONB;
  registro JSONB;
BEGIN
  IF current_setting('app.audit_managed', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  anterior := CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) ELSE NULL END;
  novo := CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) ELSE NULL END;
  registro := COALESCE(novo, anterior);
  INSERT INTO historico_alteracoes_agendamentos (
    agendamento_id, loja, cliente_nome, acao, payload,
    feito_por_nome, feito_por_perfil, feito_por_loja,
    registro_anterior, registro_novo
  ) VALUES (
    (registro->>'id')::integer, registro->>'loja', registro->>'nome',
    'SISTEMA_' || TG_OP, jsonb_build_object('anterior', anterior, 'novo', novo),
    'Sistema/Integração', 'sistema', registro->>'loja', anterior, novo
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_backup_agendamento_tgt ON agendamentos;
CREATE TRIGGER trg_backup_agendamento_tgt
AFTER INSERT OR UPDATE OR DELETE ON agendamentos
FOR EACH ROW EXECUTE FUNCTION backup_agendamento_tgt();

CREATE TABLE IF NOT EXISTS historico_os (
  id SERIAL PRIMARY KEY,
  agendamento_id INTEGER,
  numero_os TEXT,
  cliente_nome TEXT,
  loja TEXT,
  acao TEXT NOT NULL,
  campo TEXT,
  valor_anterior TEXT,
  valor_novo TEXT,
  usuario_nome TEXT,
  usuario_email TEXT,
  usuario_cargo TEXT,
  criado_em TIMESTAMP DEFAULT NOW()
);

UPDATE agendamentos
SET
  agendado_por_nome = COALESCE(NULLIF(agendado_por_nome,''), NULLIF(responsavel,''), NULLIF(proprietario_nome,''), 'Registro antigo'),
  agendado_por_email = COALESCE(NULLIF(agendado_por_email,''), NULLIF(criado_por_email,''), ''),
  vendedor_atendeu_nome = COALESCE(NULLIF(vendedor_atendeu_nome,''), NULLIF(vendedor_nome,''), NULLIF(consultor_responsavel,''), ''),
  ultima_alteracao_por_nome = COALESCE(NULLIF(ultima_alteracao_por_nome,''), NULLIF(agendado_por_nome,''), NULLIF(responsavel,''), 'Registro antigo'),
  ultima_alteracao_por_email = COALESCE(NULLIF(ultima_alteracao_por_email,''), NULLIF(agendado_por_email,''), NULLIF(criado_por_email,''), ''),
  ultima_alteracao_em = COALESCE(ultima_alteracao_em, atualizado_em, criado_em, NOW());

CREATE OR REPLACE FUNCTION validar_agendamento_tgt()
RETURNS trigger AS $$
DECLARE
  j JSONB;
  nome_cliente TEXT;
  responsavel_registro TEXT;
BEGIN
  j := to_jsonb(NEW);
  nome_cliente := COALESCE(j->>'nome', j->>'nome_completo', j->>'nomecompleto', j->>'cliente_nome', '');
  IF nome_cliente ILIKE '%teste%' THEN
    RAISE EXCEPTION 'Nome de cliente inválido. Não é permitido cadastrar registros com nome TESTE.';
  END IF;
  responsavel_registro := COALESCE(
    NULLIF(NEW.agendado_por_nome, ''),
    NULLIF(j->>'responsavel', ''),
    NULLIF(j->>'proprietario_nome', ''),
    NULLIF(j->>'criado_por_nome', ''),
    NULLIF(NEW.ultima_alteracao_por_nome, ''),
    'Sistema/Landing'
  );
  NEW.agendado_por_nome := COALESCE(NULLIF(NEW.agendado_por_nome, ''), responsavel_registro);
  NEW.ultima_alteracao_por_nome := responsavel_registro;
  NEW.ultima_alteracao_em := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_agendamento_tgt ON agendamentos;
CREATE TRIGGER trg_validar_agendamento_tgt
BEFORE INSERT OR UPDATE ON agendamentos
FOR EACH ROW EXECUTE FUNCTION validar_agendamento_tgt();

CREATE OR REPLACE FUNCTION preencher_auditoria_email_tgt()
RETURNS trigger AS $$
DECLARE
  email_agendador TEXT;
  email_alteracao TEXT;
  email_vendedor TEXT;
BEGIN
  SELECT email INTO email_agendador FROM usuarios WHERE lower(trim(nome)) = lower(trim(NEW.agendado_por_nome)) LIMIT 1;
  SELECT email INTO email_alteracao FROM usuarios WHERE lower(trim(nome)) = lower(trim(NEW.ultima_alteracao_por_nome)) LIMIT 1;
  SELECT email INTO email_vendedor FROM usuarios WHERE lower(trim(nome)) = lower(trim(NEW.vendedor_atendeu_nome)) LIMIT 1;
  NEW.agendado_por_email := COALESCE(NULLIF(NEW.agendado_por_email, ''), email_agendador, NEW.agendado_por_email);
  NEW.ultima_alteracao_por_email := COALESCE(NULLIF(NEW.ultima_alteracao_por_email, ''), email_alteracao, NEW.ultima_alteracao_por_email, NEW.agendado_por_email);
  NEW.vendedor_atendeu_email := COALESCE(NULLIF(NEW.vendedor_atendeu_email, ''), email_vendedor, NEW.vendedor_atendeu_email);
  NEW.ultima_alteracao_em := COALESCE(NEW.ultima_alteracao_em, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_preencher_auditoria_email_tgt ON agendamentos;
CREATE TRIGGER trg_preencher_auditoria_email_tgt
BEFORE INSERT OR UPDATE ON agendamentos
FOR EACH ROW EXECUTE FUNCTION preencher_auditoria_email_tgt();

CREATE UNIQUE INDEX IF NOT EXISTS uniq_agendamento_ativo_slot
ON agendamentos ((LOWER(COALESCE(loja,''))), (LOWER(COALESCE(optometrista,''))), data_agendamento, horario)
WHERE status IN ('Agendado','Confirmado','Compareceu','OS em Andamento')
  AND data_agendamento IS NOT NULL AND horario IS NOT NULL AND horario <> ''
  AND optometrista IS NOT NULL AND optometrista <> '';

CREATE INDEX IF NOT EXISTS idx_agendamentos_loja_data ON agendamentos(loja, data_agendamento);
CREATE INDEX IF NOT EXISTS idx_historico_os_agendamento ON historico_os(agendamento_id);
CREATE INDEX IF NOT EXISTS idx_historico_alteracoes_agendamento ON historico_alteracoes_agendamentos(agendamento_id);

COMMIT;
