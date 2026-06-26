const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

test("Kommo scheduling usa PostgreSQL em vez de GAS", () => {
  const scheduling = fs.readFileSync(path.join(root, "kommo", "scheduling.js"), "utf8");
  const webhook = fs.readFileSync(path.join(root, "kommo", "webhook.js"), "utf8");

  assert.match(scheduling, /require\("pg"\)/);
  assert.match(scheduling, /DATABASE_URL/);
  assert.match(scheduling, /INSERT INTO agendamentos/);
  assert.match(scheduling, /INSERT INTO clientes/);
  assert.doesNotMatch(scheduling, /GAS_DEPLOY_URL|GAS_API_KEY|callGAS|salvarAgendamento|getAgendamentos/);

  assert.match(webhook, /require\("\.\/scheduling"\)/);
  assert.match(webhook, /scheduling\.criarAgendamento/);
  assert.match(webhook, /database:\s+!!process\.env\.DATABASE_URL/);
  assert.doesNotMatch(webhook, /criarAgendamentoNoGAS|GAS_DEPLOY_URL|GAS_API_KEY|salvarAgendamento/);
});
