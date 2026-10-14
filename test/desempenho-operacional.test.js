const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

test('painel de desempenho possui filtros de período, loja, colaborador e função', () => {
  for (const id of ['desInicio', 'desFim', 'desLoja', 'desColaborador', 'desPerfil']) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /data-admin-area="desempenho"/);
  assert.match(html, /Venda realizada é o resultado comercial/);
  assert.match(html, /Venda registrada possui número de OS ou valor/);
});

test('API de desempenho é restrita a Admin e separa venda realizada de registrada', () => {
  assert.match(server, /app\.get\("\/api\/admin\/desempenho", requireAdmin/);
  assert.match(server, /vendas_realizadas/);
  assert.match(server, /vendas_registradas/);
  assert.match(server, /perfil_colaborador/);
});

test('eventos operacionais são append-only e gravados junto do backup', () => {
  assert.match(server, /INSERT INTO eventos_operacionais/);
  assert.match(server, /BEFORE UPDATE OR DELETE ON eventos_operacionais/);
  assert.match(server, /A trilha de eventos operacionais é imutável/);
});
