"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("alertas e relatórios usam WhatsApp Cloud com modelos aprovados", () => {
  const client = read("lib/whatsappCloud.js");
  const jobs = read("lib/operationalWhatsapp.js");
  assert.match(client, /graph\.facebook\.com/);
  assert.match(client, /type:\s*"template"/);
  assert.match(jobs, /tgt_pendencia_operacional/);
  assert.match(jobs, /tgt_relatorio_diario/);
});

test("pendências possuem tolerância, prazo comercial e deduplicação persistente", () => {
  const jobs = read("lib/operationalWhatsapp.js");
  const migration = read("database/migrations/002_whatsapp_operational_notifications.js");
  assert.match(jobs, /ATTENDANCE_PENDING_TOLERANCE_MINUTES/);
  assert.match(jobs, /SALE_RESULT_PENDING_MINUTES/);
  assert.match(jobs, /ON CONFLICT \(tipo, chave, destinatario_whatsapp\) DO UPDATE/);
  assert.match(jobs, /tentativas < 3/);
  assert.match(migration, /UNIQUE \(tipo, chave, destinatario_whatsapp\)/);
});

test("relatório separa venda realizada de venda registrada e respeita a loja", () => {
  const jobs = read("lib/operationalWhatsapp.js");
  assert.match(jobs, /venderam/);
  assert.match(jobs, /vendas_registradas/);
  assert.match(jobs, /recipientsForStore/);
  assert.match(jobs, /todasLojas/);
});

test("contatos operacionais reais ficam fora do repositório", () => {
  const files = ["lib/operationalWhatsapp.js", "lib/whatsappCloud.js", "env.example"];
  const content = files.map(read).join("\n");
  for (const phone of ["13996080365", "13996526610", "13991981407", "13988779221", "13991358310", "13996226293", "13988725231"]) {
    assert.doesNotMatch(content, new RegExp(phone));
  }
});
