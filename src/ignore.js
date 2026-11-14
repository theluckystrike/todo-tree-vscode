'use strict';
// .gitignore and glob matching for the built-in scanner. No vscode import, so tests can run it in plain Node.
// Supports the gitignore rules people use: comments, blank lines, "!" negation, trailing "/" (folders only),
// leading or middle "/" (anchored to the .gitignore folder), "*", "?", "[abc]" and "**".

function globToRegExpSource(glob) {
  let s = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const before = i === 0 || glob[i - 1] === '/';
        const after = glob[i + 2] === '/' || i + 2 === glob.length;
        if (before && after) {
          // "**/" matches zero or more folders, a trailing "**" everything below
          if (glob[i + 2] === '/') { s += '(?:.*/)?'; i += 2; } else { s += '.*'; i += 1; }
          continue;
        }
        s += '[^/]*'; i += 1; continue;
      }
      s += '[^/]*';
    } else if (c === '?') s += '[^/]';
    else if (c === '[') {
      const j = glob.indexOf(']', i + 1);
      if (j < 0) { s += '\\['; continue; }
      let body = glob.slice(i + 1, j).replace(/\\/g, '\\\\');
      if (body[0] === '!') body = '^' + body.slice(1);
      s += `[${body}]`; i = j;
    } else if (c === '\\' && i + 1 < glob.length) { s += glob[i + 1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'); i++; }
    else s += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return s;
}

/** One .gitignore file. base: the folder of the file relative to the scan root, '' for the root ('a/b' style). */
function parseGitignore(text, base = '') {
  const rules = [];
  for (let raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const src = globToRegExpSource(line);
    const re = new RegExp(anchored ? `^${src}$` : `(?:^|/)${src}$`);
    rules.push({ re, negate, dirOnly, base });
  }
  return rules;
}

/** rel: path relative to the scan root with "/" separators. Last matching rule wins, as in git. */
function isIgnored(rules, rel, isDir) {
  let ignored = false;
  for (const r of rules) {
    let p = rel;
    if (r.base) {
      if (!(rel === r.base || rel.startsWith(r.base + '/'))) continue;
      p = rel.slice(r.base.length + 1);
      if (!p) continue;
    }
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(p)) ignored = !r.negate;
  }
  return ignored;
}

/** files.exclude style globs ({ "**\/.git": true }) or a list of globs, to one tester on a relative path. */
function globMatcher(globs) {
  const list = Array.isArray(globs) ? globs : Object.entries(globs || {}).filter(([, v]) => v === true).map(([k]) => k);
  const res = [];
  for (const g0 of list) {
    if (typeof g0 !== 'string' || !g0.trim()) continue;
    const alts = expandBraces(g0.trim());
    for (let g of alts) {
      if (g.startsWith('./')) g = g.slice(2);
      if (g.startsWith('/')) g = g.slice(1);
      const src = globToRegExpSource(g);
      res.push(new RegExp(g.includes('/') ? `^${src}(?:/.*)?$` : `(?:^|/)${src}(?:/.*)?$`));
    }
  }
  return (rel) => res.some((re) => re.test(rel));
}

function expandBraces(g) {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m) return [g];
  return m[1].split(',').flatMap((alt) => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
}

module.exports = { parseGitignore, isIgnored, globMatcher, globToRegExpSource, expandBraces };
