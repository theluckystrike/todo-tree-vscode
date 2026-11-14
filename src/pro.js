'use strict';
// Zovo Pro for TODO Tree & FIXME Highlighter, on top of the shared license module (src/license, copied unchanged from
// factory/sprint/license by apply.sh). Three Pro tools, 3 free tries each on this computer. A try counts only after the
// tool wrote its output (a saved report file or an opened report); Escape or Cancel never uses one.
// Nothing about Pro shows on open or activation: the panel appears only after a click on a Pro tool with no tries left.
const { createLicense } = require('./license');

const SKU = 'todo-tree-pro';
const TRIAL_USES = 3;
const TRIAL_KEY = 'zovoTodo.proTrial';

const FEATURES = {
  report: {
    title: 'Export TODO report',
    detail: 'Writes every tag in the workspace to Markdown, CSV or HTML, with the git author and the date each line was added, for a sprint review or a cleanup ticket.',
  },
  delta: {
    title: 'TODOs changed on this branch',
    detail: 'Lists the TODO, FIXME and other tags this branch added or removed against main (or the base you pick), uncommitted edits included, as a Markdown report for the pull request.',
  },
  stale: {
    title: 'Find stale TODOs',
    detail: 'Sorts the tags by age with git blame, groups them by person and saves a Markdown summary and a JSON file that a CI job can check.',
  },
};
const TOOLS = Object.values(FEATURES).map((f) => f.title);

function surfaceOf(arg) {
  if (arg && typeof arg === 'object' && typeof arg.surface === 'string') return arg.surface;
  if (arg && typeof arg === 'object' && (arg.fsPath || arg.scheme)) return 'ctx';
  return undefined;
}

function createPro({ vscode, context, license, prefix = 'zovoTodo', productName = 'TODO Tree & FIXME Highlighter' }) {
  const emitter = new vscode.EventEmitter();
  const lic = license || createLicense({ vscode, context, sku: SKU, name: 'Zovo', product: productName, commandPrefix: prefix, proTools: TOOLS });
  if (lic.onDidChange) lic.onDidChange(() => emitter.fire(lic.isPro(SKU)));

  const used = (f) => Number((context.globalState.get(TRIAL_KEY) || {})[f]) || 0;
  const left = (f) => (FEATURES[f] ? Math.max(0, TRIAL_USES - used(f)) : 0);
  const licensed = () => lic.isPro(SKU);

  /** Before a Pro tool runs: true when it may run (licensed, or a free try left). Otherwise the one panel. */
  async function allowed(f, arg) {
    if (licensed()) { if (lic.refresh) lic.refresh(); return true; }
    if (left(f) > 0) return true;
    const feat = FEATURES[f] || { title: 'This tool', detail: '' };
    const surface = surfaceOf(arg);
    return !!(await lic.requirePro(feat.title, { detail: feat.detail, triesUsed: used(f), tools: TOOLS, ...(surface ? { surface } : {}) }));
  }

  /** After the tool produced its output: counts one free try (nothing when licensed). */
  async function produced(f) {
    if (licensed() || !FEATURES[f]) return;
    const m = { ...(context.globalState.get(TRIAL_KEY) || {}) };
    m[f] = used(f) + 1;
    await context.globalState.update(TRIAL_KEY, m);
    const l = left(f);
    vscode.window.setStatusBarMessage(`Zovo Pro: free try ${used(f)} of ${TRIAL_USES} of "${FEATURES[f].title}" used${l ? `, ${l} left` : ''} on this computer.`, 8000);
    emitter.fire(false);
  }

  context.subscriptions.push(emitter);
  return {
    SKU, FEATURES, TRIAL_USES,
    get licensed() { return licensed(); },
    ready: lic.ready,
    allowed, produced, left,
    tries: () => Object.fromEntries(Object.keys(FEATURES).map((f) => [f, left(f)])),
    handleUri: (uri) => (lic.handleUri ? lic.handleUri(uri) : undefined),
    onDidChange: emitter.event,
    license: lic,
  };
}

module.exports = { createPro, FEATURES, SKU, TRIAL_USES, TRIAL_KEY, TOOLS, surfaceOf };
