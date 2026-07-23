'use strict';
/**
 * Dois bugs reais relatados em produção no bot do Kommo:
 *
 * 1) O bot disparava mesmo com atendimento humano já em andamento. A causa:
 *    _processMessage reativava o bot sozinho sempre que o cliente mandasse
 *    uma mensagem 60s+ depois da última fala do atendente -- e é comum um
 *    cliente levar mais de um minuto para responder a um humano numa
 *    conversa real. O fix remove essa reativação por tempo; o bot só volta
 *    a ativar quando o Kommo sinaliza uma conversa genuinamente nova
 *    (evento add_talk → processNewLead).
 *
 * 2) Se o cliente já disser "quero o endereço" ou "quero fazer teste de
 *    visão" na primeira mensagem, o bot deve responder direto -- sem
 *    obrigar a pessoa a ler o menu e digitar um número pra algo que ela já
 *    deixou claro que quer.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const SM = require("../kommo/bot/stateManager");

process.env.SESSION_SECRET = "salesbot-fixes-secret-com-32-caracteres-ok";
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

test("bot não reativa sozinho no meio de um atendimento humano, mesmo com o cliente demorando pra responder", async () => {
  const leadId = `fix-humano-${Date.now()}`;
  const loja = "Óticas TGT Enseada";

  // Atendente assume a conversa (o que já acontece de verdade via markHumanActivity
  // quando o webhook do Kommo registra uma mensagem com authorType "user").
  SM.markHumanActivity(leadId);

  // Simula o atendente ter respondido há mais de 1 minuto -- cenário normal
  // de uma conversa real (humano não responde instantaneamente).
  const estadoAtual = await SM.getState(leadId);
  SM.setState(leadId, { ...estadoAtual, transferred_at: Date.now() - 90 * 1000 }, { persist: false });

  // Cliente manda outra mensagem na mesma conversa -- o bot NÃO pode responder.
  const resposta = await salesbot({ lead_id: leadId, loja, message: "vocês ainda estão aí?" });
  assert.equal(resposta.text, "", "bot não deve responder enquanto a conversa segue transferida para humano");

  const estadoDepois = await SM.getState(leadId);
  assert.equal(estadoDepois.etapa, "transferido", "o estado deve continuar transferido -- bot não pode se reativar sozinho por tempo decorrido");
});

test("bot detecta pedido de endereço já na primeira mensagem e responde direto, sem menu", async () => {
  const leadId = `fix-endereco-${Date.now()}`;
  const loja = "Óticas TGT Enseada";

  const resposta = await salesbot({ lead_id: leadId, loja, contact_name: "Cliente Teste", message: "Oi, qual o endereço de vocês?" });
  assert.match(resposta.text, /Horário de Funcionamento/, "deve mandar direto a informação de endereço/horário");
  assert.doesNotMatch(resposta.text, /1️⃣ Informações/, "não deve mandar o menu principal quando a intenção já foi dita");

  const estado = await SM.getState(leadId);
  assert.equal(estado.etapa, "info_aguarda_sim_nao", "o estado deve avançar direto para depois da resposta de endereço");
});

test("bot detecta pedido de teste de visão já na primeira mensagem e responde direto, sem menu", async () => {
  const leadId = `fix-testevisao-${Date.now()}`;
  const loja = "Óticas TGT Enseada";

  const resposta = await salesbot({ lead_id: leadId, loja, contact_name: "Cliente Teste", message: "Bom dia, quero fazer teste de visão" });
  assert.match(resposta.text, /Teste de Visão é 100% Grátis/, "deve mandar direto o link/instrução do teste de visão");
  assert.doesNotMatch(resposta.text, /1️⃣ Informações/, "não deve mandar o menu principal quando a intenção já foi dita");

  const estado = await SM.getState(leadId);
  assert.equal(estado.etapa, "tv_aguardando_confirm", "o estado deve avançar direto para aguardar confirmação do teste");
});

test("primeira mensagem sem intenção clara continua indo para o menu normal (sem regressão)", async () => {
  const leadId = `fix-semintencao-${Date.now()}`;
  const loja = "Óticas TGT Enseada";

  const resposta = await salesbot({ lead_id: leadId, loja, contact_name: "Cliente Teste", message: "oi" });
  assert.match(resposta.text, /1️⃣ Informações/, "sem intenção detectada, continua mandando o menu principal normalmente");
});
