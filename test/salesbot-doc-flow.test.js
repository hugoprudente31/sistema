const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const kommo = require("../kommo/client");

process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.SESSION_TTL_HOURS = "1";
process.env.SALESBOT_SECRET = "test-salesbot-secret";
process.env.KOMMO_WEBHOOK_SECRET = "test-webhook-secret";
process.env.KOMMO_USE_SALESBOT = "true";
process.env.BOT_ENABLED = "true";

const { app } = require("../server");

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test("SalesBot pode enviar resposta diretamente pelo Kommo sem duplicar retorno", async () => {
  const originalDirectSend = process.env.SALESBOT_DIRECT_SEND;
  const originalSendMessageToLead = kommo.sendMessageToLead;
  const sent = [];

  process.env.SALESBOT_DIRECT_SEND = "true";
  kommo.sendMessageToLead = async (leadId, text) => {
    sent.push({ leadId, text });
    return { ok: true };
  };

  try {
    const leadId = `doc-direct-${Date.now()}`;
    const response = await salesbot({
      lead_id: leadId,
      loja: "Ã“ticas Target - Ademar de Barros",
      contact_name: "Cliente Teste",
      message: "oi"
    });

    assert.equal(response.text, "");
    assert.equal(response.sent, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].leadId, leadId);
    assert.match(sent[0].text, /Santo Antonio \/ Target/);
  } finally {
    kommo.sendMessageToLead = originalSendMessageToLead;
    if (originalDirectSend === undefined) {
      delete process.env.SALESBOT_DIRECT_SEND;
    } else {
      process.env.SALESBOT_DIRECT_SEND = originalDirectSend;
    }
  }
});

test("SalesBot continua fluxo oficial do Kommo via return_url", async () => {
  const received = [];
  const callbackServer = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        received.push(JSON.parse(raw || "{}"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });

  try {
    const returnUrl = `http://127.0.0.1:${callbackServer.address().port}/continue`;
    const response = await fetch(baseUrl + "/api/salesbot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        return_url: returnUrl,
        data: {
          secret: "test-salesbot-secret",
          lead_id: `doc-return-${Date.now()}`,
          loja: "Óticas Target - Ademar de Barros",
          contact_name: "Cliente Teste",
          message: "oi",
        },
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.continued, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].execute_handlers[0].handler, "show");
    assert.equal(received[0].execute_handlers[0].params.type, "text");
    assert.match(received[0].execute_handlers[0].params.value, /Santo Antonio \/ Target/);
    assert.match(received[0].execute_handlers[0].params.value, /Informações/);
  } finally {
    await new Promise((resolve) => callbackServer.close(resolve));
  }
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function salesbot(body) {
  const response = await fetch(baseUrl + "/api/salesbot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: "test-salesbot-secret",
      talk_id: "talk-test",
      chat_id: "chat-test",
      ...body,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

const lojas = [
  { id: "gon", loja: "Gonzaga & Santos", titulo: "Gonzaga / Santos", whatsapp: "(13) 99645-3111" },
  { id: "ens", loja: "Óticas TGT Enseada", titulo: "Enseada", whatsapp: "(13) 99721-4862" },
  { id: "pit", loja: "Óticas TGT Pitangueiras", titulo: "Pitangueiras", whatsapp: "(13) 99704-0234" },
  { id: "tgt", loja: "Óticas Target - Ademar de Barros", titulo: "Santo Antonio / Target", whatsapp: "(13) 99785-6493" },
];

for (const loja of lojas) {
  test(`SalesBot envia menu e link de teste de visão para ${loja.id}`, async () => {
    const leadId = `doc-flow-${loja.id}-${Date.now()}`;

    const inicio = await salesbot({ lead_id: leadId, loja: loja.loja, contact_name: "Cliente Teste", message: "oi" });
    assert.match(inicio.text, new RegExp(loja.titulo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(inicio.text, /1️⃣ Informações/);
    assert.match(inicio.text, /5️⃣ Pós Venda/);

    const teste = await salesbot({ lead_id: leadId, loja: loja.loja, message: "2" });
    assert.match(teste.text, /Teste de Visão é 100% Grátis/);
    assert.match(teste.text, /https:\/\/testedevisao\.oticastgt\.com\.br\/home/);
    assert.match(teste.text, new RegExp(loja.loja.split(" - ").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const confirmado = await salesbot({ lead_id: leadId, loja: loja.loja, message: "CONFIRMADO" });
    assert.match(confirmado.text, /registrado/);
  });

  test(`SalesBot informa endereço e WhatsApp correto para ${loja.id}`, async () => {
    const leadId = `doc-info-${loja.id}-${Date.now()}`;

    await salesbot({ lead_id: leadId, loja: loja.loja, message: "oi" });
    const info = await salesbot({ lead_id: leadId, loja: loja.loja, message: "1" });
    assert.match(info.text, /Lentes e Armações/);

    const endereco = await salesbot({ lead_id: leadId, loja: loja.loja, message: "2" });
    assert.match(endereco.text, new RegExp(loja.whatsapp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
}

test("SalesBot executa funis de orçamento, RH e pós-venda", async () => {
  const loja = "Óticas TGT Enseada";

  const orcLead = `doc-orc-${Date.now()}`;
  await salesbot({ lead_id: orcLead, loja, message: "oi" });
  const orc = await salesbot({ lead_id: orcLead, loja, message: "3" });
  assert.match(orc.text, /envie sua receita/);
  const receita = await salesbot({ lead_id: orcLead, loja, message: "segue receita em foto" });
  assert.match(receita.text, /conectar agora/);

  const rhLead = `doc-rh-${Date.now()}`;
  await salesbot({ lead_id: rhLead, loja, message: "oi" });
  const rh = await salesbot({ lead_id: rhLead, loja, message: "4" });
  assert.match(rh.text, /currículo/);
  const curriculo = await salesbot({ lead_id: rhLead, loja, message: "curriculo enviado" });
  assert.match(curriculo.text, /conectar agora/);

  const pvLead = `doc-pv-${Date.now()}`;
  await salesbot({ lead_id: pvLead, loja, message: "oi" });
  const pv = await salesbot({ lead_id: pvLead, loja, message: "5" });
  assert.match(pv.text, /Nota Fiscal/);
  const nf = await salesbot({ lead_id: pvLead, loja, message: "1" });
  assert.match(nf.text, /nota fiscal/);
});
