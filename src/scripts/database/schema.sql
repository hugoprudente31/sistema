CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  id_usuario VARCHAR(80),
  email VARCHAR(160) UNIQUE NOT NULL,
  nome VARCHAR(160),
  perfil VARCHAR(80),
  loja VARCHAR(160),
  ativo BOOLEAN DEFAULT TRUE,
  access_tags TEXT,
  can_view_finance BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lojas (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(160) UNIQUE NOT NULL,
  cidade VARCHAR(120),
  ativa BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS optometristas (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(160) NOT NULL,
  loja VARCHAR(160),
  ativo BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS origens (
  id SERIAL PRIMARY KEY,
  nome VARCHAR(120) UNIQUE NOT NULL,
  ativa BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id SERIAL PRIMARY KEY,
  id_original VARCHAR(100),
  data_cadastro TIMESTAMP,
  origem VARCHAR(120),
  nome_completo VARCHAR(180),
  whatsapp VARCHAR(40),
  email VARCHAR(180),
  loja VARCHAR(160),
  optometrista VARCHAR(160),
  responsavel VARCHAR(160),
  data_agendamento DATE,
  horario TIME,
  observacao TEXT,
  status_agenda VARCHAR(80),
  compareceu VARCHAR(40),
  atendimento_realizado VARCHAR(40),
  venda_gerada VARCHAR(40),
  valor_venda NUMERIC(12,2) DEFAULT 0,
  desconto NUMERIC(12,2) DEFAULT 0,
  motivo_perda TEXT,
  consultor_responsavel VARCHAR(160),
  criado_por_email VARCHAR(180),
  ultima_atualizacao TIMESTAMP,
  proprietario_id VARCHAR(100),
  proprietario_nome VARCHAR(160),
  numero_os VARCHAR(100),
  data_abertura_os DATE,
  data_entrada_os DATE,
  data_finalizacao_os DATE,
  data_entrega_os DATE,
  status_os VARCHAR(100),
  access_tags TEXT,
  lead_time_dias INTEGER,
  vendedor_nome VARCHAR(160),
  kommo_lead_id VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ordens_servico (
  id SERIAL PRIMARY KEY,
  id_os_interno VARCHAR(100),
  numero_os VARCHAR(100),
  id_agendamento VARCHAR(100),
  cliente VARCHAR(180),
  loja VARCHAR(160),
  proprietario_id VARCHAR(100),
  proprietario_nome VARCHAR(160),
  vendedor_id VARCHAR(100),
  vendedor_nome VARCHAR(160),
  data_abertura_os DATE,
  data_entrada_os DATE,
  data_finalizacao_os DATE,
  data_entrega_os DATE,
  status_os VARCHAR(100),
  observacao_os TEXT,
  valor_os NUMERIC(12,2) DEFAULT 0,
  desconto NUMERIC(12,2) DEFAULT 0,
  lead_time_dias INTEGER,
  criado_por VARCHAR(180),
  atualizado_por VARCHAR(180),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS presencas (
  id SERIAL PRIMARY KEY,
  id_presenca VARCHAR(100),
  id_agendamento VARCHAR(100),
  cliente VARCHAR(180),
  data_agendamento DATE,
  status_presenca VARCHAR(80),
  marcado_por_id VARCHAR(100),
  marcado_por_nome VARCHAR(160),
  perfil_marcador VARCHAR(80),
  data_marcacao TIMESTAMP,
  observacao TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auditoria_eventos (
  id SERIAL PRIMARY KEY,
  id_evento VARCHAR(100),
  entidade VARCHAR(100),
  id_entidade VARCHAR(100),
  acao VARCHAR(100),
  campo_alterado VARCHAR(120),
  valor_anterior TEXT,
  valor_novo TEXT,
  executado_por_id VARCHAR(100),
  executado_por_nome VARCHAR(160),
  perfil VARCHAR(80),
  data_evento TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sincronizacoes (
  id SERIAL PRIMARY KEY,
  tipo VARCHAR(100),
  mensagem TEXT,
  usuario VARCHAR(180),
  status VARCHAR(50) DEFAULT 'pendente',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
