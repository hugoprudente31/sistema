const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('venda ativa tem prioridade verde sobre ausência antiga no painel', function() {
  const compra = html.indexOf("if (!cancelado && (venda === 'sim' || valorVenda > 0))");
  const ausencia = html.indexOf("compareceu === 'nao' || compareceu === 'nao compareceu'");
  assert.ok(compra >= 0, 'regra da venda ativa não encontrada');
  assert.ok(ausencia > compra, 'a venda precisa ser avaliada antes da ausência antiga');
});

test('modal permite ao gerente corrigir a presença e mantém a loja travada', function() {
  assert.match(html, /id="editCompareceu"/);
  assert.match(html, /payload\.compareceu = byId\('editCompareceu'\)\.value/);
  assert.match(html, /state\.user\.loja[^]*byId\('editLoja'\)\.disabled = true/);
});

test('servidor normaliza compras novas e corrige compras antigas', function() {
  assert.match(server, /const compareceuVenda = compraAtiva \? "Sim" : null/);
  assert.match(server, /const comprasCorrigidas = await pool\.query/);
  assert.match(server, /SET compareceu = 'Sim'/);
  assert.match(server, /CREATE OR REPLACE FUNCTION validar_agendamento_tgt\(\)[^]*NEW\.compareceu := 'Sim'/);
});

test('IsConcluidaVisual e IsOverdue são calculados (não ficam undefined) e realmente ligados ao selo Status Ag.', function() {
  // statusClassAgendamento lê r.IsConcluidaVisual/r.IsOverdue para colorir o
  // primeiro selo (verde/vermelho) — sem isso ser calculado em algum lugar,
  // o selo nunca muda de cor mesmo quando o atendimento está concluído ou
  // atrasado. Já existiu um bug em que essas duas flags eram lidas, mas
  // nunca calculadas em mapAgendamentoDb (sempre undefined).
  assert.match(html, /if \(r\.IsConcluidaVisual\) return 'green';/, 'statusClassAgendamento deve continuar lendo a flag');
  assert.match(html, /if \(r\.IsOverdue\) return 'red';/, 'statusClassAgendamento deve continuar lendo a flag');
  const mapFnStart = html.indexOf('function mapAgendamentoDb');
  const mapFn = html.slice(mapFnStart, html.indexOf('\nfunction ', mapFnStart + 20));
  assert.match(mapFn, /var isConcluidaVisual = semaforo === 'verde';/, 'IsConcluidaVisual precisa ser calculado dentro de mapAgendamentoDb');
  assert.match(mapFn, /var isOverdue = /, 'IsOverdue precisa ser calculado dentro de mapAgendamentoDb');
  assert.match(mapFn, /IsConcluidaVisual: isConcluidaVisual,/, 'o valor calculado precisa ser retornado no objeto do agendamento');
  assert.match(mapFn, /IsOverdue: isOverdue,/, 'o valor calculado precisa ser retornado no objeto do agendamento');
});

test('gatilho validar_agendamento_tgt não sobrescreve ultima_alteracao_por_nome de quem realmente editou agora', function() {
  // Bug real encontrado em produção: o gatilho preenchia ultima_alteracao_por_nome
  // incondicionalmente com agendado_por_nome (o criador original, "grudento"),
  // apagando o nome de quem de fato fez a alteração atual (ex: a aplicação já
  // tinha gravado corretamente o nome da optometrista, e o gatilho sobrescrevia
  // de volta para o nome de quem criou o agendamento).
  const fnStart = server.indexOf('CREATE OR REPLACE FUNCTION validar_agendamento_tgt()');
  const fnBody = server.slice(fnStart, server.indexOf('$$ LANGUAGE plpgsql', fnStart));
  assert.match(
    fnBody,
    /NEW\.ultima_alteracao_por_nome := COALESCE\(NULLIF\(NEW\.ultima_alteracao_por_nome, ''\), responsavel_registro\);/,
    'só deve preencher ultima_alteracao_por_nome quando ainda estiver vazio, nunca sobrescrever o que a aplicação já gravou'
  );
});

test('interceptor client-side de PATCH não filtra mais campos por perfil (servidor já é a única fonte de verdade)', function() {
  // Bug real encontrado em produção: um allowlist client-side desatualizado
  // apagava resultadoOptometrista/patologia do payload antes mesmo de sair do
  // navegador, para o perfil optometrista — o clique "funcionava" (200 OK)
  // mas nunca mudava nada, porque o campo nem chegava no servidor. O servidor
  // já valida isso corretamente (ver server.js), então o cliente não deve
  // duplicar essa regra.
  const interceptorStart = html.indexOf('// Interceptor PATCH');
  const interceptorEnd = html.indexOf('// Override getAgendamentosPostgres', interceptorStart);
  const interceptorBody = html.slice(interceptorStart, interceptorEnd);
  assert.ok(!/optometrista.*permitido|permitido.*optometrista/is.test(interceptorBody),
    'não deve existir mais um allowlist de campos específico para o optometrista no cliente');
  assert.match(interceptorBody, /resultadoOptometrista|resultado_optometrista|Nao filtramos campos por perfil/,
    'o payload do optometrista precisa poder incluir resultadoOptometrista sem ser filtrado');
});
