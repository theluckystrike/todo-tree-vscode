'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const report = require('../src/report');
const { TagStore, buildTree } = require('../src/model');

const NOW = Date.UTC(2026, 10, 12);
const DAY = 86400000;
const items = [
  { rel: 'src/b.js', line: 9, tag: 'FIXME', owner: 'anna', text: 'leak | pipe', author: 'Anna', time: NOW - 400 * DAY, sha: 'a'.repeat(40) },
  { rel: 'src/a.js', line: 0, tag: 'TODO', owner: '', text: '=SUM(A1) "quoted"', author: 'Bob', time: NOW - 10 * DAY, sha: 'b'.repeat(40) },
  { rel: 'src/a.js', line: 4, tag: 'TODO', owner: '', text: 'new', uncommitted: true, sha: '0'.repeat(40) },
];

test('markdown report escapes pipes and sorts by path', () => {
  const md = report.markdown(items, { now: NOW, blame: true, project: 'demo' });
  assert.match(md, /^# TODO report: demo/);
  assert.match(md, /3 tags in 2 files, 2026-11-12\. FIXME 1, TODO 2\./);
  const lines = md.split('\n').filter((l) => l.startsWith('| src'));
  assert.equal(lines[0].split('|')[1].trim(), 'src/a.js');
  assert.ok(md.includes('leak \\| pipe'));
  assert.ok(md.includes('| not committed |'));
  assert.ok(md.includes('| 400 |'));
});

test('csv report quotes and neutralises formulas', () => {
  const c = report.csv(items, { now: NOW, blame: true });
  const rows = c.trim().split('\r\n');
  assert.equal(rows[0], 'file,line,tag,text,owner,author,added,age_days,commit');
  assert.ok(rows[1].includes('"\'=SUM(A1) ""quoted"""'));
  assert.ok(rows[2].includes(',not committed,,,'));
  assert.equal(report.csvCell('plain'), 'plain');
});

test('html report escapes', () => {
  const h = report.html([{ rel: '<x>.js', line: 0, tag: 'TODO', owner: '', text: '<script>alert(1)</script>' }], { now: NOW });
  assert.ok(!h.includes('<script>alert'));
  assert.ok(h.includes('&lt;script&gt;'));
  assert.ok(h.startsWith('<!DOCTYPE html>'));
});

test('stale finder: oldest first, per person, JSON', () => {
  const r = report.stale(items, { minDays: 30, now: NOW });
  assert.equal(r.stale.length, 1);
  assert.equal(r.stale[0].age, 400);
  assert.deepEqual(r.people, [{ who: 'anna', count: 1, oldest: 400 }]);
  const j = JSON.parse(report.staleJson(r, { now: NOW, project: 'demo' }));
  assert.equal(j.staleCount, 1);
  assert.equal(j.stale[0].file, 'src/b.js');
  assert.equal(j.stale[0].line, 10);
  assert.match(report.staleMarkdown(r, { now: NOW }), /1 of 3 tags are 30 days old or older/);
  assert.equal(report.stale(items, { minDays: 0, now: NOW }).stale.length, 2);
});

test('delta markdown', () => {
  const md = report.deltaMarkdown({ head: 'feature', base: 'main', mergeBase: 'c'.repeat(40), added: [{ tag: 'TODO', rel: 'a.js', line: 2, text: 'x' }, { tag: 'NOTE', rel: 'new.py', line: 0, text: 'y', untracked: true }], removed: [], untrackedWithTags: 1 });
  assert.match(md, /2 added, 0 removed \(net \+2\)/);
  assert.ok(md.includes('new.py:1 (new file)'));
  assert.ok(md.includes('## Removed\n\nNone.'));
});

test('store and tree', () => {
  const s = new TagStore();
  s.setRoot('file:///r', 'r', new Map([['src/a/b/x.js', [{ tag: 'TODO', line: 1, col: 3, text: 't', owner: '' }]], ['src/y.js', [{ tag: 'FIXME', line: 3, col: 0, text: 'u', owner: 'bo' }]]]));
  assert.equal(s.counts().total, 2);
  const t = buildTree(s.items(), 'folder', ['TODO', 'FIXME']);
  assert.equal(t[0].label, 'src');
  assert.equal(t[0].children[0].label, 'a/b');
  assert.equal(buildTree(s.items(), 'tag', ['TODO', 'FIXME']).map((n) => n.label).join(), 'TODO,FIXME');
  assert.equal(buildTree(s.items(), 'file').length, 2);
  assert.equal(s.setFile('file:///r', 'src/y.js', [{ tag: 'FIXME', line: 3, col: 0, text: 'u', owner: 'bo' }]), false);
  assert.equal(s.setFile('file:///r', 'src/y.js', null), true);
  s.filter = 'nothing';
  assert.equal(s.counts().total, 0);
  s.filter = '';
  s.setRoot('file:///q', 'q', new Map([['z.js', [{ tag: 'NOTE', line: 0, col: 0, text: '', owner: '' }]]]));
  assert.deepEqual(buildTree(s.items(), 'folder').map((n) => n.kind), ['root', 'root']);
});
