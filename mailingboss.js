// Integração MailingBoss (Builderall) — sincroniza leads/agendamentos novos
// com a lista de e-mail marketing, marcados com uma tag por loja.
//
// Documentação oficial: MailingBoss 5.0 – Integração API (PDF fornecido pelo cliente).
// Token de autenticação: variável de ambiente MAILINGBOSS_TOKEN (nunca no código).
// Lista de destino: variável de ambiente MAILINGBOSS_LIST_UID (opcional — usa a
// lista "Formulário Padrão / Agendamento Online" por padrão, já cadastrada na conta).

const MAILINGBOSS_HOST = "https://member.mailingboss.com";
const DEFAULT_LIST_UID = "6a201e69f1aba"; // Formulário Padrão / Agendamento Online

function clean(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

function normalizeKey(v) {
  return clean(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tagParaLoja(loja) {
  const key = normalizeKey(loja);
  return key ? `loja-${key}` : "loja-nao-informada";
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(email));
}

// A lista "Agendamento Online" tem um campo de formulário obrigatório TERMO
// (checkbox "Aceito receber e-mails", valor "100") -- quem agenda já está
// fornecendo o contato voluntariamente para isso, então tratamos como
// aceite implícito. Confirmado com o cliente antes de automatizar.
const TERMO_ACEITO_VALUE = "100";

// Faz a chamada real à API do MailingBoss. Lança erro em caso de falha —
// quem chama decide como tratar (sincronizarLead nunca deixa isso vazar).
async function adicionarInscrito({ email, nome, whatsapp, loja, origem }) {
  const token = process.env.MAILINGBOSS_TOKEN;
  if (!token) return { ok: false, skipped: true, reason: "MAILINGBOSS_TOKEN não configurado" };
  if (!emailValido(email)) return { ok: false, skipped: true, reason: "e-mail ausente ou inválido" };

  const listUid = process.env.MAILINGBOSS_LIST_UID || DEFAULT_LIST_UID;
  const partesNome = clean(nome).split(/\s+/).filter(Boolean);
  const fname = partesNome[0] || "";
  const lname = partesNome.slice(1).join(" ");
  const tags = [tagParaLoja(loja), origem ? `origem-${normalizeKey(origem)}` : null]
    .filter(Boolean)
    .join(", ");

  const url = `${MAILINGBOSS_HOST}/integration/index.php/lists/subscribers/create/${token}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: clean(email),
      list_uid: listUid,
      taginternals: tags,
      fname,
      lname,
      PHONE: clean(whatsapp),
      TERMO: TERMO_ACEITO_VALUE,
    }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.status !== "success") {
    throw new Error(`Mailingboss create falhou: ${response.status} ${JSON.stringify(data)}`);
  }
  return { ok: true, data };
}

// Chamado em background (setImmediate) na criação de um agendamento novo --
// nunca deve derrubar nem atrasar a resposta real ao cliente/painel.
async function sincronizarLead(agendamento, origemLabel) {
  const id = agendamento?.id || "";
  try {
    const resultado = await adicionarInscrito({
      email: agendamento?.email,
      nome: agendamento?.nome,
      whatsapp: agendamento?.whatsapp,
      loja: agendamento?.loja,
      origem: origemLabel || agendamento?.origem_sync || agendamento?.origem,
    });
    if (resultado.skipped) {
      console.log(`[Mailingboss] lead ${id} ignorado -- ${resultado.reason}`);
    } else {
      console.log(`[Mailingboss] lead ${id} sincronizado (${agendamento.email})`);
    }
  } catch (error) {
    console.error(`[Mailingboss] erro ao sincronizar lead ${id}:`, error.message);
  }
}

module.exports = { adicionarInscrito, sincronizarLead, tagParaLoja, emailValido, normalizeKey };
