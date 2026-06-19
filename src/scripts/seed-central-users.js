#!/usr/bin/env node
'use strict';

/**
 * Seed: Atendentes Centrais — Óticas Target
 * Cria / atualiza as contas de Gabrielle e Maria Cristina com perfil
 * "atendimento central" (acesso irrestrito a todas as lojas).
 *
 * Uso:
 *   node src/scripts/seed-central-users.js
 *   node src/scripts/seed-central-users.js --dry-run
 *
 * Requer: DATABASE_URL no .env (ou como variável de ambiente).
 */

require('dotenv').config();
const bcrypt = require('bcrypt');
const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');
const SALT    = 12;

// Hashes pré-gerados — altere via PATCH /api/usuarios/:id se precisar trocar a senha
const CENTRAL_USERS = [
  {
    nome:  'Gabrielle',
    email: 'gabrielle@oticastgt.com.br',
    // senha gerada em 2026-06-19: WQxL8Gr@q3qkw
    hash:  '$2b$12$30olRymsKGHL8asKGFyVdOyiHgdpwliWOUOxLvASpaXtZ92VMFL4G',
    cargo: 'atendimento central',
    loja:  null,
    can_view_finance: true,
  },
  {
    nome:  'Maria Cristina',
    email: 'mcfi.tgt@gmail.com.br',
    // senha gerada em 2026-06-19: iM7!k2cP5o!9Q
    hash:  '$2b$12$XpyxuQA7gR6hjVDlW8EJreW81tAiYX/SjUWmacnKU60CDntUmoC.O',
    cargo: 'atendimento central',
    loja:  null,
    can_view_finance: true,
  },
];

function makeGasId(email) {
  return 'usuario-' + email.replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

async function run() {
  if (!process.env.DATABASE_URL) {
    console.error('ERRO: DATABASE_URL não definida. Copie env.example para .env e preencha.');
    process.exit(1);
  }

  const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    console.log(DRY_RUN
      ? '\n[DRY-RUN] Nenhuma alteração será salva no banco.\n'
      : '\nCadastrando atendentes centrais…\n');

    for (const u of CENTRAL_USERS) {
      await client.query(`
        INSERT INTO usuarios
          (gas_id, nome, email, senha, cargo, loja,
           can_view_finance, ativo, origem_sync,
           password_changed_at, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,true,'postgres',
                CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
        ON CONFLICT (email) DO UPDATE SET
          nome              = EXCLUDED.nome,
          senha             = EXCLUDED.senha,
          cargo             = EXCLUDED.cargo,
          loja              = EXCLUDED.loja,
          can_view_finance  = EXCLUDED.can_view_finance,
          ativo             = true,
          origem_sync       = 'postgres',
          password_changed_at = CURRENT_TIMESTAMP,
          atualizado_em     = CURRENT_TIMESTAMP
      `, [makeGasId(u.email), u.nome, u.email, u.hash, u.cargo, u.loja, u.can_view_finance]);

      console.log(`  ✓ ${u.nome} <${u.email}>`);
      console.log(`    Cargo          : ${u.cargo}`);
      console.log(`    Loja           : (todas as lojas)`);
      console.log(`    can_view_finance: ${u.can_view_finance}`);
      console.log('');
    }

    if (DRY_RUN) {
      await client.query('ROLLBACK');
      console.log('[DRY-RUN] Revertido. Nada foi alterado.\n');
    } else {
      await client.query('COMMIT');
      console.log('Cadastro concluído!\n');
    }

    // Verificação final
    const { rows } = await client.query(
      `SELECT id, nome, email, cargo, loja, can_view_finance, ativo,
              LEFT(senha, 7) AS hash_prefix
         FROM usuarios
        WHERE email = ANY($1::text[])
        ORDER BY nome`,
      [CENTRAL_USERS.map(u => u.email)]
    );

    console.log('Verificação no banco:');
    if (rows.length === 0) {
      console.log('  Nenhum registro encontrado (verifique o DATABASE_URL).');
    } else {
      rows.forEach(r => {
        const lojaLabel = r.loja || '(todas)';
        const ok = r.hash_prefix === '$2b$12$' ? '✓ hash ok' : '⚠ hash inválido';
        console.log(`  id=${r.id} | ${r.nome} | ${r.cargo} | loja=${lojaLabel} | finance=${r.can_view_finance} | ativo=${r.ativo} | ${ok}`);
      });
    }
    console.log('');

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('ERRO ao cadastrar:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
