const test = require("node:test");
const assert = require("node:assert/strict");

const kommo = require("../kommo/client");
const MSG = require("../kommo/bot/messages");
const { buildTwoHourMessage } = require("../kommo/reminder");

test("Kommo busca a conversa vinculada ao lead pelo filtro correto", async () => {
  const originalRequest = kommo.request;
  const calls = [];

  kommo.request = async (method, path) => {
    calls.push({ method, path });
    return {
      _embedded: {
        talks: [{
          entity_id: 26946145,
          entity_type: "lead",
          chat_id: "chat-target"
        }]
      }
    };
  };

  try {
    const talks = await kommo.getLeadTalks(26946145);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].path, "/talks?filter[lead_id]=26946145&limit=5");
    assert.equal(talks[0].chat_id, "chat-target");
  } finally {
    kommo.request = originalRequest;
  }
});

test("Kommo envia mensagem ao chat da conversa do lead", async () => {
  const originalGetLeadTalks = kommo.getLeadTalks;
  const originalSendMessage = kommo.sendMessage;
  const sent = [];

  kommo.getLeadTalks = async () => [{
    entity_id: 26946145,
    entity_type: "lead",
    chat_id: "chat-target"
  }];
  kommo.sendMessage = async (talkId, text, chatId) => {
    sent.push({ talkId, text, chatId });
    return { ok: true };
  };

  try {
    await kommo.sendMessageToLead(26946145, "Mensagem teste");
    assert.deepEqual(sent, [{
      talkId: null,
      text: "Mensagem teste",
      chatId: "chat-target"
    }]);
  } finally {
    kommo.getLeadTalks = originalGetLeadTalks;
    kommo.sendMessage = originalSendMessage;
  }
});

test("Kommo inicia Salesbot nativo no lead", async () => {
  const originalRequest = kommo.request;
  const calls = [];
  kommo.request = async (method, path, body) => {
    calls.push({ method, path, body });
    return {};
  };

  try {
    await kommo.launchSalesbot(58013, 26946145);
    assert.deepEqual(calls, [{
      method: "POST",
      path: "/bots/58013/run",
      body: { entity_id: 26946145, entity_type: "leads" },
    }]);
  } finally {
    kommo.request = originalRequest;
  }
});

test("Kommo envia mensagem proativa pelo campo e Salesbot genéricos", async () => {
  const originalUpdateLead = kommo.updateLead;
  const originalLaunchSalesbot = kommo.launchSalesbot;
  const originalBotId = process.env.KOMMO_GENERIC_MESSAGE_SALESBOT_ID;
  const originalFieldId = process.env.KOMMO_GENERIC_MESSAGE_FIELD_ID;
  const calls = [];

  process.env.KOMMO_GENERIC_MESSAGE_SALESBOT_ID = "58737";
  process.env.KOMMO_GENERIC_MESSAGE_FIELD_ID = "773487";
  kommo.updateLead = async (leadId, body) => calls.push({ action: "update", leadId, body });
  kommo.launchSalesbot = async (botId, leadId) => calls.push({ action: "launch", botId, leadId });

  try {
    await kommo.sendProactiveMessage(26946145, " Lembrete de teste ");
    assert.deepEqual(calls, [
      {
        action: "update",
        leadId: 26946145,
        body: {
          custom_fields_values: [{
            field_id: 773487,
            values: [{ value: "Lembrete de teste" }],
          }],
        },
      },
      { action: "launch", botId: 58737, leadId: 26946145 },
    ]);
  } finally {
    kommo.updateLead = originalUpdateLead;
    kommo.launchSalesbot = originalLaunchSalesbot;
    if (originalBotId === undefined) delete process.env.KOMMO_GENERIC_MESSAGE_SALESBOT_ID;
    else process.env.KOMMO_GENERIC_MESSAGE_SALESBOT_ID = originalBotId;
    if (originalFieldId === undefined) delete process.env.KOMMO_GENERIC_MESSAGE_FIELD_ID;
    else process.env.KOMMO_GENERIC_MESSAGE_FIELD_ID = originalFieldId;
  }
});

// Regressão: o campo customizado da Kommo usado por sendProactiveMessage é
// tipo "text" e rejeita valores acima de 256 caracteres (400 "TooLong",
// mensagem nunca sai). Isso já aconteceu de verdade em produção com os
// templates de lembrete 2h, "não compareceu" e "proposta sem compra".
test("Kommo trunca mensagem proativa longa em vez de deixar a Kommo rejeitar", async () => {
  const originalUpdateLead = kommo.updateLead;
  const originalLaunchSalesbot = kommo.launchSalesbot;
  process.env.KOMMO_GENERIC_MESSAGE_SALESBOT_ID = "58737";
  process.env.KOMMO_GENERIC_MESSAGE_FIELD_ID = "773487";
  let valorEnviado = null;
  kommo.updateLead = async (leadId, body) => { valorEnviado = body.custom_fields_values[0].values[0].value; };
  kommo.launchSalesbot = async () => {};

  try {
    const textoLongo = "Palavra ".repeat(60).trim();
    assert.ok(textoLongo.length > 256);
    await kommo.sendProactiveMessage(26946145, textoLongo);
    assert.ok(valorEnviado.length <= 256, `esperado <=256, recebido ${valorEnviado.length}`);
    assert.ok(valorEnviado.endsWith("…"));
    assert.match(valorEnviado, /^Palavra( Palavra)*…$/, "deve cortar em uma palavra inteira, não no meio dela");
  } finally {
    kommo.updateLead = originalUpdateLead;
    kommo.launchSalesbot = originalLaunchSalesbot;
  }
});

test("templates fixos (lembrete 2h, não compareceu, proposta sem compra) cabem no limite de 256 mesmo com o nome de loja mais longo", () => {
  const nomeLongo = "Maria da Silva Santos";
  const lojaLonga = "óticas Target - Ademar de Barros";

  const doisHoras = buildTwoHourMessage({ nome: nomeLongo, horario: "15:30", loja: lojaLonga });
  const naoCompareceu = MSG.naoCompareceu45(nomeLongo, lojaLonga);
  const proposta = MSG.propostaSemCompra(nomeLongo, lojaLonga);

  assert.ok(doisHoras.length <= 256, `lembrete 2h com ${doisHoras.length} chars`);
  assert.ok(naoCompareceu.length <= 256, `não compareceu com ${naoCompareceu.length} chars`);
  assert.ok(proposta.length <= 256, `proposta sem compra com ${proposta.length} chars`);
});
