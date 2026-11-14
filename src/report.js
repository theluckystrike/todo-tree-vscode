'use strict';
// Report formats for the Pro tools: Markdown, CSV, HTML and JSON. Pure functions (no vscode), tested in Node.
const DAY = 86400000;

const ageDays = (t, now = Date.now()) => (t ? Math.max(0, Math.floor((now - t) / DAY)) : null);
const isoDay = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
const who = (it) => it.owner || it.author || (it.uncommitted ? 'not committed' : '');
const mdCell = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const csvCell = (s) => { const v = String(s == null ? '' : s); return /[",\r\n]/.test(v) || /^[=+\-@\t]/.test(v) ? `"${(/^[=+\-@\t]/.test(v) ? "'" : '') + v.replace(/"/g, '""')}"` : v; };
const htmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** items: [{ rel, line (0-based), tag, owner, text, author?, time?, uncommitted? }] */
function summary(items) {
  const byTag = {};
  for (const it of items) byTag[it.tag] = (byTag[it.tag] || 0) + 1;
  return { total: items.length, files: new Set(items.map((i) => i.rel)).size, byTag };
}

function sortItems(items) {
  return [...items].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
}

function markdown(items, { title = 'TODO report', now = Date.now(), blame = false, project = '' } = {}) {
  const s = summary(items);
  const out = [`# ${title}${project ? `: ${project}` : ''}`, '', `${s.total} tags in ${s.files} files, ${isoDay(now)}. ` + Object.entries(s.byTag).map(([t, n]) => `${t} ${n}`).join(', ') + '.', ''];
  const head = blame ? '| File | Line | Tag | Text | Who | Added | Age (days) |' : '| File | Line | Tag | Text | Owner |';
  out.push(head, head.replace(/[^|]+/g, (m) => '-'.repeat(Math.max(3, m.trim().length))));
  for (const it of sortItems(items)) {
    const base = `| ${mdCell(it.rel)} | ${it.line + 1} | ${mdCell(it.tag)} | ${mdCell(it.text)} |`;
    out.push(blame ? `${base} ${mdCell(who(it))} | ${isoDay(it.time)} | ${it.time ? ageDays(it.time, now) : ''} |` : `${base} ${mdCell(it.owner)} |`);
  }
  return out.join('\n') + '\n';
}

function csv(items, { blame = false, now = Date.now() } = {}) {
  const head = ['file', 'line', 'tag', 'text', 'owner'].concat(blame ? ['author', 'added', 'age_days', 'commit'] : []);
  const rows = [head.join(',')];
  for (const it of sortItems(items)) {
    const r = [it.rel, it.line + 1, it.tag, it.text, it.owner].concat(blame ? [it.uncommitted ? 'not committed' : it.author, isoDay(it.time), it.time ? ageDays(it.time, now) : '', it.sha && !it.uncommitted ? it.sha.slice(0, 12) : ''] : []);
    rows.push(r.map(csvCell).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

function html(items, { title = 'TODO report', now = Date.now(), blame = false, project = '' } = {}) {
  const s = summary(items);
  const rows = sortItems(items).map((it) => `<tr><td>${htmlEsc(it.rel)}</td><td class="n">${it.line + 1}</td><td><span class="tag t-${htmlEsc(String(it.tag).toLowerCase().replace(/[^a-z0-9]/g, ''))}">${htmlEsc(it.tag)}</span></td><td>${htmlEsc(it.text)}</td><td>${htmlEsc(blame ? who(it) : it.owner)}</td>${blame ? `<td>${isoDay(it.time)}</td><td class="n">${it.time ? ageDays(it.time, now) : ''}</td>` : ''}</tr>`).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEsc(title)}</title>
<style>
body{font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#1f2328}
h1{font-size:20px;margin:0 0 4px}p{color:#57606a;margin:0 0 16px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #d0d7de;padding:5px 8px;text-align:left;vertical-align:top}
th{background:#f6f8fa;position:sticky;top:0}td.n{text-align:right;font-variant-numeric:tabular-nums}
.tag{font:600 11px/1 ui-monospace,Menlo,monospace;padding:2px 5px;border-radius:3px;background:#eaeef2}
.t-todo{background:#fff1b8}.t-fixme,.t-bug{background:#ffd8d3}.t-hack,.t-xxx{background:#eadcff}.t-note{background:#d6ecff}
</style></head><body>
<h1>${htmlEsc(title)}${project ? `: ${htmlEsc(project)}` : ''}</h1>
<p>${s.total} tags in ${s.files} files, ${isoDay(now)}. ${Object.entries(s.byTag).map(([t, n]) => `${htmlEsc(t)} ${n}`).join(', ')}.</p>
<table><thead><tr><th>File</th><th>Line</th><th>Tag</th><th>Text</th><th>${blame ? 'Who' : 'Owner'}</th>${blame ? '<th>Added</th><th>Age (days)</th>' : ''}</tr></thead>
<tbody>
${rows}
</tbody></table>
</body></html>
`;
}

/** Stale TODOs: committed tags older than minDays, oldest first, with totals per person. */
function stale(items, { minDays = 90, now = Date.now() } = {}) {
  const old = items.filter((it) => it.time && ageDays(it.time, now) >= minDays)
    .map((it) => ({ ...it, age: ageDays(it.time, now), who: who(it) }))
    .sort((a, b) => b.age - a.age || (a.rel < b.rel ? -1 : 1));
  const people = {};
  for (const it of old) {
    const p = people[it.who] || (people[it.who] = { who: it.who, count: 0, oldest: 0 });
    p.count++; p.oldest = Math.max(p.oldest, it.age);
  }
  return { minDays, total: items.length, stale: old, people: Object.values(people).sort((a, b) => b.count - a.count || b.oldest - a.oldest) };
}

function staleMarkdown(r, { now = Date.now(), project = '' } = {}) {
  const out = [`# Stale TODOs${project ? `: ${project}` : ''}`, '', `${r.stale.length} of ${r.total} tags are ${r.minDays} days old or older (${isoDay(now)}).`, ''];
  if (r.people.length) {
    out.push('## By person', '', '| Who | Stale tags | Oldest (days) |', '| --- | --- | --- |');
    for (const p of r.people) out.push(`| ${mdCell(p.who || 'unknown')} | ${p.count} | ${p.oldest} |`);
    out.push('');
  }
  out.push('## Oldest first', '', '| Age (days) | Added | Who | Tag | File | Text |', '| --- | --- | --- | --- | --- | --- |');
  for (const it of r.stale) out.push(`| ${it.age} | ${isoDay(it.time)} | ${mdCell(it.who)} | ${mdCell(it.tag)} | ${mdCell(`${it.rel}:${it.line + 1}`)} | ${mdCell(it.text)} |`);
  return out.join('\n') + '\n';
}

function staleJson(r, { now = Date.now(), project = '' } = {}) {
  return JSON.stringify({
    project, generated: new Date(now).toISOString(), minDays: r.minDays, total: r.total, staleCount: r.stale.length,
    people: r.people,
    stale: r.stale.map((it) => ({ file: it.rel, line: it.line + 1, tag: it.tag, text: it.text, owner: it.owner || null, author: it.author || null, added: isoDay(it.time), ageDays: it.age, commit: it.sha ? it.sha.slice(0, 12) : null })),
  }, null, 2) + '\n';
}

function deltaMarkdown(d, { project = '' } = {}) {
  const out = [`# TODO changes on ${d.head} against ${d.base}${project ? ` (${project})` : ''}`, '',
    `Compared with the merge base ${String(d.mergeBase).slice(0, 12)}, including uncommitted edits: ${d.added.length} added, ${d.removed.length} removed (net ${d.added.length - d.removed.length >= 0 ? '+' : ''}${d.added.length - d.removed.length}).`, ''];
  out.push('## Added', '');
  if (!d.added.length) out.push('None.');
  else { out.push('| Tag | File | Text |', '| --- | --- | --- |'); for (const it of d.added) out.push(`| ${mdCell(it.tag)} | ${mdCell(`${it.rel}:${it.line + 1}`)}${it.untracked ? ' (new file)' : ''} | ${mdCell(it.text)} |`); }
  out.push('', '## Removed', '');
  if (!d.removed.length) out.push('None.');
  else { out.push('| Tag | File (base) | Text |', '| --- | --- | --- |'); for (const it of d.removed) out.push(`| ${mdCell(it.tag)} | ${mdCell(`${it.rel}:${it.line + 1}`)} | ${mdCell(it.text)} |`); }
  if (d.untrackedWithTags) out.push('', `${d.untrackedWithTags} of the added files are not tracked by git yet; all their tags count as added.`);
  return out.join('\n') + '\n';
}

module.exports = { markdown, csv, html, stale, staleMarkdown, staleJson, deltaMarkdown, summary, ageDays, isoDay, csvCell, mdCell, htmlEsc };
