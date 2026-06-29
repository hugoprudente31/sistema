// Kommo Recovery — Sistema Óticas Target
// Cron diário: recupera leads frios, não comparecidos e sem resposta

const kommo  = require("./client");
const MSG    = require("./bot/messages");
const SM     = require("./bot/stateManager");
const labels = require("./labels");

const HORAS_48 = 48 * 60 * 60 * 1000;
const HORAS_72 = 72 * 60 * 60 * 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Envia mensagem de recuperação para um lead ───────────────────

async function enviarRecuperacao(leadId) {
  const state = await SM.getState(leadId);

  let talkId = state.talk_id;
  if (!talkId) {
    const talks = await kommo.getLeadTalks(leadId).catch(() => []);
    if (!talks.length) {
      console.log(`[Recovery] Lead ${leadId} sem conversa — pulando`);
      return;
    }
    talkId = String(talks[0].id);
    SM.setState(leadId, { talk_id: talkId });
  }

  const nome = state.nome || "cliente";
  console.log(`[Recovery] Enviando recuperação — ${nome} / lead ${leadId}`);

  await kommo.sendMessage(talkId, MSG.recuperacao(nome));
  await labels.applyLabel(leadId, labels.LABELS.EM_RECUPERACAO);
  await labels.removeLabel(leadId, labels.LABELS.LEAD_FRIO);
  await moveStage(leadId, "recuperacao");

  SM.setState(leadId, {
    etapa:      "menu_principal",
    bot_active: true,
    last_human_at: null, // limpa timer humano para bot assumir
  }, { persist: true });

  await kommo.addNote(leadId, "♻️ Mensagem de recuperação enviada pelo bot");
}

// Move de estágio — lookup por pipeline via KOMMO_STAGES_MAP, fallback env var genérica
async function moveStage(leadId, stageKey) {
  let stagesMap = {};
  try { stagesMap = JSON.parse(process.env.KOMMO_STAGES_MAP || "{}"); } catch {}

  let stageId = null;
  try {
    const lead = await kommo.getLead(leadId);
    const pipelineId = String(lead?.pipeline_id || "");
    stageId = stagesMap[pipelineId]?.[stageKey];
  } catch {}

  if (!stageId) stageId = process.env[`KOMMO_STAGE_${stageKey.toUpperCase()}`];
  if (!stageId) return;
  await kommo.moveToStage(leadId, stageId).catch(() => {});
}

// ── Fecha lead como perdido ──────────────────────────────────────

async function fecharComoPerdido(leadId) {
  console.log(`[Recovery] Fechando lead ${leadId} como perdido`);

  await labels.swapLabel(leadId,
    [labels.LABELS.EM_RECUPERACAO, labels.LABELS.LEAD_FRIO, labels.LABELS.LEAD_MORNO],
    labels.LABELS.FECHADO_PERDIDO
  );
  await moveStage(leadId, "fechado_perdido");
  await kommo.addNote(leadId, "🔴 Lead fechado como perdido — sem resposta após recuperação");
  SM.setState(leadId, { etapa: "transferido", bot_active: false }, { persist: true });
}

// ── Job principal ────────────────────────────────────────────────

async function runRecovery() {
  if (process.env.BOT_ENABLED === "false") return;
  console.log("[Recovery] Iniciando job de recuperação...");

  // 1. Leads que não compareceram → enviar recuperação
  const naoCompareceram = await kommo.searchLeadsByTag(labels.LABELS.NAO_COMPARECEU);
  console.log(`[Recovery] Não compareceram: ${naoCompareceram.length}`);

  for (const lead of naoCompareceram) {
    const state = await SM.getState(lead.id);
    // Evita enviar segunda vez se já está em recuperação
    const jaEmRecuperacao = (lead._embedded?.tags || [])
      .some(t => t.name === labels.LABELS.EM_RECUPERACAO);
    if (jaEmRecuperacao) continue;

    await enviarRecuperacao(String(lead.id)).catch(e =>
      console.error(`[Recovery] Erro lead ${lead.id}:`, e.message)
    );
    await sleep(2000);
  }

  // 2. Leads frios (lead-frio) → enviar recuperação
  const frios = await kommo.searchLeadsByTag(labels.LABELS.LEAD_FRIO);
  console.log(`[Recovery] Leads frios: ${frios.length}`);

  for (const lead of frios) {
    const state = await SM.getState(lead.id);
    const jaEmRecuperacao = (lead._embedded?.tags || [])
      .some(t => t.name === labels.LABELS.EM_RECUPERACAO);
    if (jaEmRecuperacao) continue;

    // Só recupera se inativo há mais de 48h
    const ultimaAtividade = state.last_client_at || state.updated_at || 0;
    if (Date.now() - ultimaAtividade < HORAS_48) continue;

    await enviarRecuperacao(String(lead.id)).catch(e =>
      console.error(`[Recovery] Erro lead ${lead.id}:`, e.message)
    );
    await sleep(2000);
  }

  // 3. Leads em recuperação há mais de 72h sem resposta → fechar como perdido
  const emRecuperacao = await kommo.searchLeadsByTag(labels.LABELS.EM_RECUPERACAO);
  console.log(`[Recovery] Em recuperação: ${emRecuperacao.length}`);

  for (const lead of emRecuperacao) {
    const state = await SM.getState(lead.id);
    const ultimaAtividade = state.last_client_at || state.updated_at || 0;
    if (Date.now() - ultimaAtividade > HORAS_72) {
      await fecharComoPerdido(String(lead.id)).catch(e =>
        console.error(`[Recovery] Erro ao fechar lead ${lead.id}:`, e.message)
      );
      await sleep(2000);
    }
  }

  console.log("[Recovery] Concluído.");
}

// ── Inicializa o cron (setInterval a cada 5 minutos) ─────────────

let recoveryLastRunDate = null;

function startRecoveryCron() {
  const targetHour = parseInt(process.env.RECOVERY_HOUR || "9");

  const tick = () => {
    const now   = new Date();
    const today = now.toDateString();
    const hora  = now.getHours();

    if (hora >= targetHour && recoveryLastRunDate !== today) {
      recoveryLastRunDate = today;
      runRecovery().catch(e => console.error("[Recovery] Erro no job:", e.message));
    }
  };

  setInterval(tick, 5 * 60 * 1000);
  tick();

  console.log(`    Recovery: ✅ cron ativo (roda às ${targetHour}h todos os dias)`);
}

module.exports = { startRecoveryCron, runRecovery };
