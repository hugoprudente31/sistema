// Kommo CRM Client — Sistema Óticas Target

// O campo customizado usado por sendProactiveMessage é do tipo "text" no
// Kommo, que rejeita qualquer valor acima de 256 caracteres (400 "TooLong",
// mensagem nunca sai). Os templates fixos (kommo/bot/messages.js,
// kommo/reminder.js) já foram desenhados pra caber sozinhos, mas mensagens
// de texto livre (ex.: o atendente digitando no CRM) não têm limite
// nenhum — este corte é a rede de segurança pra essas, cortando em uma
// palavra inteira sempre que possível em vez de no meio dela.
function truncarParaCampoKommo(text, max = 256) {
  const limpo = String(text).trim();
  if (limpo.length <= max) return limpo;
  const cortado = limpo.slice(0, max - 1);
  const ultimoEspaco = cortado.lastIndexOf(" ");
  const semPalavraPartida = ultimoEspaco > max * 0.7 ? cortado.slice(0, ultimoEspaco) : cortado;
  return semPalavraPartida.trimEnd() + "…";
}

class KommoClient {
  constructor() {
    this.subdomain   = process.env.KOMMO_SUBDOMAIN;
    this.accessToken = process.env.KOMMO_ACCESS_TOKEN;
    this.baseUrl     = `https://${this.subdomain}.kommo.com/api/v4`;
  }

  // Permite trocar as credenciais em tempo de execução (ex.: painel de
  // Configurações salvando no banco), sem precisar reiniciar o processo —
  // como este client é um singleton (module.exports = new KommoClient()),
  // todo mundo que já deu require('./client') enxerga a mudança na hora.
  reconfigure({ subdomain, accessToken } = {}) {
    if (subdomain) this.subdomain = subdomain;
    if (accessToken) this.accessToken = accessToken;
    this.baseUrl = `https://${this.subdomain}.kommo.com/api/v4`;
  }

  async request(method, path, body = null) {
    if (!this.accessToken || !this.subdomain) {
      throw new Error("KOMMO_ACCESS_TOKEN ou KOMMO_SUBDOMAIN não configurado");
    }
    const opts = {
      method,
      headers: {
        "Authorization": `Bearer ${this.accessToken}`,
        "Content-Type":  "application/json",
      },
      signal: AbortSignal.timeout(15000),
    };
    if (body) opts.body = JSON.stringify(body);

    const res  = await fetch(`${this.baseUrl}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Kommo ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
    return data;
  }

  // ── Contatos ────────────────────────────────────────────────

  async findContact(query) {
    try {
      const data = await this.request("GET", `/contacts?query=${encodeURIComponent(query)}&limit=1`);
      return data?._embedded?.contacts?.[0] || null;
    } catch { return null; }
  }

  async createContact({ nome, whatsapp, email }) {
    const body = [{
      name: nome,
      custom_fields_values: [
        whatsapp && { field_code: "PHONE", values: [{ value: whatsapp, enum_code: "WORK" }] },
        email    && { field_code: "EMAIL", values: [{ value: email,    enum_code: "WORK" }] },
      ].filter(Boolean),
    }];
    const data = await this.request("POST", "/contacts", body);
    return data?._embedded?.contacts?.[0];
  }

  // ── Leads ────────────────────────────────────────────────────

  async getLead(leadId) {
    return this.request("GET", `/leads/${leadId}?with=contacts,tags`);
  }

  async getContact(contactId) {
    return this.request("GET", `/contacts/${contactId}`);
  }

  // Busca contatos vinculados a um lead — retorna objetos completos com name
  async getContactsByLead(leadId) {
    try {
      const data = await this.request("GET", `/contacts?filter[leads_id][]=${leadId}&limit=1`);
      return data?._embedded?.contacts || [];
    } catch { return []; }
  }
  async createLead({ nome, contactId, customFields = [] }) {
    const body = [{
      name:      `Agendamento — ${nome}`,
      _embedded: { contacts: [{ id: contactId }] },
      custom_fields_values: customFields,
    }];
    const data = await this.request("POST", "/leads", body);
    return data?._embedded?.leads?.[0];
  }

  async updateLead(leadId, fields) {
    return this.request("PATCH", `/leads/${leadId}`, fields);
  }

  // Starts a native Salesbot on a lead. Kommo requires this route when the
  // conversation channel belongs to another connected integration.
  async launchSalesbot(botId, leadId) {
    if (!botId) throw new Error("ID do Salesbot nao configurado");
    if (!leadId) throw new Error("ID do lead nao informado");
    return this.request("POST", `/bots/${Number(botId)}/run`, {
      entity_id: Number(leadId),
      entity_type: "leads",
    });
  }

  // Move o lead para um estágio do pipeline
  async moveToStage(leadId, stageId) {
    if (!stageId) return;
    return this.request("PATCH", `/leads/${leadId}`, { status_id: Number(stageId) });
  }

  // ── Tags (Etiquetas) ─────────────────────────────────────────

  async getLeadTags(leadId) {
    try {
      const lead = await this.request("GET", `/leads/${leadId}?with=tags`);
      return lead?._embedded?.tags || [];
    } catch { return []; }
  }

  // Substitui TODAS as tags do lead pela lista fornecida
  async setLeadTags(leadId, tagNames = []) {
    const tags = tagNames.map(name => ({ name }));
    return this.request("PATCH", `/leads/${leadId}`, { _embedded: { tags } });
  }

  // ── Mensagens (Talks / Inbox) ─────────────────────────────────

  // Retorna as conversas (talks) associadas ao lead
  async getLeadTalks(leadId) {
    const paths = [
      `/talks?filter[lead_id]=${leadId}&limit=5`,
      `/talks?filter[entity_type]=leads&filter[entity_id]=${leadId}&limit=5`,
      `/leads/${leadId}/talks?limit=5`,
    ];
    for (const path of paths) {
      try {
        const data = await this.request("GET", path);
        const talks = data?._embedded?.talks || [];
        if (talks.length) {
          console.log(`[Kommo] Talks encontradas via ${path.split("?")[0]}`);
          return talks;
        }
      } catch {}
    }
    console.warn(`[Kommo] Nenhuma talk encontrada para lead ${leadId}`);
    return [];
  }

  // Envia mensagem — testa múltiplos formatos de endpoint do Kommo
  async sendMessage(talkId, text, chatId = null) {

    const attempts = [
      // 1: endpoint correto da API v4 para inbox — chat_id no corpo
      ...(chatId ? [
        () => this.request("POST", `/chats/messages`, { chat_id: chatId, text }),
      ] : []),
      // 2: array body em /talks/{id}/messages
      ...(talkId ? [
        () => this.request("POST",  `/talks/${talkId}/messages`, [{ text }]),
      // 3: objeto simples em /talks/{id}/messages
        () => this.request("POST",  `/talks/${talkId}/messages`, { text }),
      ] : []),
      // 4: /chats/{chatId}/messages — variação de path
      ...(chatId ? [
        () => this.request("POST", `/chats/${chatId}/messages`, { text }),
        () => this.request("POST", `/chats/${chatId}/messages`, [{ text }]),
      ] : []),
      // 5: PATCH /talks/{id}
      ...(talkId ? [
        () => this.request("PATCH", `/talks/${talkId}`,          { messages: [{ text }] }),
      ] : []),
    ];

    for (let i = 0; i < attempts.length; i++) {
      try {
        const r = await attempts[i]();
        console.log(`[Kommo] ✅ Mensagem enviada — tentativa ${i + 1}`);
        return r;
      } catch (e) {
        console.log(`[Kommo] Tentativa ${i + 1} falhou: ${e.message.slice(0, 80)}`);
      }
    }

    throw new Error("Kommo: todos os endpoints de envio falharam");
  }

  // Envia mensagem buscando o talkId automaticamente pelo leadId
  async sendMessageToLead(leadId, text) {
    const talks = await this.getLeadTalks(leadId);
    if (!talks.length) {
      throw new Error(`Lead ${leadId}: nenhuma conversa encontrada para enviar mensagem`);
    }
    const talk = talks[0];
    return this.sendMessage(talk.id ? String(talk.id) : null, text, talk.chat_id || null);
  }

  // Mensagens proativas do WhatsApp precisam sair por um Salesbot nativo.
  // A API v4 de chats não permite que esta integração publique diretamente
  // em canais pertencentes ao WhatsApp/WABA conectado à conta.
  async sendProactiveMessage(leadId, text) {
    const botId = Number(process.env.KOMMO_GENERIC_MESSAGE_SALESBOT_ID || 58737);
    const fieldId = Number(process.env.KOMMO_GENERIC_MESSAGE_FIELD_ID || 773487);
    if (!leadId) throw new Error("ID do lead nao informado");
    if (!text || !String(text).trim()) throw new Error("Mensagem proativa vazia");
    if (!botId || !fieldId) throw new Error("Salesbot generico de mensagens nao configurado");

    await this.updateLead(leadId, {
      custom_fields_values: [{
        field_id: fieldId,
        values: [{ value: truncarParaCampoKommo(text) }],
      }],
    });
    return this.launchSalesbot(botId, leadId);
  }

  // ── Notas ─────────────────────────────────────────────────────

  async addNote(leadId, text) {
    const body = [{ entity_id: Number(leadId), note_type: "common", params: { text } }];
    return this.request("POST", "/leads/notes", body).catch(e =>
      console.error("[Kommo] Erro ao adicionar nota:", e.message)
    );
  }

  // Nota de serviço — usada para persistir estado do bot (não aparece no feed principal)
  async addServiceNote(leadId, text) {
    const body = [{ entity_id: Number(leadId), note_type: "service_message", params: { service: "bot", text } }];
    return this.request("POST", "/leads/notes", body).catch(e =>
      console.error("[Kommo] Erro ao adicionar nota de serviço:", e.message)
    );
  }

  async getLeadNotes(leadId) {
    try {
      const data = await this.request("GET", `/leads/${leadId}/notes?limit=50&order[id]=desc`);
      return data?._embedded?.notes || [];
    } catch { return []; }
  }

  // Busca leads que possuem uma etiqueta específica
  async searchLeadsByTag(tagName, limit = 50) {
    try {
      const data = await this.request(
        "GET",
        `/leads?filter[tags][]=${encodeURIComponent(tagName)}&limit=${limit}&with=tags`
      );
      return data?._embedded?.leads || [];
    } catch (e) {
      console.error(`[Kommo] Erro ao buscar leads por tag "${tagName}":`, e.message);
      return [];
    }
  }

  // Busca leads em um estágio específico
  async searchLeadsByStage(stageId, limit = 50) {
    try {
      const data = await this.request(
        "GET",
        `/leads?filter[statuses][0][status_id]=${stageId}&limit=${limit}`
      );
      return data?._embedded?.leads || [];
    } catch (e) {
      console.error(`[Kommo] Erro ao buscar leads por estágio ${stageId}:`, e.message);
      return [];
    }
  }
}

module.exports = new KommoClient();
