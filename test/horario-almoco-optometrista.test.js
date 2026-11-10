"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  estaOptometristaDisponivel,
  algumOptometristaComHorarioProprio,
  horarioNaPausaDaLoja,
  liberarPausaDaLoja,
  gerarSlotsJornada,
  jornadaPadrao
} = require("../lib/horarios");

const ENSEADA = "óticas TGT Enseada";

// Banco simulado: "Dra. Ana" tem horário próprio na Enseada às segundas com
// almoço 12:00–13:00; "Bruna" segue o padrão da loja (sem linhas cadastradas).
// A loja não tem jornada cadastrada, então vale o almoço fixo 13:00–14:00.
function bancoEnseada({ semHorarioProprio = false } = {}) {
  const linhasAna = semHorarioProprio ? [] : [{
    dia_semana: 1, hora_inicio: "10:00", hora_fim: "18:00", intervalo_inicio: "12:00", intervalo_fim: "13:00"
  }];
  return {
    query: async (sql, params) => {
      if (sql.includes("horarios_funcionamento_loja")) return { rows: [] };
      if (sql.includes("SELECT 1")) return { rows: !semHorarioProprio && params[1] === 1 ? [{ "?column?": 1 }] : [] };
      if (sql.includes("horarios_optometrista")) {
        return { rows: String(params[0]).toLowerCase() === "dra. ana" ? linhasAna : [] };
      }
      throw new Error("consulta inesperada: " + sql);
    }
  };
}

test("almoço da loja volta para a grade quando um optometrista tem horário próprio", async () => {
  const grade = gerarSlotsJornada(jornadaPadrao(ENSEADA, 1));
  assert.equal(grade.includes("13:00"), false);
  const liberada = await liberarPausaDaLoja(bancoEnseada(), ENSEADA, 1, grade);
  assert.deepEqual(liberada.filter((h) => h >= "12:40" && h <= "14:00"), ["12:40", "13:00", "13:20", "13:40", "14:00"]);
});

test("sem nenhum optometrista com horário próprio a grade não muda", async () => {
  const grade = gerarSlotsJornada(jornadaPadrao(ENSEADA, 1));
  assert.deepEqual(await liberarPausaDaLoja(bancoEnseada({ semHorarioProprio: true }), ENSEADA, 1, grade), grade);
  // Em outro dia sem linha cadastrada também não muda.
  const terca = gerarSlotsJornada(jornadaPadrao(ENSEADA, 2));
  assert.deepEqual(await liberarPausaDaLoja(bancoEnseada(), ENSEADA, 2, terca), terca);
});

test("optometrista com horário próprio segue a pausa dela, não a da loja", async () => {
  const db = bancoEnseada();
  const ana = (horario) => estaOptometristaDisponivel(db, { nome: "Dra. Ana", loja: ENSEADA, diaSemana: 1, horario });
  assert.equal(await ana("12:00"), false);
  assert.equal(await ana("12:40"), false);
  assert.equal(await ana("13:00"), true);
  assert.equal(await ana("13:40"), true);
});

test("optometrista sem horário próprio continua bloqueado no almoço da loja", async () => {
  const db = bancoEnseada();
  const bruna = (horario) => estaOptometristaDisponivel(db, { nome: "Bruna", loja: ENSEADA, diaSemana: 1, horario });
  assert.equal(await bruna("12:00"), true);
  assert.equal(await bruna("13:00"), false);
  assert.equal(await bruna("13:40"), false);
  assert.equal(await bruna("14:00"), true);
  // "A definir" também não pega o almoço da loja.
  assert.equal(await estaOptometristaDisponivel(db, { nome: "A definir", loja: ENSEADA, diaSemana: 1, horario: "13:00" }), false);
});

test("helpers de pausa da loja", async () => {
  const db = bancoEnseada();
  assert.equal(await algumOptometristaComHorarioProprio(db, ENSEADA, 1), true);
  assert.equal(await algumOptometristaComHorarioProprio(db, ENSEADA, 3), false);
  assert.equal(await horarioNaPausaDaLoja(db, ENSEADA, 1, "13:20"), true);
  assert.equal(await horarioNaPausaDaLoja(db, ENSEADA, 1, "14:00"), false);
  assert.equal(await horarioNaPausaDaLoja(db, ENSEADA, 0, "13:00"), false);
});

test("painel: almoço da loja só aceita optometrista com horário próprio que atende no horário", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const fonte = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const inicio = fonte.indexOf("async function validarPausaDaLojaPainel");
  const fim = fonte.indexOf("\nfunction horarioValidoPorRegra", inicio);
  assert.ok(inicio >= 0 && fim > inicio, "validarPausaDaLojaPainel não encontrada");
  const contexto = {
    horarioNaPausaDaLoja,
    estaOptometristaDisponivel,
    clean: (v) => (v == null ? "" : String(v).trim())
  };
  vm.runInNewContext(fonte.slice(inicio, fim), contexto);
  const validar = (horario, optometrista) => contexto.validarPausaDaLojaPainel(bancoEnseada(), {
    loja: ENSEADA, data: "2026-11-16", horario, optometrista // segunda-feira
  });

  assert.equal(await validar("13:00", "Dra. Ana"), null);
  assert.match(await validar("13:00", "Bruna"), /almoço da loja/);
  assert.match(await validar("13:00", ""), /almoço da loja/);
  assert.match(await validar("13:00", "A definir"), /almoço da loja/);
  assert.equal(await validar("11:00", "Bruna"), null);
});
