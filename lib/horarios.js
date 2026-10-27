// Jornada semanal configurável (por loja e por optometrista).
// Usado tanto por server.js (landing page / API pública) quanto por
// kommo/scheduling.js (bot do WhatsApp), para que os dois caminhos nunca
// fiquem dessincronizados sobre quais horários estão realmente disponíveis.
//
// Regra de ouro: se não houver linha cadastrada em
// horarios_funcionamento_loja / horarios_optometrista, o comportamento é
// idêntico ao hardcoded que já existia antes desta feature (jornadaPadrao()
// replica exatamente as regras de gerarHorariosBase/horarioValidoPorRegra em
// server.js e getHorariosLoja em kommo/scheduling.js).

function clean(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

const INTERVALO_ATENDIMENTO_MINUTOS = 20;

// Agendamentos ainda por acontecer. "Reagendado" é um agendamento ativo
// como qualquer outro: precisa de lembrete, protege o lead da recuperação
// de frios e segura o horário na agenda.
const STATUS_AGENDA_PENDENTES = ["Agendado", "Reagendado", "Confirmado"];

// Status que ocupam o horário do optometrista.
const STATUS_QUE_OCUPAM_HORARIO = [
  ...STATUS_AGENDA_PENDENTES,
  "Compareceu",
  "OS em Andamento"
];

// Condição SQL de choque de horário: dois atendimentos conflitam quando
// começam a menos de INTERVALO_ATENDIMENTO_MINUTOS um do outro. Comparar
// só o texto exato deixava passar sobreposições entre a grade antiga de
// 15 minutos (10:15, 10:45...) e a nova de 20 (10:20, 10:40...). O CASE
// garante que horários fora do formato HH:MM nunca sejam convertidos para
// TIME (o que derrubaria a consulta); nesses casos vale a igualdade exata.
const HORARIO_SQL_REGEX = "^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$";
function sqlHorarioConflita(colunaSql, parametroSql) {
  return `(CASE
    WHEN COALESCE(${colunaSql}, '') ~ '${HORARIO_SQL_REGEX}' AND COALESCE(${parametroSql}::text, '') ~ '${HORARIO_SQL_REGEX}'
      THEN ABS(EXTRACT(EPOCH FROM (${colunaSql}::time - ${parametroSql}::text::time))) < ${INTERVALO_ATENDIMENTO_MINUTOS * 60}
    ELSE ${colunaSql} = ${parametroSql}::text
  END)`;
}

const DIACRITICS_REGEX = new RegExp("[\\u0300-\\u036f]", "g");

function stripAccents(v) {
  return clean(v)
    .toLowerCase()
    .normalize("NFD")
    .replace(DIACRITICS_REGEX, "");
}

function isGonzagaSantosStore(loja) {
  const key = stripAccents(loja);
  return key.includes("gonzaga") || key.includes("santos");
}

function isAdemarDeBarrosStore(loja) {
  return stripAccents(loja).includes("ademar");
}

// Almoço padrão (sem jornada cadastrada no painel):
// - Gonzaga (Santos): 13:00–14:00 de segunda a sexta; sábado sem intervalo.
// - Ademar de Barros: 14:00–15:00 de segunda a sábado.
// - Enseada e Pitangueiras: 13:00–14:00 de segunda a sábado.
function intervaloAlmocoPadrao(loja, diaSemana) {
  if (diaSemana === 0) return null;
  if (isGonzagaSantosStore(loja)) {
    return diaSemana >= 1 && diaSemana <= 5 ? { inicio: "13:00", fim: "14:00" } : null;
  }
  if (isAdemarDeBarrosStore(loja)) return { inicio: "14:00", fim: "15:00" };
  return { inicio: "13:00", fim: "14:00" };
}

// Sábado: Santos (Gonzaga) atende até 16:00; as lojas do Guarujá
// (Enseada, Pitangueiras e Ademar de Barros) até 15:00.
function horaFimSabado(loja) {
  return isGonzagaSantosStore(loja) ? "16:00" : "15:00";
}

function minutosFimSabado(loja) {
  return isGonzagaSantosStore(loja) ? 16 * 60 : 15 * 60;
}

function jornadaPadrao(loja, diaSemana) {
  if (diaSemana === 0) {
    return { aberto: false, horaInicio: null, horaFim: null, intervaloInicio: null, intervaloFim: null, origem: "padrao" };
  }

  const horaFim = diaSemana === 6 ? horaFimSabado(loja) : "18:00";
  const almoco = intervaloAlmocoPadrao(loja, diaSemana);

  return {
    aberto: true,
    horaInicio: "10:00",
    horaFim,
    intervaloInicio: almoco ? almoco.inicio : null,
    intervaloFim: almoco ? almoco.fim : null,
    origem: "padrao"
  };
}

async function resolverJornadaLoja(client, lojaCanonica, diaSemana) {
  try {
    const { rows } = await client.query(
      `SELECT aberto,
              TO_CHAR(hora_inicio,'HH24:MI') AS hora_inicio,
              TO_CHAR(hora_fim,'HH24:MI') AS hora_fim,
              TO_CHAR(intervalo_inicio,'HH24:MI') AS intervalo_inicio,
              TO_CHAR(intervalo_fim,'HH24:MI') AS intervalo_fim
         FROM horarios_funcionamento_loja
        WHERE LOWER(loja) = LOWER($1) AND dia_semana = $2
        LIMIT 1`,
      [clean(lojaCanonica), diaSemana]
    );
    if (!rows.length) return jornadaPadrao(lojaCanonica, diaSemana);
    const row = rows[0];
    return {
      aberto: row.aberto,
      horaInicio: row.hora_inicio,
      horaFim: row.hora_fim,
      intervaloInicio: row.intervalo_inicio,
      intervaloFim: row.intervalo_fim,
      origem: "config"
    };
  } catch (error) {
    return jornadaPadrao(lojaCanonica, diaSemana);
  }
}

function gerarSlotsJornada(jornada) {
  if (!jornada || !jornada.aberto || !jornada.horaInicio || !jornada.horaFim) return [];

  const [hIni, mIni] = jornada.horaInicio.split(":").map(Number);
  const [hFim, mFim] = jornada.horaFim.split(":").map(Number);
  const inicio = hIni * 60 + mIni;
  const fim = hFim * 60 + mFim;
  const slots = [];

  for (let m = inicio; m <= fim; m += INTERVALO_ATENDIMENTO_MINUTOS) {
    const hh = String(Math.floor(m / 60)).padStart(2, "0");
    const mm = String(m % 60).padStart(2, "0");
    const h = `${hh}:${mm}`;
    if (jornada.intervaloInicio && jornada.intervaloFim && h >= jornada.intervaloInicio && h < jornada.intervaloFim) continue;
    slots.push(h);
  }

  return slots;
}

// Sem nenhuma linha cadastrada para o optometrista -> disponível sempre
// (comportamento atual). Com linhas cadastradas, só fica disponível nos
// dias/horários explicitamente configurados.
async function estaOptometristaDisponivel(client, { nome, loja, diaSemana, horario }) {
  const nomeClean = clean(nome);
  if (!nomeClean) return true;

  try {
    const { rows } = await client.query(
      `SELECT ho.dia_semana,
              TO_CHAR(ho.hora_inicio,'HH24:MI') AS hora_inicio,
              TO_CHAR(ho.hora_fim,'HH24:MI') AS hora_fim,
              TO_CHAR(ho.intervalo_inicio,'HH24:MI') AS intervalo_inicio,
              TO_CHAR(ho.intervalo_fim,'HH24:MI') AS intervalo_fim
         FROM horarios_optometrista ho
         JOIN optometristas o ON o.id = ho.optometrista_id
        WHERE LOWER(o.nome) = LOWER($1)
          AND LOWER(REGEXP_REPLACE(COALESCE(o.loja,''), '\\s*-\\s*', ' ', 'g')) = LOWER(REGEXP_REPLACE($2, '\\s*-\\s*', ' ', 'g'))`,
      [nomeClean, clean(loja)]
    );
    if (!rows.length) return true;

    const doDia = rows.filter((r) => r.dia_semana === diaSemana);
    if (!doDia.length) return false;

    const hr = clean(horario);
    return doDia.some((r) => {
      if (hr < r.hora_inicio || hr >= r.hora_fim) return false;
      if (r.intervalo_inicio && r.intervalo_fim && hr >= r.intervalo_inicio && hr < r.intervalo_fim) return false;
      return true;
    });
  } catch (error) {
    return true;
  }
}

module.exports = {
  INTERVALO_ATENDIMENTO_MINUTOS,
  STATUS_AGENDA_PENDENTES,
  STATUS_QUE_OCUPAM_HORARIO,
  sqlHorarioConflita,
  horaFimSabado,
  minutosFimSabado,
  jornadaPadrao,
  resolverJornadaLoja,
  gerarSlotsJornada,
  estaOptometristaDisponivel,
  isGonzagaSantosStore,
  isAdemarDeBarrosStore,
  intervaloAlmocoPadrao
};
