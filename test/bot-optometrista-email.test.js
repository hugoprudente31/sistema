const test = require("node:test");
const assert = require("node:assert/strict");

const { formatarHora, comprimirDiasParaTexto } = require("../kommo/scheduling");
const MSG = require("../kommo/bot/messages");

test("formatarHora omite os minutos quando são :00, mantém quando não são", () => {
  assert.equal(formatarHora("10:00:00"), "10h");
  assert.equal(formatarHora("10:00"), "10h");
  assert.equal(formatarHora("14:30"), "14h30");
  assert.equal(formatarHora(null), "");
});

test("comprimirDiasParaTexto agrupa dias consecutivos com o mesmo horário (caso real: Bruna)", () => {
  const dias = [
    { dia: 1, label: "10h às 18h (pausa 14h–15h)" },
    { dia: 2, label: "10h às 18h (pausa 14h–15h)" },
    { dia: 3, label: "10h às 18h (pausa 14h–15h)" },
    { dia: 4, label: "10h às 18h (pausa 14h–15h)" },
    { dia: 5, label: "10h às 18h (pausa 14h–15h)" },
    { dia: 6, label: "10h às 15h (pausa 13h–14h)" },
    { dia: 0, label: "Fechado" },
  ];
  assert.equal(
    comprimirDiasParaTexto(dias),
    "Seg–Sex 10h às 18h (pausa 14h–15h) | Sáb 10h às 15h (pausa 13h–14h) | Dom Fechado"
  );
});

test("comprimirDiasParaTexto não agrupa dias com horários diferentes entre si", () => {
  const dias = [
    { dia: 1, label: "10h às 18h" },
    { dia: 2, label: "10h às 14h" },
    { dia: 3, label: "10h às 18h" },
  ];
  assert.equal(comprimirDiasParaTexto(dias), "Seg 10h às 18h | Ter 10h às 14h | Qua 10h às 18h");
});

test("MSG.infoEndereco usa o horário do optometrista quando disponível, senão cai no horário da loja", () => {
  const loja = { titulo: "Óticas TGT - Pitangueiras", horario: "Seg–Sex 9h às 19h", whatsapp: "(13) 90000-0000" };

  const comOptometrista = MSG.infoEndereco(loja, { nome: "Albertina", horarioTexto: "Seg–Sex 10h às 18h | Sáb 10h às 15h | Dom Fechado" });
  assert.match(comOptometrista, /Albertina/);
  assert.match(comOptometrista, /Seg–Sex 10h às 18h/);
  assert.doesNotMatch(comOptometrista, /Seg–Sex 9h às 19h/);

  const semOptometrista = MSG.infoEndereco(loja, null);
  assert.match(semOptometrista, /Seg–Sex 9h às 19h/);
  assert.doesNotMatch(semOptometrista, /Optometrista/);
});

test("MSG.testeConfirmado mostra o e-mail só quando informado", () => {
  const base = { data_agendamento: "20/08/2026", horario: "10:00", loja: "Óticas TGT Enseada", optometrista: "Melina" };
  assert.doesNotMatch(MSG.testeConfirmado(base), /📧/);
  assert.match(MSG.testeConfirmado({ ...base, email: "cliente@exemplo.com" }), /📧 cliente@exemplo\.com/);
});
