'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createPro, TRIAL_USES, TRIAL_KEY, FEATURES } = require('../src/pro');

function fakeVscode(messages) {
  class EventEmitter { constructor() { this.l = []; this.event = (f) => { this.l.push(f); return { dispose() {} }; }; } fire(v) { for (const f of this.l) f(v); } dispose() {} }
  return { EventEmitter, window: { setStatusBarMessage: (m) => messages.push(m) } };
}
function ctx() { const m = new Map(); return { subscriptions: [], globalState: { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); } } }; }

test('3 free tries per tool, counted only after output, then the Pro panel', async () => {
  const msgs = []; const asked = [];
  const license = { isPro: () => false, requirePro: async (title, d) => { asked.push([title, d.surface]); return false; }, onDidChange() {} };
  const p = createPro({ vscode: fakeVscode(msgs), context: ctx(), license });
  assert.equal(TRIAL_USES, 3);
  for (let i = 0; i < 3; i++) { assert.equal(await p.allowed('report'), true); await p.produced('report'); }
  assert.equal(p.left('report'), 0);
  assert.equal(p.left('stale'), 3);
  assert.equal(await p.allowed('report', { surface: 'toolbar' }), false);
  assert.deepEqual(asked, [['Export TODO report', 'toolbar']]);
  assert.equal(await p.allowed('report', { fsPath: '/x', scheme: 'file' }), false);
  assert.equal(asked[1][1], 'ctx');
  assert.match(msgs[2], /free try 3 of 3/);
  assert.deepEqual(p.tries(), { report: 0, delta: 3, stale: 3 });
});

test('a licensed user never uses tries', async () => {
  const c = ctx();
  const p = createPro({ vscode: fakeVscode([]), context: c, license: { isPro: () => true, requirePro: async () => assert.fail('no panel'), onDidChange() {} } });
  for (let i = 0; i < 5; i++) { assert.equal(await p.allowed('delta'), true); await p.produced('delta'); }
  assert.equal(c.globalState.get(TRIAL_KEY), undefined);
});

test('package.json: id, name, keywords, engines, activation, Pro commands', () => {
  const pk = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(`${pk.publisher}.${pk.name}`, 'zovo.zovo-todo-tree');
  assert.ok(pk.displayName.length <= 30);
  assert.ok(pk.displayName.startsWith('TODO Tree'));
  assert.ok(pk.description.startsWith('TODO tree'));
  assert.equal(pk.keywords.length, 5);
  assert.ok(!pk.activationEvents.includes('*'));
  assert.match(pk.engines.vscode, /^\^1\.(7\d|8\d)\./);
  const cmds = pk.contributes.commands.map((c) => c.command);
  for (const c of ['zovoTodo.exportReport', 'zovoTodo.branchDelta', 'zovoTodo.staleTodos', 'zovoTodo.getPro', 'zovoTodo.enterLicenseKey']) assert.ok(cmds.includes(c), c);
  assert.equal(Object.keys(FEATURES).length, 3);
});

test('activation code shows no message on its own and makes no network call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');
  const act = src.slice(src.indexOf('function activate('), src.indexOf('function deactivate('));
  assert.ok(!/show(Information|Warning|Error)Message/.test(act));
  for (const f of ['extension.js', 'scanner.js', 'git.js', 'report.js', 'model.js', 'ignore.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.ok(!/require\(['"](https?|net|tls|dgram)['"]\)|fetch\(/.test(s), f);
  }
});
