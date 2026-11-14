'use strict';
// Local git only (child_process execFile, no shell, no network): blame for the age and author of each TODO, and the
// TODOs a branch added or removed against its base. Every call has a time limit and an output cap.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { scanText, looksBinary } = require('./scanner');

function git(cwd, args, { timeout = 20000, maxBuffer = 64 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout));
    });
  });
}

async function repoRoot(cwd) {
  try { return (await git(cwd, ['rev-parse', '--show-toplevel'], { timeout: 5000 })).trim() || null; } catch { return null; }
}

/** Parses `git blame --line-porcelain` into an array indexed by final line number (1-based). */
function parseBlame(out) {
  const lines = [];
  const commits = new Map();
  let cur = null;
  for (const l of out.split('\n')) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
    if (h) { cur = { sha: h[1], line: Number(h[2]) }; continue; }
    if (!cur) continue;
    if (l.startsWith('author ')) cur.author = l.slice(7);
    else if (l.startsWith('author-mail ')) cur.mail = l.slice(12).replace(/[<>]/g, '');
    else if (l.startsWith('author-time ')) cur.time = Number(l.slice(12)) * 1000;
    else if (l.startsWith('\t')) {
      const c = commits.get(cur.sha) || { author: cur.author, mail: cur.mail, time: cur.time };
      if (cur.author) { c.author = cur.author; c.mail = cur.mail; c.time = cur.time; }
      commits.set(cur.sha, c);
      const uncommitted = /^0{40}$/.test(cur.sha);
      lines[cur.line] = { sha: cur.sha, author: uncommitted ? '' : c.author, mail: uncommitted ? '' : c.mail, time: uncommitted ? null : c.time, uncommitted };
      cur = null;
    }
  }
  return lines;
}

async function blameFile(root, rel) {
  try { return parseBlame(await git(root, ['blame', '--line-porcelain', '-w', '--', rel], { timeout: 30000 })); } catch { return null; }
}

/** Adds { author, time, sha, uncommitted } to every item, blaming each file once. items: [{ rel, line (0-based) }]. */
async function blameItems(root, items, { maxFiles = 400, onProgress } = {}) {
  const byFile = new Map();
  for (const it of items) { if (!byFile.has(it.rel)) byFile.set(it.rel, []); byFile.get(it.rel).push(it); }
  let n = 0;
  for (const [rel, list] of byFile) {
    if (n++ >= maxFiles) break;
    if (onProgress) onProgress(n, byFile.size);
    const b = await blameFile(root, rel);
    if (!b) continue;
    for (const it of list) {
      const x = b[it.line + 1];
      if (x) Object.assign(it, { author: x.author, mail: x.mail, time: x.time, sha: x.sha, uncommitted: x.uncommitted });
    }
  }
  return items;
}

/** The base to compare against: the setting when given, otherwise origin/main, main, origin/master, master. */
async function findBase(root, wanted) {
  const cands = wanted ? [wanted] : ['origin/main', 'main', 'origin/master', 'master', 'origin/develop', 'develop'];
  for (const c of cands) {
    try { await git(root, ['rev-parse', '--verify', '--quiet', `${c}^{commit}`], { timeout: 5000 }); return c; } catch { /* next */ }
  }
  return null;
}

/** Parses `git diff -U0` into added and removed lines per file: [{ file, oldFile, added: [{line, text}], removed: [...] }]. */
function parseDiff(out) {
  const files = [];
  let f = null, oldLn = 0, newLn = 0;
  for (const l of out.split('\n')) {
    if (l.startsWith('diff --git ')) { f = { file: null, oldFile: null, added: [], removed: [] }; files.push(f); continue; }
    if (!f) continue;
    if (l.startsWith('--- ')) { f.oldFile = l === '--- /dev/null' ? null : l.replace(/^--- (a\/)?/, ''); continue; }
    if (l.startsWith('+++ ')) { f.file = l === '+++ /dev/null' ? null : l.replace(/^\+\+\+ (b\/)?/, ''); continue; }
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { oldLn = Number(h[1]); newLn = Number(h[2]); continue; }
    if (l.startsWith('+')) { f.added.push({ line: newLn - 1, text: l.slice(1) }); newLn++; }
    else if (l.startsWith('-')) { f.removed.push({ line: oldLn - 1, text: l.slice(1) }); oldLn++; }
  }
  return files;
}

/**
 * TODOs added and removed between the merge base of HEAD and base, and the working tree (uncommitted edits count).
 * A TODO whose text moved unchanged inside the same file is neither added nor removed.
 */
function deltaFromDiff(diffFiles, scanOpts = {}) {
  const added = [], removed = [];
  for (const f of diffFiles) {
    const key = (x) => `${x.tag}\u0000${x.text}`;
    const one = (rows, name) => rows.flatMap((r) => scanText(r.text, name || '', { ...scanOpts }).map((m) => ({ ...m, line: r.line, raw: r.text.trim() })));
    const a = f.file ? one(f.added, f.file) : [];
    const r = f.oldFile ? one(f.removed, f.oldFile) : [];
    const rk = new Map();
    for (const x of r) rk.set(key(x), (rk.get(key(x)) || 0) + 1);
    const moved = new Map();
    for (const x of a) {
      const k = key(x);
      if (rk.get(k) > 0) { rk.set(k, rk.get(k) - 1); moved.set(k, (moved.get(k) || 0) + 1); continue; }
      added.push({ ...x, rel: f.file });
    }
    for (const x of r) {
      const k = key(x);
      if (moved.get(k) > 0) { moved.set(k, moved.get(k) - 1); continue; }
      removed.push({ ...x, rel: f.oldFile });
    }
  }
  return { added, removed };
}

async function branchDelta(root, base, scanOpts) {
  const mb = (await git(root, ['merge-base', 'HEAD', base], { timeout: 10000 })).trim();
  const head = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 5000 })).trim();
  const out = await git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', mb, '--'], { timeout: 60000, maxBuffer: 256 << 20 });
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 20000 }).catch(() => '')).split('\0').filter(Boolean);
  const d = deltaFromDiff(parseDiff(out), scanOpts);
  // New files that git does not track yet: every tag in them is new.
  let newFiles = 0;
  for (const rel of untracked.slice(0, 2000)) {
    if (scanOpts && scanOpts.isExcluded && scanOpts.isExcluded(rel)) continue;
    try {
      const buf = await fs.promises.readFile(path.join(root, rel));
      if (buf.length > 512 * 1024 || looksBinary(buf)) continue;
      const found = scanText(buf.toString('utf8'), rel, scanOpts);
      if (found.length) newFiles++;
      for (const m of found) d.added.push({ ...m, rel, untracked: true });
    } catch { /* unreadable */ }
  }
  return { mergeBase: mb, head, base, untrackedCount: untracked.length, untrackedWithTags: newFiles, ...d };
}

module.exports = { git, repoRoot, parseBlame, blameFile, blameItems, findBase, parseDiff, deltaFromDiff, branchDelta };
