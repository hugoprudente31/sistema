// Kommo Scheduling — Sistema Óticas Target
// Consulta disponibilidade e cria agendamentos no GAS

const GAS_URL     = () => process.env.GAS_DEPLOY_URL || "";
const GAS_API_KEY = () => process.env.GAS_API_KEY    || "";

// Fallback — usado quando não há dados suficientes para calcular a loja/data
const TODOS_HORARIOS = [
  "10:00","10:30","11:00","11:30",
  "14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30",
];

// Gera slots de 30 em 30 minutos com pausa para almoço 12h-14h
function generateSlots(startHour, endHour) {
  const slots = [];
  for (let h = startHour; h < endHour; h++) {
    if (h >= 12 && h < 14) continue; // pausa almoço
    slots.push(`${String(h).padStart(2, "0")}:00`);
    slots.push(`${String(h).padStart(2, "0")}:30`);
  }
  return slots;
}

// Retorna os horários do optometrista por loja e data (DD/MM/AAAA)
// Gonzaga & Santos: Seg-Sex 10h-18h | Sáb 10h-18h | Dom fechado
// Demais lojas:     Seg-Sex 10h-18h | Sáb 9h-15h  | Dom fechado
function getHorariosLoja(loja, data) {
  const [dd, mm, yyyy] = (data || "").split("/").map(Number);
  if (!dd || !mm || !yyyy) return TODOS_HORARIOS;

  const date = new Date(yyyy, mm - 1, dd);
  const day  = date.getDay(); // 0=Dom, 6=Sáb

  if (day === 0) return []; // Domingo fechado

  const isGonzaga = /gonzaga|santos/i.test(loja || "");

  if (day === 6) { // Sábado
    if (isGonzaga) return generateSlots(10, 18);
    return generateSlots(9, 15);
  }

  // Seg–Sex: optometrista 10h–18h em todas as lojas
  return generateSlots(10, 18);
}

// Cache simples para evitar múltiplas chamadas ao GAS no mesmo segundo
const _cache = new Map();
const CACHE_TTL = 30_000; // 30 segundos

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  _cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL });
}

// ── Chamada direta ao GAS ────────────────────────────────────────

async function callGAS(fn, args = []) {
  if (!GAS_URL()) throw new Error("GAS_DEPLOY_URL não configurado");

  const params = new URLSearchParams({
    format: "api",
    fn,
    key:  GAS_API_KEY(),
    args: JSON.stringify(args),
  });

  const res = await fetch(`${GAS_URL()}?${params}`, {
    method: "GET",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  const data = await res.json().catch(() => ({ ok: false, error: "Resposta inválida do GAS" }));
  return data;
}

// ── Disponibilidade de horários ──────────────────────────────────

// Retorna lista de horários livres para loja + data (formato DD/MM/AAAA)
async function getHorariosDisponiveis(loja, data) {
  const cacheKey = `disponibilidade|${loja}|${data}`;
  const cached   = cacheGet(cacheKey);
  if (cached) {
    console.log(`[Scheduling] Cache hit — ${loja} / ${data}`);
    return cached;
  }

  try {
    console.log(`[Scheduling] Buscando disponibilidade: ${loja} / ${data}`);
    const result = await callGAS("getAgendamentos", []);

    if (!result?.ok || !Array.isArray(result?.data)) {
      console.log("[Scheduling] GAS não retornou dados válidos — usando todos os horários");
      return TODOS_HORARIOS;
    }

    // Normaliza o nome da loja para comparação
    const normLoja = loja.trim().toLowerCase();

    // Horários já ocupados nesta loja e data
    const ocupados = result.data
      .filter(a => {
        const mesmaLoja = (a.loja || "").trim().toLowerCase() === normLoja;
        const mesmaData = a.data_agendamento === data;
        const ativo     = !["Cancelado", "Não Compareceu"].includes(a.status);
        return mesmaLoja && mesmaData && ativo;
      })
      .map(a => (a.horario || "").trim());

    console.log(`[Scheduling] Ocupados em ${loja} / ${data}:`, ocupados);

    const horariosLoja = getHorariosLoja(loja, data);
    const livres = horariosLoja.filter(h => !ocupados.includes(h));
    cacheSet(cacheKey, livres);
    return livres;

  } catch (e) {
    console.error("[Scheduling] Erro ao buscar disponibilidade:", e.message);
    // Em caso de erro, usa horários da loja como fallback
    return getHorariosLoja(loja, data) || TODOS_HORARIOS;
  }
}

// ── Criação de agendamento ───────────────────────────────────────

async function criarAgendamento({ nome, whatsapp, email, loja, data, horario, leadId }) {
  console.log(`[Scheduling] Criando agendamento: ${nome} — ${loja} — ${data} ${horario}`);

  const dados = {
    nome:             nome    || "Sem nome",
    whatsapp:         whatsapp || "",
    email:            email    || "",
    loja,
    optometrista:     "",
    data_agendamento: data,
    horario,
    origem:           "Kommo Bot",
    observacao:       `Agendado pelo bot${leadId ? ` — Lead Kommo #${leadId}` : ""}`,
    status:           "Agendado",
    kommo_lead_id:    leadId ? String(leadId) : "",
  };

  try {
    const result = await callGAS("salvarAgendamento", [dados]);
    console.log("[Scheduling] GAS respondeu:", JSON.stringify(result).slice(0, 200));

    if (result?.ok) {
      // Invalida cache de disponibilidade para esta loja/data
      _cache.delete(`disponibilidade|${loja}|${data}`);
    }
    return result;
  } catch (e) {
    console.error("[Scheduling] Erro ao criar agendamento:", e.message);
    return { ok: false, error: e.message };
  }
}

// ── Busca contato do lead para pegar WhatsApp ────────────────────

async function getContatoDoLead(kommoClient, leadId) {
  try {
    const lead = await kommoClient.getLead(leadId);
    const contato = lead?._embedded?.contacts?.[0];
    if (!contato) return { nome: null, whatsapp: null, email: null };

    const campos = contato.custom_fields_values || [];
    const phone  = campos.find(c => c.field_code === "PHONE")?.values?.[0]?.value || "";
    const email  = campos.find(c => c.field_code === "EMAIL")?.values?.[0]?.value || "";

    return {
      nome:     contato.name || lead.name || null,
      whatsapp: phone,
      email,
    };
  } catch {
    return { nome: null, whatsapp: null, email: null };
  }
}

module.exports = {
  TODOS_HORARIOS,
  getHorariosLoja,
  getHorariosDisponiveis,
  criarAgendamento,
  getContatoDoLead,
};
