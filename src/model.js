'use strict';
// The tag list for every workspace folder, and the tree rows built from it. No vscode import: tests use it directly.
const path = require('path');

class TagStore {
  constructor() { this.roots = new Map(); this.filter = ''; this.version = 0; }
  setRoot(key, name, files) { this.roots.set(key, { name, files }); this.version++; }
  removeRoot(key) { this.roots.delete(key); this.version++; }
  setFile(key, rel, matches) {
    const r = this.roots.get(key);
    if (!r) return false;
    const before = r.files.get(rel);
    if (!matches || !matches.length) { if (!before) return false; r.files.delete(rel); }
    else {
      if (before && sameMatches(before, matches)) return false;
      r.files.set(rel, matches);
    }
    this.version++;
    return true;
  }
  /** Every match as { root, rootName, rel, ...match }, filtered by the text filter. */
  items() {
    const out = [];
    const f = this.filter.toLowerCase();
    for (const [root, r] of this.roots) {
      for (const [rel, list] of r.files) {
        for (const m of list) {
          if (f && !(`${m.tag} ${m.text} ${m.owner} ${rel}`.toLowerCase().includes(f))) continue;
          out.push({ root, rootName: r.name, rel, ...m });
        }
      }
    }
    return out;
  }
  counts() {
    const byTag = {};
    let total = 0;
    for (const it of this.items()) { byTag[it.tag] = (byTag[it.tag] || 0) + 1; total++; }
    return { total, byTag };
  }
}

function sameMatches(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].line !== b[i].line || a[i].tag !== b[i].tag || a[i].text !== b[i].text || a[i].col !== b[i].col) return false;
  return true;
}

const byPath = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line);

/**
 * Tree rows. mode: 'folder' (nested folders), 'file' (one row per file) or 'tag' (one row per tag).
 * Returns nodes { kind: 'root'|'dir'|'file'|'tag'|'item', label, description, count, children, item? }.
 */
function buildTree(items, mode = 'folder', tagOrder = []) {
  const multi = new Set(items.map((i) => i.root)).size > 1;
  const order = (t) => { const i = tagOrder.indexOf(t); return i < 0 ? 999 : i; };
  if (mode === 'tag') {
    const groups = new Map();
    for (const it of items) { if (!groups.has(it.tag)) groups.set(it.tag, []); groups.get(it.tag).push(it); }
    return [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]) || (a[0] < b[0] ? -1 : 1)).map(([tag, list]) => ({
      kind: 'tag', id: `tag:${tag}`, label: tag, tag, count: list.length,
      children: list.sort(byPath).map((it) => itemNode(it, `${multi ? `${it.rootName}/` : ''}${it.rel}:${it.line + 1}`, true)),
    }));
  }
  const roots = new Map();
  for (const it of items) { if (!roots.has(it.root)) roots.set(it.root, { name: it.rootName, list: [] }); roots.get(it.root).list.push(it); }
  const perRoot = [...roots.entries()].map(([root, r]) => {
    const fileMap = new Map();
    for (const it of r.list.sort(byPath)) { if (!fileMap.has(it.rel)) fileMap.set(it.rel, []); fileMap.get(it.rel).push(it); }
    const fileNode = (rel, list, showDir) => ({
      kind: 'file', id: `file:${root}:${rel}`, label: path.posix.basename(rel), description: showDir ? path.posix.dirname(rel).replace(/^\.$/, '') : '',
      rel, root, count: list.length, children: list.map((it) => itemNode(it, `line ${it.line + 1}`, false)),
    });
    let children;
    if (mode === 'file') children = [...fileMap.entries()].map(([rel, list]) => fileNode(rel, list, true));
    else {
      const top = { children: new Map(), files: [] };
      for (const [rel, list] of fileMap) {
        const parts = rel.split('/');
        let d = top;
        for (const p of parts.slice(0, -1)) { if (!d.children.has(p)) d.children.set(p, { children: new Map(), files: [] }); d = d.children.get(p); }
        d.files.push(fileNode(rel, list, false));
      }
      const toNodes = (d, prefix) => {
        const dirs = [...d.children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, sub]) => {
          // compact single-child folder chains: src/core/util
          let label = name, cur = sub, p = prefix ? `${prefix}/${name}` : name;
          while (cur.files.length === 0 && cur.children.size === 1) { const [n2, s2] = [...cur.children.entries()][0]; label += `/${n2}`; p += `/${n2}`; cur = s2; }
          const kids = toNodes(cur, p);
          return { kind: 'dir', id: `dir:${root}:${p}`, label, rel: p, root, count: kids.reduce((s, k) => s + k.count, 0), children: kids };
        });
        return dirs.concat(d.files.sort((a, b) => (a.label < b.label ? -1 : 1)));
      };
      children = toNodes(top, '');
    }
    return { kind: 'root', id: `root:${root}`, label: r.name, root, count: r.list.length, children };
  });
  if (perRoot.length === 1) return perRoot[0].children;
  return perRoot;
}

function itemNode(it, description, showTag) {
  return { kind: 'item', id: `item:${it.root}:${it.rel}:${it.line}:${it.tag}`, label: `${it.tag}${it.owner ? `(${it.owner})` : ''}${it.text ? ` ${it.text}` : ''}`, description, item: it, count: 1, showTag };
}

module.exports = { TagStore, buildTree, sameMatches };
