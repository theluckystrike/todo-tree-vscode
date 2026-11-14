'use strict';
// VER6 23:01: VS Code shows an Explorer menu item with its command's own title (a "title" on the menu item is
// ignored), so each REACH1 Explorer entry must point to a wrapper command titled "Zovo Pro: <tool>".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');

test('REACH1 Explorer entries point to "Zovo Pro: <tool>" commands that are registered and hidden from the palette', () => {
  const items = pkg.contributes.menus['explorer/context'].filter((m) => String(m.group || '').startsWith('zovoPro@1'));
  assert.ok(items.length >= 2, 'at least two Pro tools in the Explorer');
  const cmds = new Map(pkg.contributes.commands.map((c) => [c.command, c]));
  const hidden = new Set(pkg.contributes.menus.commandPalette.filter((m) => m.when === 'false').map((m) => m.command));
  for (const m of items) {
    assert.ok(!('title' in m), `${m.command}: no ignored title field`);
    const c = cmds.get(m.command);
    assert.ok(c && c.title.startsWith('Zovo Pro: '), `${m.command} title: ${c && c.title}`);
    assert.ok(!c.category, `${m.command}: no category, so the menu reads "Zovo Pro: ..."`);
    assert.ok(hidden.has(m.command), `${m.command} hidden from the palette`);
    const id = m.command.split('.').slice(1).join('.');
    assert.ok(src.includes(`'${id}'`) || src.includes(`'${m.command}'`), `${m.command} is registered in src/extension.js`);
  }
});
