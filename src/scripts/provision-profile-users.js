require("dotenv").config();

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const ROLE_ALLOWLIST = new Set([
  "admin",
  "atendimento central",
  "gerente de loja",
  "consultor de vendas",
  "vendedor",
  "comprador",
  "optometrista"
]);

const STORE_MAP = {
  "Ademar de Barros": "óticas Target - Ademar de Barros",
  "Gonzaga": "óticas TGT - Gonzaga",
  "Enseada": "óticas TGT Enseada",
  "Pitangueiras": "óticas TGT Pitangueiras"
};

function fail(message) {
  throw new Error(message);
}

async function main() {
  const credentialsPath = process.argv[2] || process.env.CREDENTIALS_FILE;
  const dryRun = process.argv.includes("--dry-run");
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!credentialsPath) fail("Informe o caminho do arquivo privado de credenciais.");
  if (!connectionString) fail("DATABASE_PUBLIC_URL ou DATABASE_URL não configurada.");

  const resolved = path.resolve(credentialsPath);
  const credentials = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (!Array.isArray(credentials) || credentials.length !== 28) {
    fail("O arquivo deve conter exatamente 28 credenciais.");
  }

  const emails = new Set();
  for (const item of credentials) {
    item.email = String(item.email || "").trim().toLowerCase();
    item.role = String(item.role || "").trim().toLowerCase();
    item.store = String(item.store || "").trim();
    item.password = String(item.password || "");
    if (!item.email.includes("@")) fail("Credencial com e-mail inválido.");
    if (emails.has(item.email)) fail(`E-mail duplicado: ${item.email}`);
    if (!ROLE_ALLOWLIST.has(item.role)) fail(`Cargo não permitido: ${item.role}`);
    if (!STORE_MAP[item.store]) fail(`Loja não reconhecida: ${item.store}`);
    if (item.password.length < 12) fail(`Senha curta para ${item.email}`);
    emails.add(item.email);
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("railway.internal") ? false : { rejectUnauthorized: false }
  });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha TEXT");
    await client.query("ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP");

    let insertedOrUpdated = 0;
    for (const item of credentials) {
      const store = STORE_MAP[item.store];
      const displayName = `${item.display_name} - ${item.store}`;
      const passwordHash = await bcrypt.hash(item.password, 12);
      const canViewFinance = ["admin", "gerente de loja"].includes(item.role);
      const gasId = `usuario:${item.email}`;

      await client.query(
        `INSERT INTO usuarios (
           gas_id, nome, email, senha, cargo, loja, can_view_finance, ativo,
           origem_sync, password_changed_at, atualizado_em
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,'provisioning',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
         ON CONFLICT (email) DO UPDATE SET
           nome = EXCLUDED.nome,
           senha = EXCLUDED.senha,
           cargo = EXCLUDED.cargo,
           loja = EXCLUDED.loja,
           can_view_finance = EXCLUDED.can_view_finance,
           ativo = true,
           origem_sync = 'provisioning',
           password_changed_at = CURRENT_TIMESTAMP,
           atualizado_em = CURRENT_TIMESTAMP`,
        [gasId, displayName, item.email, passwordHash, item.role, store, canViewFinance]
      );
      insertedOrUpdated += 1;
    }

    const check = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM usuarios
       WHERE email = ANY($1::text[]) AND ativo = true AND senha ~ '^\\$2[aby]\\$'`,
      [Array.from(emails)]
    );
    if (check.rows[0].total !== 28) fail("Verificação final não encontrou as 28 contas com hash bcrypt.");

    if (dryRun) await client.query("ROLLBACK");
    else await client.query("COMMIT");
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      provisioned: insertedOrUpdated,
      verified: check.rows[0].total,
      committed: !dryRun
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`Falha ao cadastrar usuários: ${error.message}`);
  process.exit(1);
});
