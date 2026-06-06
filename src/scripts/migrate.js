require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não encontrada nas variáveis de ambiente.');
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false
  });

  const schemaPath = path.join(__dirname, '../../database/schema.sql');

  if (!fs.existsSync(schemaPath)) {
    throw new Error('Arquivo database/schema.sql não encontrado.');
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');

  console.log('Criando tabelas no PostgreSQL...');

  await pool.query(sql);

  console.log('Migração concluída com sucesso.');

  await pool.end();
}

main().catch((error) => {
  console.error('Erro na migração:', error.message);
  process.exit(1);
});
