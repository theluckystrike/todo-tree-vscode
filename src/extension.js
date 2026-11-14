'use strict';
// TODO Tree & FIXME Highlighter: highlights TODO, FIXME, BUG, HACK, XXX and NOTE in comments of any language and lists
// every tag of the workspace in a tree. The built-in scanner (scanner.js) reads files with Node fs: no ripgrep, no
// network, nothing sent anywhere. Pro tools (pro.js) use local git only and ask only when the user starts one.
const vscode = require('vscode');
const path = require('path');
const { scanText, scanFolder, DEFAULT_TAGS, ignoredByGitignore } = require('./scanner');
const { globMatcher } = require('./ignore');
const { TagStore, buildTree } = require('./model');
const report = require('./report');
const gitTools = require('./git');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const { registerSupport } = require('./support');

const EXT_ID = 'zovo.zovo-todo-tree';
const PREFIX = 'zovoTodo';
const VIEW = 'zovoTodo.tags';
const NAME = 'TODO Tree & FIXME Highlighter';

const DEFAULT_COLORS = {
  TODO: { background: '#f5c518', foreground: '#1e1e1e', icon: 'charts.yellow' },
  FIXME: { background: '#f0883e', foreground: '#1e1e1e', icon: 'charts.orange' },
  BUG: { background: '#e5534b', foreground: '#ffffff', icon: 'charts.red' },
  HACK: { background: '#a371f7', foreground: '#ffffff', icon: 'charts.purple' },
  XXX: { background: '#f0883e', foreground: '#1e1e1e', icon: 'charts.orange' },
  NOTE: { background: '#4493f8', foreground: '#ffffff', icon: 'charts.blue' },
};
const OTHER_COLOR = { background: '#3fb950', foreground: '#1e1e1e', icon: 'charts.green' };

let pro;
let rating = { success() {}, failure() {} };
const store = new TagStore();
let ctxRef;

function cfg() { return vscode.workspace.getConfiguration(PREFIX); }
function setting(key, dflt) { try { const v = cfg().get(key); return v === undefined ? dflt : v; } catch { return dflt; } }
function tags() { const t = setting('tags', DEFAULT_TAGS); return Array.isArray(t) && t.length ? t.map(String).filter(Boolean) : DEFAULT_TAGS; }
function scanOpts() { return { tags: tags(), caseSensitive: setting('caseSensitive', true) !== false, commentsOnly: setting('commentsOnly', true) !== false }; }
function excludeGlobs(folder) {
  const out = [];
  if (setting('useFilesExclude', true) !== false) {
    const fe = vscode.workspace.getConfiguration('files', folder && folder.uri).get('exclude') || {};
    for (const [k, v] of Object.entries(fe)) if (v === true) out.push(k);
  }
  for (const g of setting('exclude', [])) if (typeof g === 'string') out.push(g);
  return out;
}
function colorFor(tag) {
  const user = setting('tagColors', {}) || {};
  const key = Object.keys(user).find((k) => k.toUpperCase() === String(tag).toUpperCase());
  const base = DEFAULT_COLORS[String(tag).toUpperCase()] || OTHER_COLOR;
  return { ...base, ...(key && user[key] && typeof user[key] === 'object' ? user[key] : {}) };
}

// ---------------- highlights ----------------

const decoTypes = new Map();
function decoFor(tag) {
  const mode = setting('highlight', 'text');
  const c = colorFor(tag);
  const key = `${tag}|${mode}|${c.background}|${c.foreground}`;
  if (decoTypes.has(key)) return decoTypes.get(key);
  const opts = { rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed, overviewRulerColor: c.background, overviewRulerLane: vscode.OverviewRulerLane.Right };
  if (mode === 'line') Object.assign(opts, { isWholeLine: true, backgroundColor: hexAlpha(c.background, 0.18), border: `0 0 0 3px solid ${c.background}`, borderWidth: '0 0 0 3px', borderStyle: 'solid', borderColor: c.background });
  else Object.assign(opts, { backgroundColor: mode === 'text' ? hexAlpha(c.background, 0.22) : c.background, color: mode === 'text' ? undefined : c.foreground, fontWeight: mode === 'tag' ? 'bold' : undefined, borderRadius: '2px' });
  const tagOnly = vscode.window.createTextEditorDecorationType(mode === 'text' ? { backgroundColor: c.background, color: c.foreground, fontWeight: 'bold', borderRadius: '2px' } : { });
  const t = { main: vscode.window.createTextEditorDecorationType(opts), tagOnly };
  decoTypes.set(key, t);
  return t;
}
function hexAlpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function clearDecorations() { for (const t of decoTypes.values()) { t.main.dispose(); t.tagOnly.dispose(); } decoTypes.clear(); }

function decorate(editor) {
  if (!editor || !editor.document) return;
  const mode = setting('highlight', 'text');
  const used = new Map();
  if (mode !== 'none' && editor.document.lineCount <= setting('maxHighlightLines', 50000)) {
    const doc = editor.document;
    const found = scanText(doc.getText(), doc.fileName || doc.uri.path, scanOpts());
    for (const m of found) {
      const d = decoFor(m.tag);
      if (!used.has(d)) used.set(d, { main: [], tag: [] });
      const lineText = doc.lineAt(m.line).text;
      const end = mode === 'tag' ? m.end : textEnd(lineText, m);
      used.get(d).main.push(new vscode.Range(m.line, mode === 'line' ? 0 : m.col, m.line, mode === 'line' ? lineText.length : end));
      if (mode === 'text') used.get(d).tag.push(new vscode.Range(m.line, m.col, m.line, m.end));
    }
  }
  for (const t of decoTypes.values()) {
    const u = used.get(t);
    editor.setDecorations(t.main, u ? u.main : []);
    editor.setDecorations(t.tagOnly, u ? u.tag : []);
  }
}
function textEnd(lineText, m) {
  let s = lineText.replace(/\s*(\*\/|-->|#>|-\}|\*\)|--\}\}|#\}|\]\]|"""|''')\s*$/, '');
  s = s.replace(/\s+$/, '');
  return Math.max(m.end, s.length);
}

// ---------------- the tree ----------------

class TreeProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; this.cache = null; }
  refresh() { this.cache = null; this.emitter.fire(); }
  nodes() {
    if (!this.cache) this.cache = buildTree(store.items(), setting('groupBy', 'folder'), tags());
    return this.cache;
  }
  getChildren(node) { return node ? node.children || [] : this.nodes(); }
  getTreeItem(n) {
    const collapsed = vscode.TreeItemCollapsibleState;
    if (n.kind === 'item') {
      const it = n.item;
      const ti = new vscode.TreeItem(n.label.length > 200 ? `${n.label.slice(0, 200)}...` : n.label, collapsed.None);
      ti.id = n.id;
      ti.description = n.description;
      ti.iconPath = new vscode.ThemeIcon(it.tag === 'NOTE' ? 'note' : it.tag === 'BUG' ? 'bug' : (it.tag === 'FIXME' || it.tag === 'XXX' || it.tag === 'HACK') ? 'warning' : 'circle-filled', new vscode.ThemeColor(colorFor(it.tag).icon));
      const uri = vscode.Uri.joinPath(vscode.Uri.parse(it.root), it.rel);
      ti.resourceUri = undefined;
      ti.tooltip = new vscode.MarkdownString(`**${report.mdCell(it.tag)}**${it.owner ? ` (${report.mdCell(it.owner)})` : ''} ${report.mdCell(it.text)}\n\n${report.mdCell(it.rel)}, line ${it.line + 1}`);
      ti.command = { command: 'vscode.open', title: 'Open', arguments: [uri, { selection: new vscode.Range(it.line, it.col, it.line, it.end), preserveFocus: false }] };
      ti.contextValue = 'zovoTodoItem';
      return ti;
    }
    const expand = setting('expanded', true) ? collapsed.Expanded : collapsed.Collapsed;
    const ti = new vscode.TreeItem(n.label, n.kind === 'file' && setting('groupBy', 'folder') === 'tag' ? collapsed.Collapsed : expand);
    ti.id = n.id;
    ti.description = [n.description, String(n.count)].filter(Boolean).join('  ');
    if (n.kind === 'file') {
      ti.resourceUri = vscode.Uri.joinPath(vscode.Uri.parse(n.root), n.rel);
      ti.iconPath = vscode.ThemeIcon.File;
      ti.contextValue = 'zovoTodoFile';
    } else if (n.kind === 'dir') { ti.iconPath = vscode.ThemeIcon.Folder; ti.resourceUri = vscode.Uri.joinPath(vscode.Uri.parse(n.root), n.rel); ti.contextValue = 'zovoTodoDir'; }
    else if (n.kind === 'tag') { ti.iconPath = new vscode.ThemeIcon('tag', new vscode.ThemeColor(colorFor(n.tag).icon)); ti.contextValue = 'zovoTodoTag'; }
    else { ti.iconPath = new vscode.ThemeIcon('root-folder'); ti.contextValue = 'zovoTodoRoot'; }
    return ti;
  }
}

// ---------------- scanning ----------------

let tree, view, status;
let scanGen = 0;
let scanning = false;
let firstScanCounted = false;

function folders() { return (vscode.workspace.workspaceFolders || []).filter((f) => f.uri.scheme === 'file'); }

async function scanAll(reason) {
  const gen = ++scanGen;
  const list = folders();
  scanning = true;
  updateStatus();
  if (view) view.message = list.length ? 'Scanning...' : undefined;
  let total = 0, truncated = false, files = 0;
  try {
    for (const key of [...store.roots.keys()]) if (!list.some((f) => f.uri.toString() === key)) store.removeRoot(key);
    for (const f of list) {
      const r = await scanFolder(f.uri.fsPath, {
        ...scanOpts(), exclude: excludeGlobs(f), gitignore: setting('useGitignore', true) !== false,
        maxFiles: setting('maxFiles', 20000), maxFileBytes: Math.max(1, setting('maxFileSizeKB', 512)) * 1024,
        shouldStop: () => gen !== scanGen,
      });
      if (gen !== scanGen) return;
      store.setRoot(f.uri.toString(), f.name, r.files);
      files += r.scanned;
      truncated = truncated || r.truncated;
    }
    // unsaved edits in open editors win over the file on disk
    for (const doc of vscode.workspace.textDocuments) if (doc.isDirty) await rescanDocument(doc);
    total = store.counts().total;
  } finally {
    if (gen === scanGen) {
      scanning = false;
      if (view) view.message = truncated ? `Stopped after ${files.toLocaleString('en-US')} files (zovoTodo.maxFiles). Exclude build folders to see all.` : undefined;
      tree.refresh();
      updateStatus();
    }
  }
  if (total > 0 && (!firstScanCounted || reason === 'manual')) { firstScanCounted = true; rating.success(); }
}

function folderOf(uri) {
  const f = vscode.workspace.getWorkspaceFolder(uri);
  return f && f.uri.scheme === 'file' ? f : null;
}
function relOf(f, uri) { return path.relative(f.uri.fsPath, uri.fsPath).split(path.sep).join('/'); }

async function excludedPath(f, rel) {
  if (globMatcher(excludeGlobs(f))(rel)) return true;
  if (setting('useGitignore', true) !== false && await ignoredByGitignore(f.uri.fsPath, rel)) return true;
  return false;
}

async function rescanDocument(doc, check = true) {
  if (!doc || doc.uri.scheme !== 'file') return;
  const f = folderOf(doc.uri);
  if (!f || !store.roots.has(f.uri.toString())) return;
  const rel = relOf(f, doc.uri);
  if (check && await excludedPath(f, rel)) return;
  if (doc.getText().length > Math.max(1, setting('maxFileSizeKB', 512)) * 1024 * 4) return;
  if (store.setFile(f.uri.toString(), rel, scanText(doc.getText(), rel, scanOpts()))) scheduleTreeRefresh();
}

const fileTimers = new Map();
function onDiskChange(uri, deleted) {
  const f = folderOf(uri);
  if (!f || !store.roots.has(f.uri.toString())) return;
  const key = uri.toString();
  clearTimeout(fileTimers.get(key));
  fileTimers.set(key, setTimeout(async () => {
    fileTimers.delete(key);
    const rel = relOf(f, uri);
    if (deleted) {
      // a deleted folder: drop every file below it
      const r = store.roots.get(f.uri.toString());
      let changed = false;
      for (const k of [...r.files.keys()]) if (k === rel || k.startsWith(`${rel}/`)) changed = store.setFile(f.uri.toString(), k, null) || changed;
      if (changed) scheduleTreeRefresh();
      return;
    }
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key && d.isDirty);
    if (open) return;
    if (await excludedPath(f, rel)) return;
    try {
      const st = await vscode.workspace.fs.stat(uri);
      if (st.type & vscode.FileType.Directory) { scheduleFullScan(); return; }
      if (st.size > Math.max(1, setting('maxFileSizeKB', 512)) * 1024) return;
      const buf = Buffer.from(await vscode.workspace.fs.readFile(uri));
      const { looksBinary } = require('./scanner');
      if (looksBinary(buf)) return;
      if (store.setFile(f.uri.toString(), rel, scanText(buf.toString('utf8'), rel, scanOpts()))) scheduleTreeRefresh();
    } catch { /* gone */ }
  }, 300));
}

let treeTimer, fullTimer;
function scheduleTreeRefresh() { clearTimeout(treeTimer); treeTimer = setTimeout(() => { tree.refresh(); updateStatus(); }, 250); }
function scheduleFullScan() { clearTimeout(fullTimer); fullTimer = setTimeout(() => scanAll('auto'), 1500); }

function updateStatus() {
  if (!status) return;
  if (setting('statusBar', true) === false) { status.hide(); return; }
  const c = store.counts();
  status.text = scanning && !c.total ? '$(sync~spin) TODO' : `$(checklist) ${c.total}`;
  const parts = Object.entries(c.byTag).sort((a, b) => tags().indexOf(a[0]) - tags().indexOf(b[0])).map(([t, n]) => `${t} ${n}`);
  status.tooltip = `${parts.length ? parts.join(', ') : 'No tags found'}${store.filter ? ` (filter: ${store.filter})` : ''}. Click to show the TODO tree.`;
  status.show();
}

// ---------------- Pro tools ----------------

async function itemsFor(arg) {
  let items = store.items();
  if (arg && arg.fsPath) {
    const f = folderOf(arg);
    if (f) {
      const rel = relOf(f, arg);
      items = items.filter((it) => it.root === f.uri.toString() && (!rel || it.rel === rel || it.rel.startsWith(`${rel}/`)));
    }
  }
  return items;
}
function projectName() { return (vscode.workspace.name || (folders()[0] && folders()[0].name) || '').replace(/ \(Workspace\)$/, ''); }
function defaultTarget(name) {
  const f = folders()[0];
  return f ? vscode.Uri.joinPath(f.uri, name) : undefined;
}

async function withBlame(items, title) {
  const byRoot = new Map();
  for (const it of items) { if (!byRoot.has(it.root)) byRoot.set(it.root, []); byRoot.get(it.root).push(it); }
  let any = false;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, async (progress) => {
    for (const [root, list] of byRoot) {
      const fsRoot = vscode.Uri.parse(root).fsPath;
      const repo = await gitTools.repoRoot(fsRoot);
      if (!repo) continue;
      any = true;
      // blame works on paths relative to the folder the command runs in
      await gitTools.blameItems(fsRoot, list, { maxFiles: setting('maxBlameFiles', 400), onProgress: (n, of) => progress.report({ message: `${n} of ${of} files` }) });
    }
  });
  return any;
}

async function exportReport(arg) {
  if (!(await pro.allowed('report', arg))) return;
  const items = await itemsFor(arg);
  if (!items.length) { vscode.window.showInformationMessage('No tags to export. Rescan, or clear the filter.'); return; }
  const fmt = await vscode.window.showQuickPick([
    { label: 'Markdown', ext: 'md', description: 'a table for a ticket, a wiki page or a pull request' },
    { label: 'CSV', ext: 'csv', description: 'for Excel, Google Sheets or a script' },
    { label: 'HTML', ext: 'html', description: 'one page to share or print' },
  ], { title: `Export ${items.length} tags as`, placeHolder: 'Pick a format' });
  if (!fmt) return;
  const target = await vscode.window.showSaveDialog({ defaultUri: defaultTarget(`todo-report.${fmt.ext}`), filters: { [fmt.label]: [fmt.ext] }, title: 'Save the TODO report' });
  if (!target) return;
  const blame = setting('reportBlame', true) !== false && await withBlame(items, 'Reading git blame for the report');
  const opt = { blame, project: projectName(), now: Date.now() };
  const text = fmt.ext === 'md' ? report.markdown(items, opt) : fmt.ext === 'csv' ? report.csv(items, opt) : report.html(items, opt);
  await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
  await pro.produced('report');
  const open = await vscode.window.showInformationMessage(`Saved ${items.length} tags to ${path.basename(target.fsPath)}.`, 'Open');
  if (open === 'Open') {
    if (fmt.ext === 'html') await vscode.env.openExternal(target); else await vscode.window.showTextDocument(target, { preview: false });
  }
}

async function pickRepoFolder(arg) {
  if (arg && arg.fsPath) { const f = folderOf(arg); if (f) return f; }
  const list = folders();
  if (list.length <= 1) return list[0];
  const p = await vscode.window.showQuickPick(list.map((f) => ({ label: f.name, f })), { title: 'Which folder?' });
  return p && p.f;
}

async function branchDelta(arg) {
  if (!(await pro.allowed('delta', arg))) return;
  const f = await pickRepoFolder(arg);
  if (!f) { vscode.window.showInformationMessage('Open a folder that is a git repository first.'); return; }
  const root = f.uri.fsPath;
  if (!(await gitTools.repoRoot(root))) { vscode.window.showWarningMessage(`${f.name} is not a git repository, or git is not installed.`); return; }
  let base = await gitTools.findBase(root, String(setting('baseBranch', '') || '').trim());
  if (!base) {
    const typed = await vscode.window.showInputBox({ title: 'Compare against which branch?', prompt: 'No main, master or develop branch found. Type a branch, tag or commit.', placeHolder: 'origin/release' });
    if (!typed) return;
    base = typed.trim();
  }
  let d;
  try {
    const ex = globMatcher(excludeGlobs(f));
    d = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Comparing TODOs with ${base}` }, () => gitTools.branchDelta(root, base, { ...scanOpts(), isExcluded: ex }));
  } catch (e) { vscode.window.showWarningMessage(`git could not compare with ${base}: ${String(e.stderr || e.message).trim().split('\n')[0]}`); return; }
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report.deltaMarkdown(d, { project: f.name }) });
  await vscode.window.showTextDocument(doc, { preview: false });
  await pro.produced('delta');
}

async function staleTodos(arg) {
  if (!(await pro.allowed('stale', arg))) return;
  const items = (await itemsFor(arg)).map((it) => ({ ...it }));
  if (!items.length) { vscode.window.showInformationMessage('No tags to check. Rescan, or clear the filter.'); return; }
  const minDays = Math.max(0, Number(setting('staleDays', 90)) || 0);
  const ok = await withBlame(items, 'Reading git blame to date each tag');
  if (!ok) { vscode.window.showWarningMessage('Stale TODOs need git history: this folder is not a git repository, or git is not installed.'); return; }
  const now = Date.now();
  const r = report.stale(items, { minDays, now });
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: report.staleMarkdown(r, { now, project: projectName() }) });
  await vscode.window.showTextDocument(doc, { preview: false });
  await pro.produced('stale');
  const save = await vscode.window.showInformationMessage(`${r.stale.length} of ${r.total} tags are ${minDays} days old or older.`, 'Save JSON for CI');
  if (save) {
    const target = await vscode.window.showSaveDialog({ defaultUri: defaultTarget('todo-stale.json'), filters: { JSON: ['json'] }, title: 'Save the stale TODO list as JSON' });
    if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(report.staleJson(r, { now, project: projectName() }), 'utf8'));
  }
}

// ---------------- activation ----------------

function activate(context) {
  ctxRef = context;
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: NAME });
  registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  pro = createPro({ vscode, context });

  tree = new TreeProvider();
  view = vscode.window.createTreeView(VIEW, { treeDataProvider: tree, showCollapseAll: true });
  context.subscriptions.push(view);
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = 'TODO count';
  status.command = 'zovoTodo.showTree';
  context.subscriptions.push(status);

  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('zovoTodo.refresh', () => scanAll('manual'));
  reg('zovoTodo.showTree', () => vscode.commands.executeCommand(`${VIEW}.focus`));
  reg('zovoTodo.groupBy', async () => {
    const cur = setting('groupBy', 'folder');
    const p = await vscode.window.showQuickPick([
      { label: 'By folder', value: 'folder', description: cur === 'folder' ? 'current' : '' },
      { label: 'By file', value: 'file', description: cur === 'file' ? 'current' : '' },
      { label: 'By tag', value: 'tag', description: cur === 'tag' ? 'current' : '' },
    ], { title: 'Group the TODO tree' });
    if (p) await cfg().update('groupBy', p.value, vscode.ConfigurationTarget.Global);
  });
  reg('zovoTodo.filter', async () => {
    const v = await vscode.window.showInputBox({ title: 'Filter the TODO tree', prompt: 'Text in the tag, the comment, the owner or the path. Empty clears the filter.', value: store.filter });
    if (v === undefined) return;
    store.filter = v.trim();
    vscode.commands.executeCommand('setContext', 'zovoTodo.filtered', !!store.filter);
    if (view) view.description = store.filter ? `filter: ${store.filter}` : undefined;
    tree.refresh(); updateStatus();
  });
  reg('zovoTodo.clearFilter', () => {
    store.filter = '';
    vscode.commands.executeCommand('setContext', 'zovoTodo.filtered', false);
    if (view) view.description = undefined;
    tree.refresh(); updateStatus();
  });
  reg('zovoTodo.copyText', (node) => { const it = node && node.item; if (it) vscode.env.clipboard.writeText(`${it.tag}${it.owner ? `(${it.owner})` : ''}: ${it.text} (${it.rel}:${it.line + 1})`); });
  reg('zovoTodo.exportReport', (arg) => exportReport(arg));
  reg('zovoTodo.branchDelta', (arg) => branchDelta(arg));
  reg('zovoTodo.staleTodos', (arg) => staleTodos(arg));
  // Explorer entries (REACH1): VS Code shows a menu item with its command's own title, so these wrappers carry
  // the 'Zovo Pro: <tool>' titles. The clicked file is the scope and makes the surface 'ctx'.
  reg('zovoTodo.zovoPro.report', (arg) => exportReport(arg));
  reg('zovoTodo.zovoPro.stale', (arg) => staleTodos(arg));
  reg('zovoTodo.zovoPro.delta', (arg) => branchDelta(arg));
  context.subscriptions.push(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));

  // highlights
  const decorateVisible = () => { for (const e of vscode.window.visibleTextEditors) decorate(e); };
  const docTimers = new Map();
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(decorateVisible));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const key = e.document.uri.toString();
    clearTimeout(docTimers.get(key));
    docTimers.set(key, setTimeout(() => {
      docTimers.delete(key);
      for (const ed of vscode.window.visibleTextEditors) if (ed.document === e.document) decorate(ed);
      rescanDocument(e.document);
    }, 200));
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((d) => rescanDocument(d)));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument((d) => { if (d.uri.scheme === 'file' && d.isDirty === false) onDiskChange(d.uri, false); }));
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(watcher,
    watcher.onDidCreate((u) => onDiskChange(u, false)),
    watcher.onDidChange((u) => onDiskChange(u, false)),
    watcher.onDidDelete((u) => onDiskChange(u, true)));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => scanAll('auto')));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${PREFIX}.highlight`) || e.affectsConfiguration(`${PREFIX}.tagColors`) || e.affectsConfiguration(`${PREFIX}.tags`)) { clearDecorations(); decorateVisible(); }
    if (['tags', 'caseSensitive', 'commentsOnly', 'exclude', 'useGitignore', 'useFilesExclude', 'maxFiles', 'maxFileSizeKB'].some((k) => e.affectsConfiguration(`${PREFIX}.${k}`)) || e.affectsConfiguration('files.exclude')) scheduleFullScan();
    if (e.affectsConfiguration(`${PREFIX}.groupBy`) || e.affectsConfiguration(`${PREFIX}.expanded`)) tree.refresh();
    if (e.affectsConfiguration(`${PREFIX}.statusBar`)) updateStatus();
  }));
  context.subscriptions.push({ dispose: clearDecorations });
  decorateVisible();
  updateStatus();
  if (setting('scanOnStartup', true) !== false) scanAll('startup');
  else if (view) view.message = 'Click Rescan to list the tags of this workspace.';
  // a small read-only API (used by the real-app test)
  return { counts: () => store.counts(), items: () => store.items(), rescan: () => scanAll('api'), tries: () => pro.tries(), scanning: () => scanning, decorationTypes: () => decoTypes.size };
}

function deactivate() { scanGen++; clearDecorations(); }

module.exports = { activate, deactivate, _store: store, _scanAll: (r) => scanAll(r), _ctx: () => ctxRef, _decoCount: () => decoTypes.size };
