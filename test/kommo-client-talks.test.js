const test = require("node:test");
const assert = require("node:assert/strict");

const kommo = require("../kommo/client");

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
