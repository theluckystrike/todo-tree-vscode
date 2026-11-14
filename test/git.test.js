'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const g = require('../src/git');

const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-todo-git-'));
  const run = (...a) => execFileSync('git', a, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'Anna', GIT_AUTHOR_EMAIL: 'anna@example.com', GIT_COMMITTER_NAME: 'Anna', GIT_COMMITTER_EMAIL: 'anna@example.com', GIT_AUTHOR_DATE: '2025-01-02T10:00:00Z', GIT_COMMITTER_DATE: '2025-01-02T10:00:00Z' } });
  run('init', '-q', '-b', 'main');
  run('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'a.js'), 'x();\n// TODO: old task\n// FIXME gone soon\n// NOTE moved\ny();\n');
  run('add', '.'); run('commit', '-q', '-m', 'one');
  run('checkout', '-q', '-b', 'feature');
  return { root, run };
}

test('blame gives author and time; uncommitted lines are marked', { skip: !hasGit }, async () => {
  const { root } = repo();
  try {
    fs.appendFileSync(path.join(root, 'a.js'), '// TODO not yet committed\n');
    const items = [{ rel: 'a.js', line: 1 }, { rel: 'a.js', line: 5 }];
    await g.blameItems(root, items);
    assert.equal(items[0].author, 'Anna');
    assert.equal(new Date(items[0].time).toISOString().slice(0, 10), '2025-01-02');
    assert.equal(items[1].uncommitted, true);
    assert.equal(items[1].author, '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('branch delta: added, removed, moved, untracked', { skip: !hasGit }, async () => {
  const { root, run } = repo();
  try {
    fs.writeFileSync(path.join(root, 'a.js'), '// NOTE moved\nx();\n// TODO: old task\ny();\n// BUG: new bug\n');
    run('commit', '-q', '-am', 'two');
    fs.appendFileSync(path.join(root, 'a.js'), '// HACK uncommitted\n');
    fs.writeFileSync(path.join(root, 'new.py'), '# TODO new file\n');
    assert.equal(await g.repoRoot(root) !== null, true);
    assert.equal(await g.findBase(root, ''), 'main');
    assert.equal(await g.findBase(root, 'nope-branch'), null);
    const d = await g.branchDelta(root, 'main', {});
    assert.deepEqual(d.added.map((x) => `${x.tag} ${x.rel}:${x.line + 1}`).sort(), ['BUG a.js:5', 'HACK a.js:6', 'TODO new.py:1']);
    assert.deepEqual(d.removed.map((x) => `${x.tag} ${x.text}`), ['FIXME gone soon']);
    assert.equal(d.head, 'feature');
    assert.equal(d.untrackedWithTags, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('parseDiff handles new and deleted files', () => {
  const out = 'diff --git a/x.js b/x.js\nnew file mode 100644\n--- /dev/null\n+++ b/x.js\n@@ -0,0 +1,2 @@\n+// TODO a\n+b\ndiff --git a/y.js b/y.js\n--- a/y.js\n+++ /dev/null\n@@ -3 +0,0 @@\n-// FIXME c\n';
  const f = g.parseDiff(out);
  assert.equal(f[0].file, 'x.js'); assert.equal(f[0].oldFile, null); assert.equal(f[0].added[0].line, 0);
  assert.equal(f[1].file, null); assert.equal(f[1].removed[0].line, 2);
  const d = g.deltaFromDiff(f);
  assert.equal(d.added.length, 1); assert.equal(d.removed[0].rel, 'y.js');
});
