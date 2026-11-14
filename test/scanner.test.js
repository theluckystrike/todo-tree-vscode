'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanText, scanFolder, syntaxFor, ignoredByGitignore } = require('../src/scanner');
const { parseGitignore, isIgnored, globMatcher } = require('../src/ignore');

const rows = (r) => r.map((m) => `${m.line}|${m.tag}|${m.owner}|${m.text}`);

test('JS: line and block comments, owners, strings and identifiers', () => {
  const t = [
    "const a = 'TODO not a comment'; // TODO: fix the loop",
    '/* FIXME(anna): leak',
    ' * HACK this too',
    '   NOTE inside the block */',
    'let todo = TODO_LIST; // see http://x.com/TODO',
    '// XXX @bob: owner by at',
    'const url = "http://example.com"; // BUG off by one',
  ].join('\n');
  assert.deepEqual(rows(scanText(t, 'a.ts')), ['0|TODO||fix the loop', '1|FIXME|anna|leak', '2|HACK||this too', '3|NOTE||inside the block', '5|XXX|bob|owner by at', '6|BUG||off by one']);
});

test('Python: hash comments and docstrings, not strings', () => {
  const t = '# TODO: py\nx = "# FIXME no"\n"""\nBUG in docstring\n"""\ny = 1  # NOTE trailing\n';
  assert.deepEqual(rows(scanText(t, 'm.py')), ['0|TODO||py', '3|BUG||in docstring', '5|NOTE||trailing']);
});

test('many languages', () => {
  assert.equal(scanText('-- TODO sql', 'q.sql')[0].tag, 'TODO');
  assert.equal(scanText('<!-- FIXME: alt text -->', 'i.html')[0].text, 'alt text');
  assert.equal(scanText('; HACK lisp', 'x.el')[0].tag, 'HACK');
  assert.equal(scanText('% TODO tex', 'p.tex')[0].tag, 'TODO');
  assert.equal(scanText("' TODO vb", 'm.vb')[0].tag, 'TODO');
  assert.equal(scanText('REM TODO batch', 'r.bat')[0].tag, 'TODO');
  assert.equal(scanText('# TODO make', 'Makefile')[0].tag, 'TODO');
  assert.equal(scanText('{- TODO haskell -}', 'a.hs')[0].text, 'haskell');
  assert.equal(scanText('--[[ TODO lua block ]]', 'a.lua')[0].text, 'lua block');
  assert.equal(scanText('# TODO env', '.env.local')[0].tag, 'TODO');
  assert.equal(scanText('// TODO unknown ext', 'x.weird')[0].tag, 'TODO');
  assert.equal(scanText('div { color: red; } /* TODO css */', 's.css')[0].text, 'css');
  assert.equal(scanText('# not a comment in js? TODO', 'a.js').length, 0);
});

test('Markdown and text: line start or list item only', () => {
  const t = '- TODO: buy milk\nThis has a TODO in prose\nFIXME: top\n- [ ] TODO checkbox\n## TODO heading';
  assert.deepEqual(rows(scanText(t, 'notes.md')), ['0|TODO||buy milk', '2|FIXME||top', '3|TODO||checkbox', '4|TODO||heading']);
  assert.equal(scanText('TODO plain', 'TODO.txt').length, 1);
});

test('custom tags, case and commentsOnly', () => {
  assert.equal(scanText('// REVIEW: later', 'a.js', { tags: ['REVIEW'] })[0].tag, 'REVIEW');
  assert.equal(scanText('// todo lower', 'a.js').length, 0);
  assert.equal(scanText('// todo lower', 'a.js', { caseSensitive: false })[0].tag, 'TODO');
  assert.equal(scanText('x = 1 TODO anywhere', 'a.js', { commentsOnly: false })[0].tag, 'TODO');
  assert.equal(scanText('// [ ] box', 'a.js', { tags: ['[ ]'] })[0].tag, '[ ]');
  assert.deepEqual(scanText('// TODO', 'a.js', { tags: [] }), []);
});

test('CRLF and long lines', () => {
  assert.deepEqual(rows(scanText('a\r\n// TODO crlf\r\n', 'a.c')), ['1|TODO||crlf']);
  const long = 'x'.repeat(5000) + ' // TODO far';
  assert.equal(scanText(long, 'a.c').length, 0);
});

test('syntaxFor', () => {
  assert.equal(syntaxFor('README.md'), 'plain');
  assert.ok(syntaxFor('a.py').block.length === 2);
  assert.ok(syntaxFor('Dockerfile').line.includes('#'));
});

test('gitignore rules', () => {
  const r = parseGitignore('# c\nnode_modules/\n*.log\n!keep.log\n/build\ndocs/**/gen\nfoo?.txt\n[ab].js\n', '');
  assert.equal(isIgnored(r, 'node_modules', true), true);
  assert.equal(isIgnored(r, 'node_modules', false), false);
  assert.equal(isIgnored(r, 'src/x.log', false), true);
  assert.equal(isIgnored(r, 'keep.log', false), false);
  assert.equal(isIgnored(r, 'build', true), true);
  assert.equal(isIgnored(r, 'src/build', true), false);
  assert.equal(isIgnored(r, 'docs/a/b/gen', true), true);
  assert.equal(isIgnored(r, 'docs/gen', true), true);
  assert.equal(isIgnored(r, 'foo1.txt', false), true);
  assert.equal(isIgnored(r, 'a.js', false), true);
  assert.equal(isIgnored(r, 'c.js', false), false);
  const sub = parseGitignore('tmp\n', 'pkg');
  assert.equal(isIgnored(sub, 'pkg/tmp', true), true);
  assert.equal(isIgnored(sub, 'tmp', true), false);
});

test('files.exclude globs', () => {
  const m = globMatcher({ '**/.git': true, '**/*.{png,jpg}': true, 'off/**': false, '**/dist/**': true });
  assert.equal(m('.git'), true);
  assert.equal(m('a/b.png'), true);
  assert.equal(m('a/b.jpg'), true);
  assert.equal(m('off/x.js'), false);
  assert.equal(m('pkg/dist/a.js'), true);
  assert.equal(m('src/a.js'), false);
});

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zovo-todo-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}

test('scanFolder: gitignore, excludes, binary, size cap, node_modules', async () => {
  const root = tmpTree({
    '.gitignore': 'ignored/\n*.gen.js\n',
    'src/a.js': '// TODO one\n// FIXME two\n',
    'src/b.gen.js': '// TODO generated',
    'ignored/c.js': '// TODO hidden',
    'node_modules/x/index.js': '// TODO dep',
    'dist/out.js': '// TODO built',
    'big.js': '// TODO big\n' + 'x'.repeat(4000),
    'bin.dat2': Buffer.from([0x2f, 0x2f, 0x20, 0x54, 0x4f, 0x44, 0x4f, 0x00, 1, 2]),
    'pkg/.gitignore': 'local.js\n',
    'pkg/local.js': '// TODO local ignore',
    'pkg/kept.py': '# NOTE kept',
    'notes.md': '- TODO: write docs\n',
  });
  try {
    const r = await scanFolder(root, { exclude: ['**/dist/**'], maxFileBytes: 2000 });
    assert.deepEqual([...r.files.keys()].sort(), ['notes.md', 'pkg/kept.py', 'src/a.js']);
    assert.equal(r.files.get('src/a.js').length, 2);
    assert.equal(r.skippedLarge, 1);
    const all = await scanFolder(root, { gitignore: false, maxFileBytes: 1e6 });
    assert.ok(all.files.has('ignored/c.js') && all.files.has('big.js') && all.files.has('dist/out.js'));
    assert.ok(!all.files.has('node_modules/x/index.js'));
    const capped = await scanFolder(root, { maxFiles: 2 });
    assert.equal(capped.truncated, true);
    assert.equal(await ignoredByGitignore(root, 'ignored/c.js'), true);
    assert.equal(await ignoredByGitignore(root, 'pkg/local.js'), true);
    assert.equal(await ignoredByGitignore(root, 'src/a.js'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
