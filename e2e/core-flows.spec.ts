import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { parseProject } from '../packages/core/src/project.ts';
import { startFixtureServer } from './fixtures/server.ts';
import { apiGet, blockInternet, pasteFile, pasteText, ROOT, SHOTS, startCabinet, tempLibrary, type ServerHandle } from './helpers.ts';

test.describe.configure({ mode: 'serial' });

const PORT = 4799;
let lib: ReturnType<typeof tempLibrary>;
let srv: ServerHandle;
let fx: Awaited<ReturnType<typeof startFixtureServer>>;
const ids: Record<string, string> = {};

test.beforeAll(async () => {
  lib = tempLibrary();
  fx = await startFixtureServer();
  srv = await startCabinet(lib.dir, PORT);
});

test.afterAll(async () => {
  await srv?.stop();
  await fx?.close();
  lib?.cleanup();
});

test.beforeEach(async ({ page }) => {
  await blockInternet(page);
});

const shot = (page: Page, name: string) => page.screenshot({
  path: join(SHOTS, name),
  // Keep transient capture notifications out of documentation images. The
  // Settings shot intentionally retains its successful-rebuild confirmation.
  style: name === '12-settings.png' ? '' : '[role="status"] { visibility: hidden !important; }',
});

async function waitIdle(base: string) {
  for (let i = 0; i < 60; i++) {
    const h = await apiGet(base, '/api/home');
    if (!h.jobs) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('0. paste a URL, add why with a [[link]], accept a connection, saved in under 3 s', async ({ page }) => {
  await page.goto(srv.url + '/');
  await expect(page.getByTestId('paste-strip')).toBeVisible();
  await shot(page, '01-home.png');

  const t0 = Date.now();
  await pasteText(page, fx.url + '/article');
  const sheet = page.getByTestId('capture-sheet');
  await expect(sheet).toBeVisible();
  // Optimistic preview fills in from OpenGraph
  await expect(sheet.getByRole('textbox', { name: 'Title' })).toHaveAttribute('placeholder', 'Lamps that glow, not shine');
  await expect(sheet.getByTestId('capture-preview')).toContainText('A short essay on paper lamps');
  await page.keyboard.type('Ideal light for the [[read');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Reading corner');
  await page.keyboard.press('Enter'); // accept completion
  await expect(sheet.getByRole('textbox', { name: 'Why I saved this' })).toContainText('[[reading-corner]]');
  // accept a suggested connection that isn't already linked
  const suggestion = sheet.getByTestId('connects-to').getByRole('button', { pressed: false }).first();
  const connectedTitle = (await suggestion.locator('.font-serif').textContent())!.trim();
  await suggestion.click();
  await shot(page, '02-capture-sheet.png');
  await sheet.getByTestId('capture-save').click();
  await expect(page.getByRole('status')).toContainText('Saved');
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(3000);

  const found = await apiGet(srv.url, `/api/search?q=${encodeURIComponent('Lamps that glow')}&mode=keyword`);
  const id = found.hits[0].item.id;
  ids.article = id;
  const d = await apiGet(srv.url, `/api/items/${id}`);
  expect(d.item.why).toBe('Ideal light for the [[reading-corner]]');
  const targets = d.outgoing.map((o: any) => o.item?.title);
  expect(targets).toContain('Reading corner');
  expect(targets).toContain(connectedTitle);
  expect(d.item.status).toBe('inbox');
  test.info().annotations.push({ type: 'paste-to-saved-ms', description: String(elapsed) });
});

test('1. save an article, a quote, a PDF and a timestamped video bookmark', async ({ page }) => {
  await waitIdle(srv.url);
  // article was extracted in the background
  await page.goto(srv.url + `/item/${ids.article}`);
  await expect(page.getByTestId('reader')).toContainText('Washi paper diffuses');
  await expect(page.getByTestId('source-link')).toContainText('Fixture Journal');
  await shot(page, '03-article.png');

  // quote, from the + button
  await page.getByTestId('new-capture').click();
  const sheet = page.getByTestId('capture-sheet');
  await sheet.getByRole('textbox', { name: 'Text' }).fill('A room should lower its voice so you can lower yours.');
  await sheet.getByRole('radio', { name: 'quote' }).click();
  await sheet.getByPlaceholder('Who said it (optional)').fill('Notebook, 2026');
  await sheet.getByTestId('capture-save').click();
  await expect(page.getByRole('status')).toContainText('Saved');
  const q = await apiGet(srv.url, '/api/items?type=quote&limit=5');
  const quote = q.items.find((i: any) => i.title.startsWith('A room should lower'));
  expect(quote).toBeTruthy();
  ids.quote = quote.id;

  // PDF, pasted as a file
  await page.goto(srv.url + '/');
  await pasteFile(page, join(ROOT, 'sample-library/attachments/2026/07/01j2-room-acoustics-primer.pdf'), 'bass-traps-guide.pdf', 'application/pdf');
  await expect(sheet).toBeVisible();
  await sheet.getByTestId('capture-save').click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await waitIdle(srv.url);
  const pdfs = await apiGet(srv.url, '/api/items?type=pdf&limit=10');
  const pdf = pdfs.items.find((i: any) => i.attachment?.endsWith('bass-traps-guide.pdf'));
  expect(pdf).toBeTruthy();
  ids.pdf = pdf.id;
  await page.goto(srv.url + `/item/${pdf.id}`);
  await expect(page.getByTestId('pdf-viewer')).toBeVisible();
  await expect(page.getByTestId('reader')).toContainText('Flutter echo');

  // Video with a timestamp, then add another timestamp by hand
  await page.goto(srv.url + '/');
  await pasteText(page, 'https://www.youtube.com/watch?v=Ab12Cd34Ef5&t=95');
  await sheet.getByRole('textbox', { name: 'Title' }).fill('Building a horn speaker');
  await sheet.getByTestId('capture-save').click();
  await expect(page.getByRole('status')).toContainText('Saved');
  const vids = await apiGet(srv.url, '/api/items?type=video&limit=10');
  const vid = vids.items.find((i: any) => i.title === 'Building a horn speaker');
  ids.video = vid.id;
  await page.goto(srv.url + `/item/${vid.id}`);
  await expect(page.getByTestId('timestamps')).toContainText('01:35');
  await page.getByLabel('Time', { exact: true }).fill('3:20');
  await page.getByLabel('Timestamp note').fill('the horn flare');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('timestamps')).toContainText('03:20');
  await expect(page.getByTestId('timestamps')).toContainText('the horn flare');
  const raw = await (await fetch(srv.url + `/api/items/${vid.id}/raw`)).text();
  expect(raw).toContain('- [03:20](https://youtu.be/Ab12Cd34Ef5?t=200) the horn flare');
  await shot(page, '04-video.png');
});

test('2. a note that links to them shows up in their backlinks', async ({ page }) => {
  await page.goto(srv.url + '/');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('textbox', { name: 'Command' }).fill('Speaker corner plan');
  await page.getByRole('option', { name: /New note “Speaker corner plan”/ }).click();
  await expect(page.getByTestId('item-title')).toHaveValue('Speaker corner plan');
  const editor = page.getByTestId('notes-editor').locator('.cm-content');
  await editor.click();
  await page.keyboard.type('Start from [[Lamps that');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Lamps that glow');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' and [[Building a horn');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Building a horn speaker');
  await page.keyboard.press('Enter');
  await page.keyboard.type(' and [[bass-traps');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 5000 });
  ids.note = page.url().split('/item/')[1].split('?')[0];
  await expect(page.getByTestId('outgoing')).toContainText('Lamps that glow');
  await shot(page, '05-note-editor.png');

  await page.goto(srv.url + `/item/${ids.video}`);
  await expect(page.getByTestId('backlinks')).toContainText('Speaker corner plan');
  await page.goto(srv.url + `/item/${ids.article}`);
  await expect(page.getByTestId('backlinks')).toContainText('Speaker corner plan');
  await shot(page, '06-backlinks.png');
});

test('3. explore the graph outward', async ({ page }) => {
  await page.goto(srv.url + `/graph?focus=${ids.article}&depth=1`);
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-nodes', /\d+/);
  await page.getByTestId('graph-depth').selectOption('1');
  await page.waitForTimeout(800);
  const before = Number(await canvas.getAttribute('data-nodes'));
  // click the Reading corner node to expand outward from it
  const rc = (await apiGet(srv.url, '/api/resolve?ref=reading-corner')).id;
  await page.waitForTimeout(1500);
  const pos = await page.evaluate((id) => (window as any).__cabinetGraph.screen(id), rc);
  expect(pos).toBeTruthy();
  await page.mouse.click(pos.x, pos.y);
  await expect.poll(async () => Number(await canvas.getAttribute('data-nodes'))).toBeGreaterThan(before);
  await page.waitForTimeout(1800);
  await shot(page, '07-graph.png');
});

test('4. a project made by hand: paste into it, gather into sections, reorder; the Markdown matches', async ({ page }) => {
  await page.goto(srv.url + '/projects');
  await page.getByTestId('new-project').click();
  await page.getByLabel('Title').fill('Window reading nook');
  await page.getByRole('button', { name: 'hobby' }).click();
  await page.getByLabel('Intent (optional)').fill('A small nook with a lamp and a shelf.');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByTestId('item-title')).toHaveValue('Window reading nook');
  ids.project = page.url().split('/item/')[1];

  // Paste a link while the project is open: it goes straight into the project
  await pasteText(page, fx.url + '/bulb');
  const sheet = page.getByTestId('capture-sheet');
  await expect(sheet.getByRole('heading')).toContainText('Save to Window reading nook');
  await sheet.getByLabel('Project section').fill('To buy');
  await sheet.getByLabel('Project context').fill('the 2200 K bulb for the lamp');
  await sheet.getByTestId('capture-save').click();
  await expect(page.locator('[data-section="To buy"]')).toContainText('Warm filament bulb');
  await expect(page.locator('[data-section="To buy"]')).toContainText('the 2200 K bulb for the lamp');

  // Gather existing items into named sections
  const gather = async (query: string, titles: string[], section: string) => {
    await page.getByTestId('gather').click();
    const dlg = page.getByTestId('gather-dialog');
    await dlg.getByLabel('Search to gather').fill(query);
    for (const t of titles) await dlg.getByRole('button', { name: new RegExp(t) }).first().click();
    await dlg.getByLabel('Section').fill(section);
    await dlg.getByRole('button', { name: /Add \d+ to project/ }).click();
    await expect(dlg).toBeHidden();
  };
  await gather('lamp', ['Paper lamp in a dim room', 'Paper lantern floor lamp'], 'Lighting');
  await gather('acoustics', ['A primer on small-room acoustics'], 'Acoustics');
  await expect(page.locator('[data-section="Lighting"] [data-entry]')).toHaveCount(2);

  // Give one item project-specific context
  await page.locator('[data-entry="akari-style-floor-lamp"]').getByTestId('entry-context').click();
  await page.keyboard.type('120 cm is right for the armchair');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-entry="akari-style-floor-lamp"]')).toContainText('120 cm is right');

  // Reorder: drag the floor lamp above the photo
  const handle = page.getByRole('button', { name: 'Drag Paper lantern floor lamp, 120 cm' });
  const target = page.locator('[data-entry="paper-lamp-photo"]');
  const hb = (await handle.boundingBox())!;
  const tb = (await target.boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 20, hb.y + 5, { steps: 4 });
  await page.mouse.move(tb.x + 30, tb.y + 30, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('[data-section="Lighting"] [data-entry]').first()).toHaveAttribute('data-entry', 'akari-style-floor-lamp');

  await page.getByLabel('New checklist item').fill('Measure the nook');
  await page.keyboard.press('Enter');
  await page.getByLabel('New question').fill('Does the shelf need doors');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('questions')).toContainText('Does the shelf need doors?');
  await page.waitForTimeout(500);
  await shot(page, '08-project.png');

  // The file on disk is the project, readable by hand
  const md = readFileSync(join(lib.dir, 'projects/window-reading-nook.md'), 'utf8');
  const model = parseProject(md.split('\n---\n').slice(1).join('\n---\n'));
  const lighting = model.material.find((s) => s.name === 'Lighting')!;
  const lightingTargets = lighting.lines.filter((l) => l.kind === 'item').map((l: any) => l.target).filter((t: string) => !/primer|acoustics/.test(t));
  expect(lightingTargets.slice(0, 2)).toEqual(['akari-style-floor-lamp', 'paper-lamp-photo']);
  expect(md).toContain('- [[akari-style-floor-lamp]]: 120 cm is right for the armchair');
  expect(md).toMatch(/### To buy\n- \[\[[a-z0-9-]+\]\]: the 2200 K bulb for the lamp/);
  expect(md).toContain('## Questions\n- Does the shelf need doors?');
  expect(md).toContain('## Checklist\n- [ ] Measure the nook');
  expect(md).toContain('intent: A small nook with a lamp and a shelf.');
  // Editing the list by hand updates the app
  writeFileSync(join(lib.dir, 'projects/window-reading-nook.md'), md.replace('### Acoustics', '### Sound'));
  await expect(page.locator('[data-section="Sound"]')).toBeVisible({ timeout: 6000 });
});

test('5. restart the server: everything is intact', async ({ page }) => {
  const before = await apiGet(srv.url, '/api/items?limit=500');
  await srv.stop();
  srv = await startCabinet(lib.dir, PORT);
  const after = await apiGet(srv.url, '/api/items?limit=500');
  expect(after.total).toBe(before.total);
  await page.goto(srv.url + `/item/${ids.project}`);
  await expect(page.getByTestId('item-title')).toHaveValue('Window reading nook');
  await expect(page.locator('[data-section="Lighting"] [data-entry="akari-style-floor-lamp"]')).toContainText('120 cm is right');
  await page.goto(srv.url + `/item/${ids.note}`);
  await expect(page.getByTestId('outgoing')).toContainText('Building a horn speaker');
});

test('6. external edits update the UI; a concurrent edit triggers the conflict choice', async ({ page }) => {
  const file = join(lib.dir, 'notes/speaker-corner-plan.md');
  await page.goto(srv.url + `/item/${ids.note}`);
  const editor = page.getByTestId('notes-editor').locator('.cm-content');
  await expect(editor).toContainText('Start from');
  writeFileSync(file, readFileSync(file, 'utf8').replace(/\n$/, '\n\nAdded in another editor.\n'));
  await expect(editor).toContainText('Added in another editor.', { timeout: 6000 });
  await shot(page, '09-external-edit.png');

  // Conflict: type (unsaved), and meanwhile the file changes on disk
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' My unsaved line.');
  writeFileSync(file, readFileSync(file, 'utf8').replace('Added in another editor.', 'Rewritten elsewhere.'));
  const dialog = page.getByTestId('conflict-dialog');
  await expect(dialog).toBeVisible({ timeout: 6000 });
  await shot(page, '10-conflict.png');
  await dialog.getByRole('button', { name: 'Save mine as a copy' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => readFileSync(file, 'utf8')).toContain('Rewritten elsewhere.');
  const copies = await apiGet(srv.url, '/api/search?q=' + encodeURIComponent('my copy') + '&mode=keyword');
  expect(copies.hits.some((h: any) => h.item.title === 'Speaker corner plan (my copy)')).toBe(true);
});

test('7. search works offline (browser and server cut off from the internet)', async ({ page }) => {
  await page.goto(srv.url + '/search');
  await page.getByTestId('search-input').fill('flutter echo');
  const results = page.getByTestId('search-results');
  await expect(results).toContainText('A primer on small-room acoustics');
  await expect(results.getByTestId('match-field').first()).toContainText('matched PDF text');
  await page.getByTestId('search-input').fill('washi');
  await expect(results).toContainText('Lamps that glow');
  await expect(results.getByTestId('match-field').first()).toContainText('matched content');
  await page.getByTestId('search-input').fill('armchair');
  await expect(results.getByTestId('match-field').first()).toBeVisible();
  await shot(page, '11-search.png');
});

test('8. rebuilding the index gives identical results', async ({ page }) => {
  const queries = ['lamp', 'acoustics', 'listening rooms', 'horn speaker', 'warm light'];
  const run = async () => Promise.all(queries.map(async (q) => (await apiGet(srv.url, `/api/search?mode=keyword&q=${encodeURIComponent(q)}`)).hits.map((h: any) => [h.item.id, h.field])));
  const before = await run();
  await page.goto(srv.url + '/settings');
  await page.getByTestId('rebuild').click();
  await expect(page.getByRole('status')).toContainText('Rebuilt the index');
  await shot(page, '12-settings.png');
  expect(await run()).toEqual(before);
});

test('9. export, restore, and check the result', async ({ page }) => {
  await page.goto(srv.url + '/settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export').click()]);
  const zipPath = join(lib.dir, '..', 'export.zip');
  await download.saveAs(zipPath);
  // Change something after the export, then restore
  await fetch(srv.url + `/api/items/${ids.quote}`, { method: 'DELETE' });
  expect((await fetch(srv.url + `/api/items/${ids.quote}`)).status).toBe(404);
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('restore').locator('input[type=file]').setInputFiles(zipPath);
  await expect(page.getByRole('status')).toContainText('Restored', { timeout: 15000 });
  const q = await apiGet(srv.url, `/api/items/${ids.quote}`);
  expect(q.item.title).toMatch(/^A room should lower/);
  const proj = await apiGet(srv.url, `/api/items/${ids.project}`);
  expect(proj.item.body).toContain('### Sound');
  await page.goto(srv.url + '/');
  await expect(page.getByText('Recently saved')).toBeVisible();
});
