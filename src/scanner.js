'use strict';
// The built-in TODO scanner: comment-aware tag matching for many languages and a workspace walker that honours
// .gitignore, files.exclude and size caps. Plain Node (fs only): no ripgrep, no child process, no network.
const fs = require('fs');
const path = require('path');
const { parseGitignore, isIgnored, globMatcher } = require('./ignore');

const DEFAULT_TAGS = ['TODO', 'FIXME', 'BUG', 'HACK', 'XXX', 'NOTE'];

// Comment syntax per file extension. line: markers that start a comment to the end of the line; block: [open, close];
// quotes: string delimiters skipped while looking for a comment (so "http://x" or '# no' inside a string is not one).
const C = { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'", '`'] };
const HASH = { line: ['#'], block: [], quotes: ['"', "'"] };
const SYNTAX = {};
const put = (exts, syn) => { for (const e of exts.split(' ')) SYNTAX[e] = syn; };
put('js mjs cjs jsx ts mts cts tsx java c h cc cpp cxx hpp hh hxx m mm cs go rs swift kt kts scala sc dart groovy gradle jsonc json5 proto zig v sol hx', C);
put('php', { line: ['//', '#'], block: [['/*', '*/']], quotes: ['"', "'", '`'] });
put('css', { line: [], block: [['/*', '*/']], quotes: ['"', "'"] });
put('scss less styl', { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'"] });
put('py pyi pyw', { line: ['#'], block: [['"""', '"""'], ["'''", "'''"]], quotes: ['"', "'"] });
put('rb rake gemspec sh bash zsh fish ksh yaml yml toml ini cfg conf properties pl pm r tf tfvars hcl cmake mk nim jl coffee cr ex exs gd dockerfile containerfile gitignore editorconfig env', HASH);
put('ps1 psm1', { line: ['#'], block: [['<#', '#>']], quotes: ['"', "'"] });
put('sql', { line: ['--', '#'], block: [['/*', '*/']], quotes: ["'", '"'] });
put('lua', { line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"] });
put('hs lhs elm purs', { line: ['--'], block: [['{-', '-}']], quotes: ['"'] });
put('ada adb ads vhd vhdl', { line: ['--'], block: [], quotes: ['"'] });
put('html htm xml xhtml svg xsl xslt plist csproj vbproj props targets', { line: [], block: [['<!--', '-->']], quotes: [] });
put('vue svelte astro', { line: ['//'], block: [['<!--', '-->'], ['/*', '*/']], quotes: ['"', "'", '`'] });
put('lisp lsp el clj cljs cljc edn scm rkt asm s inc', { line: [';'], block: [], quotes: ['"'] });
put('tex sty cls erl hrl matlab', { line: ['%'], block: [], quotes: [] });
put('ml mli fs fsi fsx', { line: ['//'], block: [['(*', '*)']], quotes: ['"'] });
put('vb vbs bas', { line: ["'", 'REM '], block: [], quotes: ['"'] });
put('bat cmd', { line: ['REM ', 'rem ', '::'], block: [], quotes: [] });
put('jinja j2 njk twig liquid', { line: [], block: [['{#', '#}'], ['<!--', '-->']], quotes: [] });
put('hbs handlebars mustache', { line: [], block: [['{{!--', '--}}'], ['<!--', '-->']], quotes: [] });
const FALLBACK = { line: ['//', '#', '--', ';'], block: [['/*', '*/'], ['<!--', '-->']], quotes: ['"'] };
// Notes and plain text: a tag counts at the start of a line or a list item ("TODO: x", "- FIXME y").
const PLAIN = new Set(['md', 'markdown', 'mdx', 'txt', 'text', 'org', 'rst', 'adoc', 'todo', '']);
const NAMED = { makefile: HASH, dockerfile: HASH, containerfile: HASH, gemfile: HASH, rakefile: HASH, vagrantfile: HASH, 'cmakelists.txt': HASH, justfile: HASH, procfile: HASH };

function syntaxFor(fileName) {
  const base = path.basename(String(fileName || '')).toLowerCase();
  if (NAMED[base]) return NAMED[base];
  if (base.startsWith('.env')) return HASH;
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (PLAIN.has(ext) || (!ext && !NAMED[base])) return 'plain';
  return SYNTAX[ext] || FALLBACK;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One regex that finds any tag as a word, with an optional "(owner)" and ":" after it. */
function tagRegex(tags = DEFAULT_TAGS, caseSensitive = true) {
  const list = (Array.isArray(tags) ? tags : []).map((t) => String(t).trim()).filter(Boolean);
  if (!list.length) return null;
  list.sort((a, b) => b.length - a.length);
  const alt = list.map((t) => (/^\w/.test(t) ? '\\b' : '') + escRe(t) + (/\w$/.test(t) ? '\\b' : '')).join('|');
  return new RegExp(`(${alt})(?:\\(([^)\\n]{1,60})\\))?(:?)`, caseSensitive ? 'g' : 'gi');
}

/** Comment ranges [start, end) on one line, given the block state carried from the line before. */
function commentRanges(line, syn, state) {
  const out = [];
  let i = 0;
  const n = line.length;
  if (state.close) {
    const j = line.indexOf(state.close);
    if (j < 0) { out.push([0, n]); return out; }
    out.push([0, j]); i = j + state.close.length; state.close = null;
  }
  while (i < n) {
    let hit = null;
    for (const b of syn.block) if (line.startsWith(b[0], i)) { hit = { block: b }; break; }
    if (!hit) for (const m of syn.line) if (line.startsWith(m, i) && (m !== 'REM ' || i === line.search(/\S/))) { hit = { line: m }; break; }
    if (hit && hit.line) { out.push([i, n]); break; }
    if (hit && hit.block) {
      const start = i;
      const k = line.indexOf(hit.block[1], i + hit.block[0].length);
      if (k < 0) { out.push([start, n]); state.close = hit.block[1]; break; }
      out.push([start, k]); i = k + hit.block[1].length; continue;
    }
    const ch = line[i];
    if (syn.quotes.includes(ch)) {
      let k = i + 1;
      while (k < n && line[k] !== ch) k += line[k] === '\\' ? 2 : 1;
      i = k + 1; continue;
    }
    i++;
  }
  return out;
}

/**
 * Finds tags in a text. Returns [{ tag, line, col, end, owner, text }]: 0-based line, the tag's columns, the owner
 * from "TODO(name)" or "@name", and the rest of the comment as text.
 * opts: { tags, caseSensitive, commentsOnly (default true), maxLineLength }
 */
function scanText(text, fileName, opts = {}) {
  const re = tagRegex(opts.tags || DEFAULT_TAGS, opts.caseSensitive !== false);
  if (!re) return [];
  const syn = opts.commentsOnly === false ? null : syntaxFor(fileName);
  const maxLen = opts.maxLineLength || 2000;
  const lines = String(text).split(/\r\n|\r|\n/);
  const state = { close: null };
  const res = [];
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    let ranges;
    if (!syn) ranges = [[0, line.length]];
    else if (syn === 'plain') {
      const m = /^(\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+)?)/.exec(line);
      ranges = [[m[1].length, m[1].length + 1]]; // tag must start right there
    } else ranges = commentRanges(line.length > maxLen ? line.slice(0, maxLen) : line, syn, state);
    if (!ranges.length) continue;
    re.lastIndex = 0;
    if (!re.test(line)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const col = m.index;
      const inside = ranges.find((r) => col >= r[0] && col < r[1]);
      if (!inside) continue;
      if (syn === 'plain' && col !== inside[0]) continue;
      // a tag inside a longer identifier like TODO_LIST or todo.js is not a tag
      if (/[\w\-/]/.test(line[col + m[1].length] || '')) continue;
      if (col > 0 && /[\w$\-./\\]/.test(line[col - 1])) continue;
      const after = col + m[0].length;
      const endOfComment = syn === 'plain' ? line.length : inside[1];
      let rest = line.slice(after, endOfComment).replace(/\s*(\*\/|-->|#>|-\}|\*\)|--\}\}|#\}|\]\]|"""|''')\s*$/, '').trim();
      let owner = m[2] ? m[2].trim() : '';
      const at = /^@([\w.-]+)\s*:?\s*/.exec(rest);
      if (!owner && at) { owner = at[1]; rest = rest.slice(at[0].length); }
      rest = rest.replace(/^[:\-–]\s*/, '');
      res.push({ tag: opts.caseSensitive === false ? canonical(m[1], opts.tags || DEFAULT_TAGS) : m[1], line: ln, col, end: col + m[1].length, owner, text: rest.slice(0, 300) });
      break; // one tag per line: the first one in a comment
    }
  }
  return res;
}

function canonical(found, tags) {
  const u = found.toUpperCase();
  return (tags.find((t) => String(t).toUpperCase() === u) || found);
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const ALWAYS_SKIP = new Set(['.git', '.hg', '.svn', 'node_modules', '.DS_Store']);
const BINARY_EXT = new Set('png jpg jpeg gif webp ico bmp tif tiff pdf zip gz tgz bz2 xz 7z rar jar war class so dylib dll exe o a lib bin dat woff woff2 ttf otf eot mp3 mp4 mov avi mkv wav flac ogg webm psd ai sketch fig pyc pyo wasm map lock sqlite db parquet avro npy npz pkl h5 onnx gguf safetensors vsix'.split(' '));

/**
 * Walks a folder and scans every text file. opts: { tags, caseSensitive, commentsOnly, gitignore (true), exclude
 * (globs or files.exclude object), maxFiles, maxFileBytes, shouldStop(), onFile(rel, matches) }.
 * Returns { files: Map(rel -> matches), scanned, skippedLarge, truncated, ms }.
 */
async function scanFolder(root, opts = {}) {
  const t0 = Date.now();
  const files = new Map();
  const maxFiles = opts.maxFiles || 20000;
  const maxBytes = opts.maxFileBytes || 512 * 1024;
  const excluded = globMatcher(opts.exclude || []);
  const useGitignore = opts.gitignore !== false;
  let rules = [];
  if (useGitignore) {
    for (const f of ['.git/info/exclude']) {
      try { rules = rules.concat(parseGitignore(await fs.promises.readFile(path.join(root, f), 'utf8'), '')); } catch { /* none */ }
    }
  }
  let scanned = 0, skippedLarge = 0, truncated = false;
  const queue = [''];
  const pending = [];
  const scanOptions = { tags: opts.tags, caseSensitive: opts.caseSensitive, commentsOnly: opts.commentsOnly };
  async function readOne(rel) {
    const abs = path.join(root, rel);
    let fh;
    try {
      fh = await fs.promises.open(abs, 'r');
      const st = await fh.stat();
      if (st.size > maxBytes) { skippedLarge++; return; }
      const buf = Buffer.alloc(st.size);
      await fh.read(buf, 0, st.size, 0);
      if (looksBinary(buf)) return;
      const found = scanText(buf.toString('utf8'), rel, scanOptions);
      if (found.length) { files.set(rel, found); if (opts.onFile) opts.onFile(rel, found); }
    } catch { /* unreadable: skip */ } finally { if (fh) await fh.close().catch(() => {}); }
  }
  while (queue.length) {
    if (opts.shouldStop && opts.shouldStop()) break;
    const dir = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    if (useGitignore && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
      try { rules = rules.concat(parseGitignore(await fs.promises.readFile(path.join(root, dir, '.gitignore'), 'utf8'), dir)); } catch { /* skip */ }
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (ALWAYS_SKIP.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (!isDir && !e.isFile()) continue; // symlinks and sockets are not followed
      if (excluded(rel)) continue;
      if (useGitignore && isIgnored(rules, rel, isDir)) continue;
      if (isDir) { queue.push(rel); continue; }
      const ext = e.name.includes('.') ? e.name.slice(e.name.lastIndexOf('.') + 1).toLowerCase() : '';
      if (BINARY_EXT.has(ext) || /\.min\.(js|css)$/i.test(e.name)) continue;
      if (scanned >= maxFiles) { truncated = true; break; }
      scanned++;
      pending.push(readOne(rel));
      if (pending.length >= 24) { await Promise.all(pending.splice(0)); }
    }
    if (truncated) break;
  }
  await Promise.all(pending);
  return { files, scanned, skippedLarge, truncated, ms: Date.now() - t0 };
}

/** Rebuilds a .gitignore check for one path (used for single-file rescans on save). */
async function ignoredByGitignore(root, rel) {
  const parts = rel.split('/');
  let rules = [];
  try { rules = rules.concat(parseGitignore(await fs.promises.readFile(path.join(root, '.git/info/exclude'), 'utf8'), '')); } catch { /* none */ }
  for (let i = 0; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    try { rules = rules.concat(parseGitignore(await fs.promises.readFile(path.join(root, dir, '.gitignore'), 'utf8'), dir)); } catch { /* none */ }
    if (i < parts.length - 1 && (ALWAYS_SKIP.has(parts[i]) || isIgnored(rules, parts.slice(0, i + 1).join('/'), true))) return true;
  }
  return isIgnored(rules, rel, false);
}

module.exports = { DEFAULT_TAGS, scanText, scanFolder, tagRegex, syntaxFor, commentRanges, looksBinary, ignoredByGitignore, BINARY_EXT, ALWAYS_SKIP };
