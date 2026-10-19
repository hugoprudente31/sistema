'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const painel = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('coluna Agendado por abrevia Landing Page como LP seguido do nome da Central', function() {
  assert.match(painel, /\? 'LP ' \+ conta/);
  assert.doesNotMatch(painel, /\? 'Landing Page \(' \+ conta/);
});
