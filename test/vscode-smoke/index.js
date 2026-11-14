// Runs inside a real VS Code extension host (extensionTestsPath), with the sample repository from
// scripts/make-sample.sh open as the workspace. Writes PASS/FAIL lines to SMOKE_OUT.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const out = process.env.SMOKE_OUT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch { /* retry */ } await sleep(150); } return false; }

exports.run = async function () {
  const log = [];
  const check = (name, ok, extra) => log.push((ok ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' :: ' + extra : ''));
  try {
    const ext = vscode.extensions.getExtension('zovo.zovo-todo-tree');
    check('extension found', !!ext);
    const ws = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    check('sample workspace open', !!ws, ws && ws.uri.fsPath);
    await until(() => ext.isActive, 15000);
    check('activated on startup (onStartupFinished)', ext.isActive);
    const api = ext.exports;
    await until(() => !api.scanning() && api.counts().total > 0, 15000);
    const c = api.counts();
    // client.ts TODO+FIXME+NOTE, http.ts BUG (HACK removed on the branch), deploy.py TODO+XXX, notes.md TODO, Cart.tsx TODO+FIXME; build/ is gitignored
    check('workspace scan finds 9 tags', c.total === 9, JSON.stringify(c));
    const items = api.items();
    check('gitignored build/ skipped', !items.some((i) => i.rel.startsWith('build/')));
    check('owner parsed (FIXME(dana))', items.some((i) => i.tag === 'FIXME' && i.owner === 'dana'));
    check('python docstring XXX found', items.some((i) => i.rel === 'scripts/deploy.py' && i.tag === 'XXX'));
    check('markdown list TODO found', items.some((i) => i.rel === 'docs/notes.md' && i.tag === 'TODO'));

    await vscode.commands.executeCommand('zovoTodo.tags.focus');
    await sleep(500);
    check('tree view opens', true);

    const file = vscode.Uri.joinPath(ws.uri, 'src/api/client.ts');
    const ed = await vscode.window.showTextDocument(file);
    await sleep(600);
    check('highlights created for the open file', api.decorationTypes() >= 3, api.decorationTypes());

    await ed.edit((b) => b.insert(new vscode.Position(0, 0), '// TODO smoke unsaved edit\n'));
    const live = await until(() => api.counts().total === 10, 5000);
    check('unsaved edit updates the tree', live, api.counts().total);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await until(() => api.counts().total === 9, 5000);

    fs.writeFileSync(path.join(ws.uri.fsPath, 'src', 'new-file.js'), '// FIXME created on disk\n');
    const disk = await until(() => api.counts().total === 10, 8000);
    check('file created on disk is picked up', disk, api.counts().total);

    await vscode.commands.executeCommand('zovoTodo.refresh');
    await until(() => !api.scanning(), 8000);
    check('manual rescan', api.counts().total === 10, api.counts().total);

    // Pro: TODOs changed on this branch, 3 free tries, then the Pro panel instead of a report
    for (let i = 0; i < 3; i++) {
      await vscode.commands.executeCommand('zovoTodo.branchDelta');
      await sleep(400);
    }
    const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
    const text = doc ? doc.getText() : '';
    check('branch delta report', /TODO changes on feature\/checkout against main/.test(text) && /FIXME \| src\/ui\/Cart\.tsx/.test(text) && /HACK \| src\/api\/http\.ts/.test(text) && text.includes('new-file.js:1 (new file)'), text.slice(0, 120).replace(/\n/g, ' '));
    check('3 tries used', api.tries().delta === 0, JSON.stringify(api.tries()));
    const docsBefore = vscode.workspace.textDocuments.filter((d) => d.isUntitled).length;
    vscode.commands.executeCommand('zovoTodo.branchDelta'); // 4th: opens the modal Pro panel, never resolves here
    await sleep(1500);
    const docsAfter = vscode.workspace.textDocuments.filter((d) => d.isUntitled).length;
    check('4th use is gated (no new report)', docsAfter === docsBefore, `${docsBefore} -> ${docsAfter}`);

    // stale finder (try 1 of 3); the "Save JSON" message is not awaited
    vscode.commands.executeCommand('zovoTodo.staleTodos');
    const stale = await until(() => { const d = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document; return d && /^# Stale TODOs/.test(d.getText()); }, 10000);
    const st = vscode.window.activeTextEditor.document.getText();
    check('stale TODO report with blame', stale && /Dana Reyes|dana|sam/.test(st) && /days old or older/.test(st), st.slice(0, 160).replace(/\n/g, ' '));
    check('stale try counted', api.tries().stale === 2, JSON.stringify(api.tries()));
  } catch (e) {
    log.push('FAIL exception :: ' + (e && e.stack || e));
  }
  fs.writeFileSync(out, log.join('\n') + '\n');
};
