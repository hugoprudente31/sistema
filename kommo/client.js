// Integração: Kommo CRM — Sistema Óticas Target

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

  async getLead(leadId) {
    return this.request("GET", `/leads/${leadId}?with=contacts`);
  }

  async addNote(leadId, text) {
    const body = [{ entity_id: Number(leadId), note_type: "common", params: { text } }];
    return this.request("POST", "/leads/notes", body).catch((e) =>
      console.error("[Kommo] Erro ao adicionar nota:", e.message)
    );
  }
}

module.exports = new KommoClient();
