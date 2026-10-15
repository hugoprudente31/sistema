"use strict";

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function config() {
  return {
    token: String(process.env.WHATSAPP_CLOUD_ACCESS_TOKEN || "").trim(),
    phoneNumberId: String(process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID || "").trim(),
    apiVersion: String(process.env.WHATSAPP_CLOUD_API_VERSION || "v23.0").trim(),
  };
}

function isConfigured() {
  const current = config();
  return Boolean(current.token && current.phoneNumberId);
}

async function sendTemplate(to, templateName, parameters = [], options = {}) {
  const current = config();
  if (!current.token || !current.phoneNumberId) {
    throw new Error("WhatsApp Cloud API não configurada");
  }
  const recipient = digits(to);
  if (recipient.length < 12) throw new Error("WhatsApp do destinatário inválido");
  if (!templateName) throw new Error("Nome do modelo do WhatsApp não configurado");

  const response = await fetch(
    `https://graph.facebook.com/${current.apiVersion}/${current.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${current.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "template",
        template: {
          name: templateName,
          language: { code: options.language || "pt_BR" },
          components: [{
            type: "body",
            parameters: parameters.map((value) => ({ type: "text", text: String(value ?? "-") })),
          }],
        },
      }),
    }
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error?.message || `HTTP ${response.status}`;
    throw new Error(`WhatsApp Cloud API: ${detail}`);
  }
  return { id: body?.messages?.[0]?.id || null, response: body };
}

module.exports = { digits, config, isConfigured, sendTemplate };
