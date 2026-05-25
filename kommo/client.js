// Kommo CRM Client — Sistema Óticas Target

class KommoClient {
  constructor() {
    this.subdomain   = process.env.KOMMO_SUBDOMAIN;
    this.accessToken = process.env.KOMMO_ACCESS_TOKEN;
    this.baseUrl     = `https://${this.subdomain}.kommo.com/api/v4`;
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
    try {
      const data = await this.request("GET", `/talks?filter[lead_id]=${leadId}`);
      return data?._embedded?.talks || [];
    } catch (e) {
      console.error("[Kommo] Erro ao buscar talks:", e.message);
      return [];
    }
  }

  // Envia mensagem — tenta múltiplos endpoints do Kommo
  async sendMessage(talkId, text, chatId = null) {
    const body = { text };

    // Tentativa 1: POST /chats/messages com chat_id no corpo
    if (chatId) {
      try {
        const r = await this.request("POST", `/chats/messages`, { chat_id: chatId, text });
        console.log("[Kommo] ✅ Mensagem enviada via /chats/messages");
        return r;
      } catch (e) {
        console.log(`[Kommo] /chats/messages falhou: ${e.message.slice(0, 80)}`);
      }

      // Tentativa 2: POST /chats/{chatId}/messages
      try {
        const r = await this.request("POST", `/chats/${chatId}/messages`, body);
        console.log("[Kommo] ✅ Mensagem enviada via /chats/{id}/messages");
        return r;
      } catch (e) {
        console.log(`[Kommo] /chats/{id}/messages falhou: ${e.message.slice(0, 80)}`);
      }
    }

    // Tentativa 3: POST /talks/{talkId}/messages
    try {
      const r = await this.request("POST", `/talks/${talkId}/messages`, body);
      console.log("[Kommo] ✅ Mensagem enviada via /talks/{id}/messages");
      return r;
    } catch (e) {
      console.log(`[Kommo] /talks/{id}/messages falhou: ${e.message.slice(0, 80)}`);
      throw e;
    }
  }

  // Envia mensagem buscando o talkId automaticamente pelo leadId
  async sendMessageToLead(leadId, text) {
    const talks = await this.getLeadTalks(leadId);
    if (!talks.length) {
      throw new Error(`Lead ${leadId}: nenhuma conversa encontrada para enviar mensagem`);
    }
    return this.sendMessage(String(talks[0].id), text);
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
