// Kommo cold-lead recovery - native Salesbot launcher

const kommo = require("./client");
const SM = require("./bot/stateManager");
const labels = require("./labels");

const HOURS_48 = 48 * 60 * 60 * 1000;
const HOURS_72 = 72 * 60 * 60 * 1000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function moveStage(leadId, stageKey) {
  let stagesMap = {};
  try { stagesMap = JSON.parse(process.env.KOMMO_STAGES_MAP || "{}"); } catch {}

  let stageId = null;
  try {
    const lead = await kommo.getLead(leadId);
    stageId = stagesMap[String(lead?.pipeline_id || "")]?.[stageKey];
  } catch {}

  if (!stageId) stageId = process.env[`KOMMO_STAGE_${stageKey.toUpperCase()}`];
  if (stageId) await kommo.moveToStage(leadId, stageId);
}

async function sendRecovery(leadId) {
  const botId = process.env.KOMMO_RECOVERY_SALESBOT_ID;
  if (!botId) throw new Error("KOMMO_RECOVERY_SALESBOT_ID nao configurado");

  console.log(`[Recovery] Iniciando Salesbot ${botId} no lead ${leadId}`);
  await kommo.launchSalesbot(botId, leadId);

  // Only change state after Kommo accepts the Salesbot launch.
  await labels.applyLabel(leadId, labels.LABELS.EM_RECUPERACAO);
  await labels.removeLabel(leadId, labels.LABELS.LEAD_FRIO);
  await moveStage(leadId, "recuperacao");
  SM.setState(leadId, {
    etapa: "recuperacao_menu",
    bot_active: true,
    last_human_at: null,
  }, { persist: true });
  await kommo.addNote(leadId, "Mensagem de recuperacao iniciada pelo Salesbot");
}

async function closeAsLost(leadId) {
  console.log(`[Recovery] Fechando lead ${leadId} como perdido`);
  await labels.swapLabel(
    leadId,
    [labels.LABELS.EM_RECUPERACAO, labels.LABELS.LEAD_FRIO, labels.LABELS.LEAD_MORNO],
    labels.LABELS.FECHADO_PERDIDO
  );
  await moveStage(leadId, "fechado_perdido");
  await kommo.addNote(leadId, "Lead fechado como perdido - sem resposta apos recuperacao");
  SM.setState(leadId, { etapa: "transferido", bot_active: false }, { persist: true });
}

async function runRecovery() {
  if (process.env.BOT_ENABLED === "false" || process.env.RECOVERY_AUTOMATION_ENABLED === "false") {
    return { enviados: 0, erros: 0, desativado: true };
  }

  console.log("[Recovery] Iniciando job de recuperacao...");
  let enviados = 0;
  let erros = 0;

  const processCandidate = async lead => {
    const alreadyRecovering = (lead._embedded?.tags || [])
      .some(tag => tag.name === labels.LABELS.EM_RECUPERACAO);
    if (alreadyRecovering) return;
    try {
      await sendRecovery(String(lead.id));
      enviados++;
    } catch (error) {
      erros++;
      console.error(`[Recovery] Erro lead ${lead.id}:`, error.message);
    }
    await sleep(2000);
  };

  const missed = await kommo.searchLeadsByTag(labels.LABELS.NAO_COMPARECEU);
  console.log(`[Recovery] Nao compareceram: ${missed.length}`);
  for (const lead of missed) await processCandidate(lead);

  const cold = await kommo.searchLeadsByTag(labels.LABELS.LEAD_FRIO);
  console.log(`[Recovery] Leads frios: ${cold.length}`);
  for (const lead of cold) {
    const state = await SM.getState(lead.id);
    const lastActivity = state.last_client_at || state.updated_at || 0;
    if (Date.now() - lastActivity >= HOURS_48) await processCandidate(lead);
  }

  const recovering = await kommo.searchLeadsByTag(labels.LABELS.EM_RECUPERACAO);
  console.log(`[Recovery] Em recuperacao: ${recovering.length}`);
  for (const lead of recovering) {
    const state = await SM.getState(lead.id);
    const lastActivity = Number(state.last_client_at || state.updated_at || 0);
    // Legacy tags have no reliable recovery timestamp. Never close those
    // automatically; only close leads started by this job and persisted in state.
    const startedByThisJob = state.etapa === "recuperacao_menu" && lastActivity > 0;
    if (startedByThisJob && Date.now() - lastActivity > HOURS_72) {
      try { await closeAsLost(String(lead.id)); }
      catch (error) {
        erros++;
        console.error(`[Recovery] Erro ao fechar lead ${lead.id}:`, error.message);
      }
      await sleep(2000);
    }
  }

  console.log(`[Recovery] Concluido: ${enviados} enviados, ${erros} erros.`);
  return { enviados, erros };
}

function startRecoveryCron() {
  if (process.env.RECOVERY_AUTOMATION_ENABLED === "false") {
    console.log("    Recovery: desativado para validacao");
    return;
  }
  const targetHour = Number.parseInt(process.env.RECOVERY_HOUR || "9", 10);
  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const timer = setTimeout(async () => {
      try { await runRecovery(); }
      catch (error) { console.error("[Recovery] Erro no job:", error.message); }
      scheduleNext();
    }, next.getTime() - now.getTime());
    timer.unref?.();
    console.log(`[Recovery] Proxima execucao: ${next.toString()}`);
  };

  scheduleNext();
  console.log(`    Recovery: cron ativo (${targetHour}h)`);
}

module.exports = { startRecoveryCron, runRecovery };
