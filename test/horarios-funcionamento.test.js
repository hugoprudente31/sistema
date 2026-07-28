const test = require("node:test");
const assert = require("node:assert/strict");

const {
  jornadaPadrao,
  resolverJornadaLoja,
  gerarSlotsJornada,
  estaOptometristaDisponivel,
  isGonzagaSantosStore
} = require("../lib/horarios");

function fakeClient(rows) {
  return { query: async () => ({ rows }) };
}

test("isGonzagaSantosStore reconhece variações de grafia", () => {
  assert.equal(isGonzagaSantosStore("óticas TGT - Gonzaga"), true);
  assert.equal(isGonzagaSantosStore("Óticas TGT Santos"), true);
  assert.equal(isGonzagaSantosStore("óticas TGT Enseada"), false);
});

test("jornadaPadrao replica exatamente a regra hardcoded de gerarHorariosBase/horarioValidoPorRegra", () => {
  assert.deepEqual(jornadaPadrao("óticas TGT Enseada", 0), {
    aberto: false, horaInicio: null, horaFim: null, intervaloInicio: null, intervaloFim: null, origem: "padrao"
  });
  assert.deepEqual(jornadaPadrao("óticas TGT Enseada", 1), {
    aberto: true, horaInicio: "10:00", horaFim: "18:00", intervaloInicio: "13:00", intervaloFim: "14:00", origem: "padrao"
  });
  assert.deepEqual(jornadaPadrao("óticas TGT Enseada", 6), {
    aberto: true, horaInicio: "10:00", horaFim: "16:00", intervaloInicio: "13:00", intervaloFim: "14:00", origem: "padrao"
  });
  assert.deepEqual(jornadaPadrao("óticas TGT - Gonzaga", 1), {
    aberto: true, horaInicio: "10:00", horaFim: "18:00", intervaloInicio: "14:00", intervaloFim: "15:00", origem: "padrao"
  });
  // Gonzaga aos sábados não tem bloqueio de almoço (mesma regra hoje hardcoded).
  assert.deepEqual(jornadaPadrao("óticas TGT - Gonzaga", 6), {
    aberto: true, horaInicio: "10:00", horaFim: "16:00", intervaloInicio: null, intervaloFim: null, origem: "padrao"
  });
});

test("resolverJornadaLoja cai no padrão quando não há nenhuma linha cadastrada (sem regressão)", async () => {
  const client = fakeClient([]);
  const jornada = await resolverJornadaLoja(client, "óticas TGT Enseada", 1);
  assert.equal(jornada.origem, "padrao");
  assert.deepEqual(jornada, jornadaPadrao("óticas TGT Enseada", 1));
});

test("resolverJornadaLoja usa a configuração do banco quando existe", async () => {
  const client = fakeClient([
    { aberto: true, hora_inicio: "09:00", hora_fim: "19:00", intervalo_inicio: null, intervalo_fim: null }
  ]);
  const jornada = await resolverJornadaLoja(client, "óticas TGT - Gonzaga", 2);
  assert.equal(jornada.origem, "config");
  assert.equal(jornada.horaInicio, "09:00");
  assert.equal(jornada.horaFim, "19:00");
});

test("gerarSlotsJornada gera slots de 15 em 15 min e pula o intervalo", () => {
  const slots = gerarSlotsJornada({ aberto: true, horaInicio: "10:00", horaFim: "10:45", intervaloInicio: "10:15", intervaloFim: "10:30" });
  assert.deepEqual(slots, ["10:00", "10:30", "10:45"]);
});

test("gerarSlotsJornada devolve lista vazia quando a loja está fechada", () => {
  assert.deepEqual(gerarSlotsJornada({ aberto: false }), []);
});

test("estaOptometristaDisponivel: sem nenhuma linha cadastrada, disponível sempre (comportamento atual)", async () => {
  const client = fakeClient([]);
  const disponivel = await estaOptometristaDisponivel(client, { nome: "Dra. Ana", loja: "óticas TGT Enseada", diaSemana: 2, horario: "11:00" });
  assert.equal(disponivel, true);
});

test("estaOptometristaDisponivel: com configuração, só disponível no dia/horário cadastrado", async () => {
  const client = fakeClient([{ dia_semana: 2, hora_inicio: "09:00", hora_fim: "13:00" }]);
  assert.equal(await estaOptometristaDisponivel(client, { nome: "Dra. Ana", loja: "x", diaSemana: 2, horario: "10:00" }), true);
  assert.equal(await estaOptometristaDisponivel(client, { nome: "Dra. Ana", loja: "x", diaSemana: 2, horario: "14:00" }), false);
  assert.equal(await estaOptometristaDisponivel(client, { nome: "Dra. Ana", loja: "x", diaSemana: 4, horario: "10:00" }), false);
});

test("estaOptometristaDisponivel: sem nome informado (ex: 'A definir') não trava a busca", async () => {
  const client = fakeClient([{ dia_semana: 2, hora_inicio: "09:00", hora_fim: "13:00" }]);
  assert.equal(await estaOptometristaDisponivel(client, { nome: "", loja: "x", diaSemana: 2, horario: "23:59" }), true);
});
