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

function jornadaPadrao(loja, diaSemana) {
  if (diaSemana === 0) {
    return { aberto: false, horaInicio: null, horaFim: null, intervaloInicio: null, intervaloFim: null, origem: "padrao" };
  }

  const gonzaga = isGonzagaSantosStore(loja);
  const horaFim = diaSemana === 6 ? "16:00" : "18:00";
  let intervaloInicio = null;
  let intervaloFim = null;

  if (gonzaga) {
    if (diaSemana >= 1 && diaSemana <= 5) {
      intervaloInicio = "14:00";
      intervaloFim = "15:00";
    }
  } else {
    intervaloInicio = "13:00";
    intervaloFim = "14:00";
  }

  return { aberto: true, horaInicio: "10:00", horaFim, intervaloInicio, intervaloFim, origem: "padrao" };
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

  for (let m = inicio; m <= fim; m += 15) {
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
              TO_CHAR(ho.hora_fim,'HH24:MI') AS hora_fim
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
    return doDia.some((r) => hr >= r.hora_inicio && hr < r.hora_fim);
  } catch (error) {
    return true;
  }
}

module.exports = {
  jornadaPadrao,
  resolverJornadaLoja,
  gerarSlotsJornada,
  estaOptometristaDisponivel,
  isGonzagaSantosStore
};
