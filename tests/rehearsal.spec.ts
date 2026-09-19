import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inflateSync } from 'node:zlib';
import type { Routine } from '../shared/routine';
import type { RoutineWorkingCopy } from '../frontend/src/offline';
import type { ClassSetup, MusicPlaylist } from '../shared/class-plan';

const { unzipSync } = createRequire(new URL('../frontend/package.json', import.meta.url))('fflate') as {
  unzipSync(bytes: Uint8Array): Record<string, Uint8Array>;
};

function pdfText(bytes: Buffer): string {
  const streams = [...bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(match => {
    const raw = Buffer.from(match[1]!, 'latin1');
    try { return inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); }
  });
  const mapping = new Map<string, string>();
  for (const stream of streams.filter(stream => stream.includes('beginbfchar'))) {
    for (const match of stream.matchAll(/<([a-f0-9]{4})>\s*<([a-f0-9]{4})>/gi)) {
      mapping.set(match[1]!.toLowerCase(), String.fromCharCode(Number.parseInt(match[2]!, 16)));
    }
  }
  return streams.filter(stream => stream.includes('BT')).map(stream => [...stream.matchAll(/<([a-f0-9]+)>\s*Tj/gi)]
    .map(match => match[1]!.match(/.{4}/g)!.map(code => mapping.get(code.toLowerCase()) ?? '').join('')).join('\n')).join('\n');
}

async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByRole('button', { name: 'Load demo', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role="status"]')).toContainText('Routine saved locally.');
}

async function openRoutineActions(page: Page) {
  const menu = page.locator('#panel-edit .editor-actions > .command-menu');
  if (!await menu.evaluate(node => (node as HTMLDetailsElement).open)) await menu.locator(':scope > summary').click();
}

async function expectMenuInsideViewport(menu: Locator) {
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  const width = await menu.page().evaluate(() => document.documentElement.clientWidth);
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
}

async function automaticReady(page: Page) {
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await expect(page.locator('.readiness')).toContainText('Audio verified on this device');
  await expect(page.getByRole('button', { name: 'Start class', exact: true })).toBeEnabled();
}

async function setSlider(control: Locator, percent: number) {
  await expect(control).toBeEnabled();
  await control.evaluate((node, value) => {
    (node as HTMLInputElement).value = String(value); node.dispatchEvent(new Event('input', { bubbles: true }));
  }, percent);
  await expect(control).toHaveValue(String(percent));
}

const trackOrder = (page: Page) => page.locator('details[data-track-id]').evaluateAll(cards => cards.map(card => (card as HTMLElement).dataset.trackId!));

test('R17 R18 R22 held duration, percentage controls and transient errors preserve underlying editor state', async ({ page }) => {
  await demo(page);
  const edit = page.locator('#panel-edit');
  const duration = edit.getByRole('spinbutton', { name: 'Filler duration (seconds)', exact: true });
  const mode = edit.getByRole('combobox', { name: 'Filler mode', exact: true });
  await mode.selectOption('timed'); await duration.fill('37');
  await mode.selectOption('hold'); await expect(duration).toHaveValue('');
  await mode.selectOption('timed'); await expect(duration).toHaveValue('37');
  await edit.getByRole('checkbox', { name: 'Pre-routine filler', exact: true }).check();
  await edit.getByRole('checkbox', { name: 'Post-routine filler', exact: true }).check();
  for (const card of await edit.locator('details[data-track-id]').all()) {
    if (!await card.evaluate(node => (node as HTMLDetailsElement).open)) await card.locator(':scope > summary').click();
    const analysis = card.locator('.analysis-details');
    if (!await analysis.evaluate(node => (node as HTMLDetailsElement).open)) await analysis.locator(':scope > summary').click();
  }
  const gains = edit.getByRole('slider', { name: /^(Track|Filler) level$/ });
  expect(await gains.count()).toBe(5);
  for (const slider of await gains.all()) {
    await expect(slider).toHaveAttribute('min', '0'); await expect(slider).toHaveAttribute('max', '125');
    await setSlider(slider, 0); await setSlider(slider, 125);
    await expect(slider.locator('..').locator('output')).toHaveText('125%');
  }
  const first = edit.locator('details[data-track-id]').first();
  const title = await first.locator('.track-title').textContent();
  await first.getByRole('button', { name: `After ${title}`, exact: true }).click();
  const gap = page.getByRole('dialog'); await gap.getByRole('combobox').first().selectOption('custom');
  await setSlider(gap.getByRole('slider', { name: 'Filler level', exact: true }), 70);
  await gap.getByRole('button', { name: 'Apply', exact: true }).click();
  await automaticReady(page);
  await setSlider(page.getByRole('slider', { name: 'Music volume', exact: true }), 55);
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await setSlider(edit.getByRole('slider', { name: 'Beep volume', exact: true }), 40);
  const cueId = await edit.locator('.cue-row').first().getAttribute('data-cue-id');
  const cue = edit.locator(`.cue-row[data-cue-id="${cueId}"]`);
  await cue.getByRole('combobox', { name: 'Source', exact: true }).selectOption('timestamp');
  await expect(cue.getByRole('combobox', { name: 'Source', exact: true })).toHaveValue('timestamp');
  const value = cue.getByLabel('Value', { exact: true });
  await expect(value).toHaveAttribute('type', 'text');
  await value.fill('1:60'); await value.press('Tab'); await expect(value).toHaveAttribute('aria-invalid', 'true');
  const clockStart = new Date('2026-01-01T12:00:00Z');
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(new Date(clockStart.getTime() + 1000));
  await page.locator('#app > input[type=file][aria-label="Import audio"]').setInputFiles({ name: 'invalid.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(10) });
  await expect(page.locator('.notice.notice-error')).toBeVisible();
  await page.clock.runFor(29_999); await expect(page.locator('.notice.notice-error')).toBeVisible();
  await page.clock.runFor(1); await expect(page.locator('.notice.notice-error')).toBeHidden();
  await expect(value).toHaveValue('1:60'); await expect(value).toHaveAttribute('aria-invalid', 'true');
  await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
  test(`unified routine remote workflow ${viewport.width}`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport);
    await page.goto(process.env.FIM_REMOTE_BASE_URL ?? '/');
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await page.getByRole('button', { name: 'Load demo', exact: true }).click();
    const edit = page.locator('#panel-edit');
    await expect(edit.getByRole('button', { name: 'New routine', exact: true })).toBeHidden();
    await expect(edit.locator('.routine-library')).toBeHidden();
    await edit.locator('.routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill(`Unified synthetic ${viewport.width}`);
    await edit.getByRole('checkbox', { name: 'Pre-routine filler', exact: true }).check();
    await edit.getByRole('checkbox', { name: 'Post-routine filler', exact: true }).check();
    await expect(edit.locator('[data-class-phase="before"] input[readonly]')).toHaveValue('');
    await edit.getByRole('button', { name: 'Undo edit', exact: true }).click();
    await expect(edit.getByRole('checkbox', { name: 'Post-routine filler', exact: true })).not.toBeChecked();
    await edit.getByRole('button', { name: 'Redo edit', exact: true }).click();
    await expect(edit.getByRole('checkbox', { name: 'Post-routine filler', exact: true })).toBeChecked();
    await expect(edit.getByRole('button', { name: 'Save class setup', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Prepare for Practice / Teach', exact: true })).toHaveCount(0);
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(edit.locator('.draft-identity')).toContainText('Last saved:');
    await expect(edit.locator('.draft-status')).not.toContainText('Unsaved');
    await edit.locator('.export-section > summary').click();
    await expectMenuInsideViewport(edit.locator('.export-section > .command-menu-items'));
    await page.screenshot({ path: `test-results/editor-share-${viewport.width}.png`, fullPage: true });
    await edit.getByRole('button', { name: 'Export Excel cue sheet', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('tab', { name: 'Teach', exact: true }).click();
    await expect(page.locator('.readiness')).toContainText('Audio verified on this device');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    const openDifferent = edit.getByRole('button', { name: 'Open different routine', exact: true });
    await openDifferent.scrollIntoViewIfNeeded();
    await edit.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
    await page.screenshot({ path: `test-results/editor-header-${viewport.width}.png`, fullPage: true });
    const titleBefore = await edit.locator('.routine-title').boundingBox();
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await openDifferent.click();
    const chooser = page.getByRole('dialog', { name: 'Open routine', exact: true });
    await expect(chooser).toBeVisible();
    expect(await edit.locator('.routine-title').boundingBox()).toEqual(titleBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    await expect(chooser.getByRole('searchbox')).toBeFocused();
    await chooser.getByRole('checkbox', { name: 'Favorites only', exact: true }).check();
    await expect(chooser.locator('.routine-library-row')).toHaveCount(0);
    await chooser.getByRole('checkbox', { name: 'Favorites only', exact: true }).uncheck();
    await expect(chooser.locator('.routine-library-row')).toHaveCount(1);
    await expect(chooser.locator('.current-routine')).toHaveText('Current routine');
    await expect(chooser.getByRole('button', { name: 'Delete routine', exact: true })).toBeVisible();
    await chooser.getByRole('searchbox').fill('Unmatched routine');
    await expect(chooser.locator('.chooser-empty')).toBeVisible();
    await chooser.getByRole('searchbox').clear();
    expect(await chooser.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/editor-chooser-${viewport.width}.png`, fullPage: true });
    await page.keyboard.press('Escape'); await expect(chooser).toBeHidden();
    await expect(edit.getByRole('button', { name: 'Open different routine', exact: true })).toBeFocused();
    await openRoutineActions(page);
    await expect(edit.getByRole('button', { name: 'Duplicate to new routine', exact: true })).toBeVisible();
    await expectMenuInsideViewport(edit.locator('.editor-actions > .command-menu > .command-menu-items'));
    await page.screenshot({ path: `test-results/editor-actions-${viewport.width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    const tracksHeading = edit.locator('.track-section-heading');
    await tracksHeading.locator('summary').click();
    await expect(tracksHeading.getByRole('button', { name: 'Import audio', exact: true })).toBeVisible();
    await expect(tracksHeading.getByRole('button', { name: 'From audio library', exact: true })).toBeVisible();
    await expectMenuInsideViewport(tracksHeading.locator('.command-menu-items'));
    await expect(edit.locator('.editor-actions').getByRole('button', { name: 'Import audio', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(edit.locator('.editor-footer').getByRole('button', { name: 'Delete routine', exact: true })).toBeVisible();
    await edit.getByRole('button', { name: 'Close routine', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(edit.locator('.routine-title')).toHaveText(`Unified synthetic ${viewport.width}`);
    await page.screenshot({ path: testInfo.outputPath(`unified-${viewport.width}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await edit.getByRole('button', { name: 'Close routine', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(edit.getByRole('button', { name: 'New routine', exact: true })).toBeVisible();
    await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New routine', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

function syntheticWav(seconds: number): Buffer {
  const rate = 16000, frames = rate * seconds;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame++) wav.writeInt16LE(Math.round(2500 * Math.sin(frame * 2 * Math.PI * 220 / rate)), 44 + frame * 2);
  return wav;
}

const savedTracks = (page: Page) => page.evaluate(async () => {
  const stored = await new Promise<{ routines: Routine[]; localHeads: Routine[]; copies: RoutineWorkingCopy[]; media: { id: string; blob: Blob }[] }>((accept, reject) => {
    const request = indexedDB.open('fitness-rehearsal');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['routines', 'routineWorkingCopies', 'tracks'], 'readonly');
      const routines = transaction.objectStore('routines').getAll() as IDBRequest<Routine[]>;
      const copies = transaction.objectStore('routineWorkingCopies').getAll() as IDBRequest<RoutineWorkingCopy[]>;
      const tracks = transaction.objectStore('tracks').getAll() as IDBRequest<{ blob: Blob }[]>;
      const keys = transaction.objectStore('tracks').getAllKeys();
      transaction.oncomplete = () => {
        database.close();
        accept({ routines: [...new Map([...routines.result, ...copies.result.map(copy => copy.envelope.routine)].map(routine => [routine.id, routine])).values()],
          localHeads: routines.result, copies: copies.result, media: tracks.result.map((record, index) => ({ id: String(keys.result[index]), blob: record.blob })) });
      };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  });
  return { routines: stored.routines, localHeads: stored.localHeads, localVersions: Object.fromEntries(stored.copies.map(copy => [copy.envelope.routine.id, copy.localVersion])), media: await Promise.all(stored.media.map(async ({ id, blob }) => ({
    id, bytes: blob.size, contentType: blob.type,
    hash: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join(''),
  }))) };
});

test('track reorder: three-track mouse drop preserves cues, levels and audio across save/reload without changing the playing snapshot', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  await page.locator('#app > input[type=file][aria-label="Import audio"]').setInputFiles({
    name: 'Synthetic third track.wav', mimeType: 'audio/wav', buffer: syntheticWav(20),
  });
  await expect(page.locator('details[data-track-id]')).toHaveCount(3);
  const original = await trackOrder(page);
  for (const [index, id] of original.entries()) {
    const card = page.locator(`details[data-track-id="${id}"]`);
    if (!await card.evaluate(node => (node as HTMLDetailsElement).open)) await card.locator(':scope > summary').click();
    await card.locator('.analysis-details > summary').click();
    await setSlider(card.getByRole('slider', { name: 'Track level', exact: true }), Number(String(0.5 + index / 4)) * 100);
    await card.locator('.track-preview').getByRole('button', { name: 'Add cue', exact: true }).click();
    const note = card.locator('textarea:focus');
    await note.fill(`Reorder cue ${index + 1} <literal>`);
    const cueId = await card.locator('.cue-row').filter({ has: page.locator('textarea:focus') }).getAttribute('data-cue-id');
    const row = card.locator(`.cue-row[data-cue-id="${cueId}"]`);
    await row.getByLabel('Value', { exact: true }).fill(`0:0${index + 1}.125`);
    await row.getByLabel('Value', { exact: true }).press('Tab');
    await card.locator(':scope > summary').click();
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.draft-status')).not.toContainText('Unsaved');
  const before = await savedTracks(page);
  expect(before.routines).toHaveLength(1); expect(before.media).toHaveLength(3);
  expect(before.routines[0]!.tracks.map(track => track.id)).toEqual(original);
  expect(before.routines[0]!.tracks.map(track => track.gain)).toEqual([0.5, 0.75, 1]);
  const first = page.locator(`details[data-track-id="${original[0]}"]`);
  const title = await first.locator('.track-title').textContent();
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await automaticReady(page);
  const preparedPlaylist = await page.locator('.playlist-items').textContent();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const progress = page.getByRole('progressbar', { name: 'Track progress', exact: true });
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  if (await first.evaluate(node => (node as HTMLDetailsElement).open)) await first.locator(':scope > summary').click();
  await expect(first).toHaveJSProperty('open', false);
  await page.locator('.track-list').scrollIntoViewIfNeeded();
  const grip = first.locator('.track-reorder-grip');
  await expect(grip).toHaveAccessibleName(`Reorder ${title}`);
  await expect(grip).toHaveAttribute('title', `Reorder ${title}`);
  const start = (await grip.boundingBox())!;
  expect(start.width).toBeGreaterThanOrEqual(44); expect(start.height).toBeGreaterThanOrEqual(44);
  const target = (await page.locator('details[data-track-id]').last().boundingBox())!;
  const oldNode = await grip.elementHandle();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, target.y + target.height - 10, { steps: 10 });
  await expect(page.locator('#panel-edit .track-insertion-line')).toBeVisible();
  await expect(grip).toHaveAttribute('aria-pressed', 'true');
  expect(await trackOrder(page)).toEqual(original);
  expect(await oldNode!.evaluate(node => node.isConnected)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('track-mouse-insertion.png') });
  await page.mouse.up();
  const reordered = [original[1], original[2], original[0]];
  await expect.poll(() => trackOrder(page)).toEqual(reordered);
  await expect(grip).toBeFocused();
  await expect(first).toHaveJSProperty('open', false);
  await expect(page.locator('#panel-edit .visually-hidden[role="status"][aria-live="polite"]')).toHaveText(`${title} moved to position 3 of 3.`);
  await expect(page.locator('.draft-status')).toContainText('Unsaved');
  expect(await savedTracks(page)).toEqual(before);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role="status"]')).toContainText('Routine saved locally.');
  const saved = await savedTracks(page);
  expect(saved.media).toEqual(before.media);
  expect(saved.localVersions[before.routines[0]!.id]).toBe(before.localVersions[before.routines[0]!.id]! + 1);
  expect(saved.routines).toEqual([{ ...before.routines[0]!, savedAt: expect.any(Number),
    tracks: [before.routines[0]!.tracks[1], before.routines[0]!.tracks[2], before.routines[0]!.tracks[0]] }]);
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await expect(page.locator('.playlist-items')).toHaveText(preparedPlaylist!);
  await expect(page.locator('.playing-title')).toHaveText(title!);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  const elapsed = Number(await progress.getAttribute('aria-valuenow'));
  await expect.poll(async () => Number(await progress.getAttribute('aria-valuenow'))).toBeGreaterThan(elapsed);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  expect(await trackOrder(page)).toEqual(reordered);
  expect(await savedTracks(page)).toEqual(saved);
  expect(errors).toEqual([]);
});

test('track reorder: expanded cards autoscroll without collapsing or restarting the audition', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  const original = await trackOrder(page);
  const first = page.locator(`details[data-track-id="${original[0]}"]`);
  const second = page.locator(`details[data-track-id="${original[1]}"]`);
  await expect(first).toHaveJSProperty('open', true);
  await first.getByRole('button', { name: 'Play preview', exact: true }).click();
  const cursor = first.getByRole('slider', { name: 'Seek preview', exact: true });
  await expect.poll(async () => Number(await cursor.inputValue())).toBeGreaterThan(0.1);
  const grip = first.locator('.track-reorder-grip');
  await grip.scrollIntoViewIfNeeded();
  const start = (await grip.boundingBox())!;
  const scroll = await page.evaluate(() => scrollY);
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, 880, { steps: 10 });
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 15000 }).toBeGreaterThan(scroll);
  await expect.poll(async () => { const bounds = (await second.boundingBox())!; return bounds.y + bounds.height / 2; },
    { timeout: 15000 }).toBeLessThan(880);
  expect(await trackOrder(page)).toEqual(original);
  await expect(first).toHaveJSProperty('open', true);
  await page.mouse.up();
  await expect.poll(() => trackOrder(page)).toEqual([...original].reverse());
  await expect(grip).toBeFocused();
  await expect(first).toHaveJSProperty('open', true);
  await expect(second).toHaveJSProperty('open', false);
  await expect(first.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  const elapsed = Number(await cursor.inputValue());
  await expect.poll(async () => Number(await cursor.inputValue())).toBeGreaterThan(elapsed);
  await first.getByRole('button', { name: 'Pause preview', exact: true }).click();
});

test('track reorder: Escape, outside release and small grip clicks never change order or disclosure', async ({ page }) => {
  await demo(page);
  const first = page.locator('details[data-track-id]').first();
  const original = await trackOrder(page);
  await first.getByRole('textbox', { name: 'Track title', exact: true }).fill('Editable title <literal>');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role="status"]')).toContainText('Routine saved locally.');
  const saved = await savedTracks(page);
  const status = await page.locator('.draft-status').textContent();
  const titleInput = first.getByRole('textbox', { name: 'Track title', exact: true });
  await titleInput.scrollIntoViewIfNeeded();
  const inputBounds = (await titleInput.boundingBox())!;
  await page.mouse.move(inputBounds.x + 10, inputBounds.y + inputBounds.height / 2);
  await page.mouse.down(); await page.mouse.move(inputBounds.x + 40, inputBounds.y + inputBounds.height / 2);
  await expect(page.locator('#panel-edit .track-insertion-line')).toBeHidden(); await page.mouse.up();
  await first.getByRole('button', { name: 'Play preview', exact: true }).click();
  const seek = first.getByRole('slider', { name: 'Seek preview', exact: true });
  await expect(seek).toBeEnabled();
  await seek.scrollIntoViewIfNeeded();
  const seekBounds = (await seek.boundingBox())!;
  await page.mouse.move(seekBounds.x + seekBounds.width / 4, seekBounds.y + seekBounds.height / 2);
  await page.mouse.down(); await page.mouse.move(seekBounds.x + seekBounds.width / 2, seekBounds.y + seekBounds.height / 2);
  await expect(page.locator('#panel-edit .track-insertion-line')).toBeHidden(); await page.mouse.up();
  expect(Number(await seek.inputValue())).toBeGreaterThan(1);
  await first.getByRole('button', { name: 'Pause preview', exact: true }).click();
  expect(await trackOrder(page)).toEqual(original);
  await expect(page.locator('.draft-status')).toHaveText(status!);
  await first.locator(':scope > summary').click();
  const grip = first.locator('.track-reorder-grip');
  await grip.click(); await expect(first).toHaveJSProperty('open', false);
  for (const cancellation of ['Escape', 'outside', 'threshold', 'same-position']) {
    await page.locator('.track-list').scrollIntoViewIfNeeded();
    const start = (await grip.boundingBox())!;
    const list = (await page.locator('.track-list').boundingBox())!;
    const target = (await page.locator('details[data-track-id]').last().boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + start.width / 2,
      cancellation === 'threshold' ? start.y + start.height / 2 + 5 : cancellation === 'same-position'
        ? start.y + start.height / 2 + 10 : target.y + target.height - 10, { steps: 5 });
    if (cancellation === 'Escape') await page.keyboard.press('Escape');
    if (cancellation === 'outside') await page.mouse.move(list.x - 5, target.y + target.height - 10);
    await page.mouse.up();
    await expect(page.locator('#panel-edit .track-insertion-line')).toBeHidden();
    expect(await trackOrder(page)).toEqual(original);
    await expect(first).toHaveJSProperty('open', false);
    await expect(page.locator('.draft-status')).toHaveText(status!);
    expect(await savedTracks(page)).toEqual(saved);
  }
});

test('track reorder: actual touch pointers work in portrait and landscape with autoscroll and native scrolling elsewhere', async ({ page, context }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => {
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  };
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await demo(page);
    await page.locator('details[data-track-id]').first().locator(':scope > summary').click();
    for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(viewport);
      const original = await trackOrder(page);
      await page.locator('.track-list').scrollIntoViewIfNeeded();
      const grip = page.locator('details[data-track-id]').first().locator('.track-reorder-grip');
      expect(await grip.evaluate(node => getComputedStyle(node).touchAction)).toBe('none');
      expect(await page.locator('.track-list').evaluate(node => getComputedStyle(node).touchAction)).toBe('auto');
      const start = (await grip.boundingBox())!;
      const target = (await page.locator('details[data-track-id]').last().boundingBox())!;
      const startY = start.y + start.height / 2;
      const targetY = target.y + target.height - 10;
      await touch('touchStart', start.x + start.width / 2, startY);
      for (let step = 1; step <= 8; step++) await touch('touchMove', start.x + start.width / 2, startY + (targetY - startY) * step / 8);
      await expect(page.locator('#panel-edit .track-insertion-line')).toBeVisible();
      await expect(grip).toHaveAttribute('aria-pressed', 'true');
      expect(await trackOrder(page)).toEqual(original);
      await page.screenshot({ path: testInfo.outputPath(`track-touch-${viewport.width}.png`) });
      await touch('touchEnd');
      await expect.poll(() => trackOrder(page)).toEqual([...original].reverse());
      await expect(page.locator(`.track-reorder-grip[data-track-id="${original[0]}"]`)).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const beforeScroll = await trackOrder(page);
    const expanded = page.locator('details[data-track-id]').first();
    await expanded.locator(':scope > summary').click();
    const handle = expanded.locator('.track-reorder-grip');
    await handle.scrollIntoViewIfNeeded();
    const start = (await handle.boundingBox())!;
    const initialScroll = await page.evaluate(() => scrollY);
    const edge = 820;
    await touch('touchStart', start.x + start.width / 2, start.y + start.height / 2);
    for (let step = 1; step <= 8; step++) await touch('touchMove', start.x + start.width / 2,
      start.y + start.height / 2 + (edge - start.y - start.height / 2) * step / 8);
    await expect.poll(() => page.evaluate(() => scrollY), { timeout: 15000 }).toBeGreaterThan(initialScroll);
    const destination = page.locator('details[data-track-id]').last();
    await expect.poll(async () => { const bounds = (await destination.boundingBox())!; return bounds.y + bounds.height / 2; },
      { timeout: 15000 }).toBeLessThan(edge);
    expect(await trackOrder(page)).toEqual(beforeScroll);
    await expect(expanded).toHaveJSProperty('open', true);
    await page.screenshot({ path: testInfo.outputPath('track-touch-autoscroll.png') });
    await touch('touchEnd');
    await expect.poll(() => trackOrder(page)).toEqual([...beforeScroll].reverse());
    const moved = page.locator(`details[data-track-id="${beforeScroll[0]}"]`);
    await expect(moved).toHaveJSProperty('open', true);
    await expect(moved.locator('.track-reorder-grip')).toBeFocused();
    await page.locator('details[data-track-id]').first().locator(':scope > summary').click();
    await page.locator('.track-reorder-grip').first().scrollIntoViewIfNeeded();
    const list = (await page.locator('.track-list').boundingBox())!;
    const scroll = await page.evaluate(() => scrollY);
    await touch('touchStart', list.x + 6, 600);
    for (let step = 1; step <= 10; step++) await touch('touchMove', list.x + 6, 600 - step * 30);
    await touch('touchEnd');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(scroll);
    await expect(page.locator('#panel-edit .track-insertion-line')).toBeHidden();
    expect(errors).toEqual([]);
  } finally { await cdp.detach(); }
});

test('track reorder: locked drafts block forced pointer, grip arrows and both move buttons', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await demo(page);
  page.once('dialog', dialog => dialog.accept());
  await openRoutineActions(page);
  await page.getByRole('button', { name: 'Save and lock', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
  const original = await trackOrder(page);
  const saved = await savedTracks(page);
  expect(saved.localHeads).toHaveLength(1);
  expect(saved.localHeads[0]).toMatchObject({ locked: true, tracks: saved.routines[0]!.tracks });
  const status = await page.locator('.draft-status').textContent();
  const grip = page.locator('.track-reorder-grip').first();
  await expect(grip).toBeDisabled();
  await grip.scrollIntoViewIfNeeded();
  const bounds = (await grip.boundingBox())!;
  const pointer = { pointerId: 17, pointerType: 'touch', button: 0, isPrimary: true,
    clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2 };
  await grip.dispatchEvent('pointerdown', pointer);
  await grip.dispatchEvent('pointermove', { ...pointer, clientY: pointer.clientY + 40 });
  await grip.dispatchEvent('pointerup', { ...pointer, clientY: pointer.clientY + 40 });
  for (const key of ['ArrowUp', 'ArrowDown']) await grip.dispatchEvent('keydown', { key });
  for (const name of ['Move track up', 'Move track down']) {
    const button = page.getByRole('button', { name, exact: true }).first();
    await expect(button).toBeDisabled(); await button.dispatchEvent('click');
  }
  await expect(page.locator('#panel-edit .track-insertion-line')).toBeHidden();
  expect(await trackOrder(page)).toEqual(original);
  expect(await savedTracks(page)).toEqual(saved);
  await expect(page.locator('.draft-status')).toHaveText(status!);
  expect(errors).toEqual([]);
});

test('insecure origins show the HTTPS requirement before loading private storage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => Object.defineProperty(globalThis, 'isSecureContext', { value: false }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'HTTPS required', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Plain LAN HTTP is not supported.');
  await expect(page.getByRole('button', { name: 'Import audio', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('duplicate preserves locked original and stale tab cannot unlock it', async ({ page, context }) => {
  page.on('dialog', dialog => dialog.accept());
  await demo(page);
  const originalName = await page.getByRole('textbox', { name: 'Routine name', exact: true }).inputValue();
  const other = await context.newPage();
  await other.goto('/');
  await other.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(other.getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue(originalName);
  await openRoutineActions(page);
  await page.getByRole('button', { name: 'Save and lock', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
  const locked = await savedTracks(page);
  expect(locked.localHeads).toHaveLength(1);
  expect(locked.localHeads[0]).toMatchObject({ name: originalName, locked: true });
  await other.getByRole('textbox', { name: 'Routine name', exact: true }).fill('Stale unlocked edit');
  await other.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(other.getByRole('alert')).toHaveText('Unlock the routine before editing.');
  await expect(other.getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue('Stale unlocked edit');
  expect(await savedTracks(other)).toEqual(locked);
  await openRoutineActions(page);
  await page.getByRole('button', { name: 'Duplicate to new routine', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Routine name', exact: true }).fill('Second class');
  await page.getByRole('dialog').getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#panel-edit .draft-status')).not.toContainText('Unsaved');
  const duplicated = await savedTracks(page);
  expect(duplicated.localHeads).toEqual(locked.localHeads);
  expect(duplicated.routines.find(routine => routine.id === locked.routines[0]!.id)).toEqual(locked.routines[0]);
  expect(duplicated.localVersions[locked.routines[0]!.id]).toBe(locked.localVersions[locked.routines[0]!.id]);
  expect(duplicated.routines.find(routine => routine.name === 'Second class')).toMatchObject({ locked: false, published: false });
  await page.getByRole('button', { name: 'Open different routine', exact: true }).click();
  const routines = page.locator('.routine-library-rows');
  await expect(routines.locator('.routine-library-row')).toHaveCount(2);
  await routines.getByRole('button', { name: `Open ${originalName}`, exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue(originalName);
  await expect(page.getByRole('textbox', { name: 'Routine name', exact: true })).toBeDisabled();
  await other.close();
});

test('production shell and saved songs reload offline and play', async ({ page, context }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await demo(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await context.setOffline(true);
  await page.reload();
  await automaticReady(page);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled({ timeout: 15000 });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(1);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.brand-mark')).toHaveJSProperty('naturalWidth', 192);
  expect(pageErrors).toEqual([]);
});

test('mobile layout, theme preferences, and plain-text cue content', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await page.getByRole('textbox', { name: 'Routine name', exact: true }).fill('<img src=x onerror=alert(1)>');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.getByRole('button', { name: 'Teal', exact: true }).click();
  await page.getByLabel('High contrast', { exact: true }).check();
  await page.reload();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('High contrast', { exact: true })).toBeChecked();
  for (const viewport of [{ width: 320, height: 700 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const tab of ['Teach', 'Routines', 'Playlists', 'Settings']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await expect(page.locator('#panel-teach h1')).toContainText('<img src=x onerror=alert(1)>');
  expect(await page.locator('img[onerror]').count()).toBe(0);
  await page.screenshot({ path: 'test-results/mobile-rehearsal.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: 'test-results/desktop-rehearsal.png', fullPage: true });
});

test('song preview captures cues, sorts committed times, and retains locked beep flags', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await demo(page);
  const song = page.locator('details[data-track-id]').first();
  await song.getByRole('button', { name: 'Play preview', exact: true }).click();
  const cursor = song.getByRole('slider', { name: 'Seek preview' });
  await expect.poll(async () => Number(await cursor.inputValue())).toBeGreaterThan(0.1);
  await song.locator('.track-preview').getByRole('button', { name: 'Add cue', exact: true }).click();
  const focused = page.locator('textarea:focus');
  await expect(focused).toHaveValue('New move');
  await focused.fill('Marked during preview');
  const cueId = await focused.locator('..').locator('..').getAttribute('data-cue-id');
  const row = song.locator(`[data-cue-id="${cueId}"]`);
  expect(await row.getByLabel('Value', { exact: true }).inputValue()).toMatch(/^0:0\d\.\d*[1-9]\d*$/);
  await expect(song.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  await row.getByLabel('Beep at cue', { exact: true }).check();
  await row.getByLabel('Value', { exact: true }).fill('21');
  await row.getByLabel('Value', { exact: true }).press('Tab');
  await expect(song.locator('.cue-row').last()).toHaveAttribute('data-cue-id', cueId!);
  await row.getByLabel('Value', { exact: true }).fill('1');
  await row.getByLabel('Value', { exact: true }).press('Tab');
  await expect(song.locator('.cue-row').nth(1)).toHaveAttribute('data-cue-id', cueId!);
  await expect(row.locator('select')).toHaveAccessibleName('Source');
  await row.locator('select').selectOption('count');
  await row.getByLabel('Value', { exact: true }).fill('35');
  await row.getByLabel('Value', { exact: true }).press('Tab');
  await expect(song.locator('.cue-row').last()).toHaveAttribute('data-cue-id', cueId!);
  await page.getByRole('spinbutton', { name: 'Single warning (seconds remaining)', exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(page.locator(`[data-cue-id="${cueId}"]`).getByLabel('Beep at cue')).toBeChecked();
  await expect(page.getByRole('spinbutton', { name: 'Single warning (seconds remaining)', exact: true })).toHaveValue('5');
  await openRoutineActions(page);
  await page.getByRole('button', { name: 'Save and lock', exact: true }).click();
  await expect(song.getByLabel('Beep at cue').first()).toBeDisabled();
  await expect(song.getByRole('button', { name: 'Play preview', exact: true })).toBeEnabled();
});

test('invalid timestamps block saving, cue marker seeks never add cues, and delete Cancel preserves audition', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  const song = page.locator('details[data-track-id]').first();
  const cueId = await song.locator('.cue-row').first().getAttribute('data-cue-id');
  const row = song.locator(`[data-cue-id="${cueId}"]`);
  const cueNote = await row.getByRole('textbox', { name: 'Move / note', exact: true }).inputValue();
  await row.getByRole('combobox', { name: 'Source', exact: true }).selectOption('timestamp');
  const timing = row.getByLabel('Value', { exact: true });
  await timing.fill('1:60');
  await timing.press('Tab');
  await expect(timing).toHaveValue('1:60');
  await expect(timing).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await openRoutineActions(page);
  const duplicate = page.getByRole('button', { name: 'Duplicate to new routine', exact: true });
  await expect(duplicate).toBeDisabled();
  await duplicate.dispatchEvent('click');
  await row.getByRole('combobox', { name: 'Source', exact: true }).selectOption('count');
  await expect(row.getByRole('combobox', { name: 'Source', exact: true })).toHaveValue('timestamp');
  await expect(timing).toHaveValue('1:60');
  await expect(row.getByRole('textbox', { name: 'Move / note', exact: true })).toHaveValue(cueNote);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await timing.fill('0:01.125');
  await timing.press('Tab');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  await song.getByRole('button', { name: 'Play preview', exact: true }).click();
  await expect(song.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  const count = await song.locator('.cue-row').count();
  const marker = song.locator(`[data-preview-cue-id="${cueId}"]`);
  await marker.focus(); await marker.press('Enter');
  await expect(song.locator('.cue-row')).toHaveCount(count);
  const remove = song.locator(`[data-cue-id="${cueId}"]`).getByRole('button', { name: 'Delete cue', exact: true });
  const trackTitle = await song.getByRole('textbox', { name: 'Track title', exact: true }).inputValue();
  page.once('dialog', async dialog => { expect(dialog.message()).toContain(cueNote); expect(dialog.message()).toContain(trackTitle); await dialog.dismiss(); });
  await remove.click();
  await expect(remove).toBeFocused();
  await expect(song.locator('.cue-row')).toHaveCount(count);
  await expect(song.getByRole('button', { name: 'Pause preview', exact: true })).toBeVisible();
  const cursor = song.getByRole('slider', { name: 'Seek preview', exact: true });
  const before = Number(await cursor.inputValue());
  await expect.poll(async () => Number(await cursor.inputValue())).toBeGreaterThan(before);
  for (const viewport of [{ width: 320, height: 700 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await expect(song.locator('.track-preview').getByRole('button', { name: 'Add cue', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  }
});

test('filler audition and playback-only class view work in portrait and landscape', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { value: undefined }));
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await page.getByRole('button', { name: 'Preview filler', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop filler preview', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop filler preview', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop filler preview', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await automaticReady(page);
  await page.getByRole('button', { name: 'Start class', exact: true }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exit class mode', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Routines', exact: true })).toBeHidden();
  await expect(page.locator('#panel-teach').getByRole('button', { name: 'Prepare for Practice / Teach', exact: true })).toBeHidden();
  await expect(page.locator('.app-header')).toBeHidden();
  await expect.poll(async () => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/class-${viewport.width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Exit class mode', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Routines', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('playlist workspace Open Close Save and import Undo preserve independent routine snapshots without autoplay', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe = { starts: 0 }; Object.assign(window, { playlistAudioProbe: probe });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) { probe.starts++; return start.apply(this, args); };
  });
  await demo(page);
  const routineName = page.locator('#panel-edit').getByRole('textbox', { name: 'Routine name', exact: true });
  await routineName.fill('Unsaved routine retained');
  await page.getByRole('region', { name: 'Class sequence', exact: true }).getByRole('checkbox', { name: 'Walk-in music', exact: true }).check();
  const phase = page.getByRole('region', { name: 'Walk-in music', exact: true });
  await phase.getByRole('button', { name: 'Manage music playlists', exact: true }).click();
  const panel = page.locator('#panel-playlists');
  await expect(page.getByRole('tab', { name: 'Playlists', exact: true })).toHaveAttribute('aria-selected', 'true');
  await panel.getByRole('button', { name: 'New music playlist', exact: true }).click();
  await panel.getByLabel('Playlist name', { exact: true }).fill('Arrival');
  await panel.locator('summary[aria-label="Add track"]').click();
  await expectMenuInsideViewport(panel.locator('.section-heading .command-menu-items'));
  await expect(panel.getByRole('button', { name: 'From audio library', exact: true })).toBeVisible();
  const importButton = panel.locator('.section-heading .command-menu-items').getByRole('button', { name: 'Import audio', exact: true });
  await expect(importButton).toHaveCount(1);
  const choosingFiles = page.waitForEvent('filechooser');
  await importButton.click();
  const input = await choosingFiles;
  await input.setFiles([{ name: 'Arrival A.wav', mimeType: 'audio/wav', buffer: syntheticWav(3) },
    { name: 'Arrival B.wav', mimeType: 'audio/wav', buffer: syntheticWav(4) }]);
  await expect(panel.locator('.playlist-entry')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Undo edit', exact: true }).click(); await expect(panel.locator('.playlist-entry')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Redo edit', exact: true }).click(); await expect(panel.locator('.playlist-entry')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.locator('.playlist-save-status')).toHaveText('Saved on this device');
  await expect(panel.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  const readCopies = () => page.evaluate(async () => new Promise<import('../frontend/src/offline').PlaylistWorkingCopy[]>((accept, reject) => {
    const request = indexedDB.open('fitness-rehearsal'); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const database = request.result; const transaction = database.transaction('playlistWorkingCopies');
      const records = transaction.objectStore('playlistWorkingCopies').getAll(); records.onsuccess = () => accept(records.result);
      transaction.oncomplete = () => database.close(); transaction.onabort = () => reject(transaction.error); };
  }));
  const saved = (await readCopies())[0]!; expect(saved.pendingCloud).toBe(false);
  expect(saved.envelope.playlist.tracks.every(track => track.cues.length === 0 && track.after === undefined)).toBe(true);
  const opener = panel.getByRole('button', { name: 'Open different playlist', exact: true });
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 700 }]) {
    await page.setViewportSize(viewport);
    await opener.scrollIntoViewIfNeeded();
    const bounds = await panel.locator('.playlist-editor').boundingBox(); const scroll = await page.evaluate(() => window.scrollY);
    await opener.click(); const chooser = page.getByRole('dialog', { name: 'Open playlist', exact: true });
    await expect(chooser).toBeVisible(); await expectMenuInsideViewport(chooser);
    await expect(chooser.locator('[aria-current="true"]')).toContainText('Arrival');
    expect(await panel.locator('.playlist-editor').boundingBox()).toEqual(bounds); expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
    await page.screenshot({ path: `test-results/playlist-chooser-${viewport.width}.png`, fullPage: true });
    await chooser.getByRole('button', { name: 'Close playlist chooser', exact: true }).click(); await expect(opener).toBeFocused();
    for (const selector of ['#app > input[type=file]', '#panel-playlists input[type=file]']) {
      const dimensions = await page.locator(selector).evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      });
      expect(dimensions, selector).toEqual({ width: 1, height: 1 });
    }
    const pageWidth = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      viewportWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageWidth.scrollWidth).toBeLessThanOrEqual(pageWidth.viewportWidth + 1);
    await expect(panel.getByRole('spinbutton', { name: /BPM|Crossfade|Cue/ })).toHaveCount(0);
    await expect(panel.locator('.class-sequence, .cue-row, .filler-controls, .phase-track-list')).toHaveCount(0);
    await expect(panel.locator('.playlist-track-number')).toHaveText(['1', '2']);
    for (const tab of await page.getByRole('tab').all()) {
      const tabBounds = (await tab.boundingBox())!; expect(tabBounds.x).toBeGreaterThanOrEqual(0);
      expect(tabBounds.x + tabBounds.width).toBeLessThanOrEqual(viewport.width);
    }
    await page.screenshot({ path: `test-results/playlist-editor-${viewport.width}.png`, fullPage: true });
  }
  await panel.getByRole('button', { name: 'Return to routine', exact: true }).click();
  await expect(routineName).toHaveValue('Unsaved routine retained');
  await phase.getByRole('button', { name: 'Refresh playlists', exact: true }).click();
  await phase.getByRole('combobox', { name: 'Music playlist', exact: true }).selectOption({ label: 'Arrival / Local / Draft' });
  await page.locator('#panel-edit').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#panel-edit .draft-status')).not.toContainText('Unsaved');
  const adopted = (await savedTracks(page)).routines.find(value => value.name === 'Unsaved routine retained')!.sequence!.walkIn!;
  expect(adopted.tracks.map(track => track.id)).not.toEqual(saved.envelope.playlist.tracks.map(track => track.id));
  await page.getByRole('tab', { name: 'Playlists', exact: true }).click();
  await panel.getByLabel('Playlist name', { exact: true }).fill('Arrival revised');
  await setSlider(panel.getByRole('slider', { name: 'Track level', exact: true }).first(), 75);
  await panel.getByRole('button', { name: 'Close playlist', exact: true }).click();
  let decision = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Discard changes', exact: true }) });
  await decision.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Close playlist', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Close playlist', exact: true }).click();
  decision = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Discard changes', exact: true }) });
  await decision.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'New music playlist', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Open Arrival revised', exact: true }).click();
  await expect(panel.getByLabel('Playlist name', { exact: true })).toHaveValue('Arrival revised');
  await expect(panel.getByRole('slider', { name: 'Track level', exact: true }).first()).toHaveValue('75');
  expect((await readCopies())[0]!.envelope.playlist.id).toBe(saved.envelope.playlist.id);
  expect((await savedTracks(page)).routines.find(value => value.name === 'Unsaved routine retained')!.sequence!.walkIn).toEqual(adopted);
  expect(await page.evaluate(() => (window as unknown as { playlistAudioProbe: { starts: number } }).playlistAudioProbe.starts)).toBe(0);
  const playlistTab = page.getByRole('tab', { name: 'Playlists', exact: true }); await playlistTab.focus(); await playlistTab.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toBeFocused();
  await page.getByRole('tab', { name: 'Settings', exact: true }).press('Home'); await expect(page.getByRole('tab', { name: 'Teach', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('empty optional playlists cannot be adopted and disabling them prepares the whole routine ReadySilent', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe = { starts: 0 };
    Object.assign(window, { emptyPlaylistAudioProbe: probe });
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      probe.starts++;
      return start.apply(this, args);
    };
  });
  const starts = () => page.evaluate(() => (window as unknown as { emptyPlaylistAudioProbe: { starts: number } }).emptyPlaylistAudioProbe.starts);
  await demo(page);
  const saved = await savedTracks(page);
  const routine = saved.routines[0]!;
  expect(routine.tracks.length).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Playlists', exact: true }).click();
  const library = page.locator('#panel-playlists');
  await library.getByRole('button', { name: 'New music playlist', exact: true }).click();
  await library.getByLabel('Playlist name', { exact: true }).fill('Empty optional playlist');
  await library.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Playlist saved on this device.');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  const sequence = page.getByRole('region', { name: 'Class sequence', exact: true });
  for (const label of ['Walk-in music', 'Walk-out music']) {
    await sequence.getByRole('checkbox', { name: label, exact: true }).check();
    await page.getByRole('region', { name: label, exact: true }).getByRole('combobox', { name: 'Music playlist', exact: true })
      .selectOption({ label: 'Empty optional playlist / Local / Draft' });
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await expect(page.locator('.notice.notice-error')).toBeVisible();
    await sequence.getByRole('checkbox', { name: label, exact: true }).uncheck();
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Routine saved locally.');
  await automaticReady(page);
  await expect(page.locator('.playing-title')).toHaveText(routine.tracks[0]!.title);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  expect(await starts()).toBe(0);
  await page.getByRole('button', { name: 'Start class', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  expect(await starts()).toBe(0);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  expect(await starts()).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  const final = await savedTracks(page);
  expect(final.routines[0]!.tracks).toEqual(routine.tracks);
  expect(final.routines[0]!.sequence?.walkIn).toBeUndefined(); expect(final.routines[0]!.sequence?.walkOut).toBeUndefined();
  expect(final.media).toEqual(saved.media);
  expect(errors).toEqual([]);
});

test('independent local playlist copied into one routine prepares silently and requires explicit running phase advance', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await demo(page);
  await page.getByRole('tab', { name: 'Playlists', exact: true }).click();
  const setupLibrary = page.locator('#panel-playlists');
  await setupLibrary.getByRole('button', { name: 'New music playlist', exact: true }).click();
  await setupLibrary.getByLabel('Playlist name', { exact: true }).fill('Lobby');
  await setupLibrary.locator('summary[aria-label="Add track"]').click();
  const importButton = setupLibrary.locator('.section-heading .command-menu-items').getByRole('button', { name: 'Import audio', exact: true });
  await expect(importButton).toHaveCount(1);
  await expect(importButton).toBeVisible();
  const choosingFiles = page.waitForEvent('filechooser');
  await importButton.click();
  await (await choosingFiles).setFiles({ name: 'Lobby.wav', mimeType: 'audio/wav', buffer: syntheticWav(8) });
  await setupLibrary.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Playlist saved on this device.');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByRole('region', { name: 'Class sequence', exact: true }).getByRole('checkbox', { name: 'Walk-in music', exact: true }).check();
  await page.getByRole('region', { name: 'Walk-in music', exact: true })
    .getByRole('combobox', { name: 'Music playlist', exact: true }).selectOption({ label: 'Lobby / Local / Draft' });
  await page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true }).fill('Morning');
  await expect(page.getByRole('button', { name: 'Save class setup', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Routine saved locally.');
  expect((await savedTracks(page)).routines[0]!.sequence?.walkIn).toMatchObject({ name: 'Lobby', tracks: [{ title: 'Lobby.wav', cues: [] }] });
  await automaticReady(page);
  await expect(page.locator('.move-note')).toHaveText('Walk-in');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const advance = page.getByRole('button', { name: 'Start Routine', exact: true });
  await expect(advance).toBeDisabled();
  await advance.dispatchEvent('click');
  await expect(page.locator('.move-note')).toHaveText('Walk-in');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await advance.click();
  await expect(page.locator('.playing-title')).toHaveText('Synthetic tonal warm-up');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('inline phase checkboxes configure the class in chronological order and persist distinct playlists', async ({ page }, testInfo) => {
  page.on('dialog', dialog => dialog.accept());
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await demo(page);
  const sequence = page.getByRole('region', { name: 'Class sequence', exact: true });
  await expect(sequence.getByRole('checkbox')).toHaveCount(4);
  expect(await sequence.evaluate(node => node.previousElementSibling?.classList.contains('editor-actions'))).toBe(true);
  for (const checkbox of await sequence.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
  await sequence.getByRole('checkbox', { name: 'Walk-in music', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const arrival = page.getByRole('region', { name: 'Walk-in music', exact: true });
  await arrival.getByRole('button', { name: 'Manage music playlists', exact: true }).click();
  const library = page.locator('#panel-playlists');
  for (const title of ['Arrival playlist', 'Departure playlist']) {
    await library.getByRole('button', { name: 'New music playlist', exact: true }).click();
    await library.getByLabel('Playlist name', { exact: true }).fill(title);
    await library.locator('summary[aria-label="Add track"]').click();
    const importButton = library.locator('.section-heading .command-menu-items').getByRole('button', { name: 'Import audio', exact: true });
    await expect(importButton).toHaveCount(1);
    const choosingFiles = page.waitForEvent('filechooser');
    await importButton.click();
    await (await choosingFiles).setFiles({ name: `${title}.wav`, mimeType: 'audio/wav', buffer: syntheticWav(3) });
    await library.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.notice [role=status]')).toHaveText('Playlist saved on this device.');
    await library.getByRole('button', { name: 'Close playlist', exact: true }).click();
    await expect(library.getByRole('button', { name: 'New music playlist', exact: true })).toBeVisible();
  }
  await library.getByRole('button', { name: 'Return to routine', exact: true }).click();
  await arrival.getByRole('button', { name: 'Refresh playlists', exact: true }).click();
  const arrivalChoice = arrival.getByRole('combobox', { name: 'Music playlist', exact: true });
  await expect(arrivalChoice.locator('option')).toHaveCount(3);
  await arrivalChoice.selectOption({ label: 'Arrival playlist / Local / Draft' });
  for (const label of ['Pre-routine filler', 'Post-routine filler', 'Walk-out music']) {
    await sequence.getByRole('checkbox', { name: label, exact: true }).check();
  }
  const departure = page.getByRole('region', { name: 'Walk-out music', exact: true });
  await departure.getByRole('combobox', { name: 'Music playlist', exact: true }).selectOption({ label: 'Departure playlist / Local / Draft' });
  const before = page.getByRole('region', { name: 'Pre-routine filler', exact: true });
  const after = page.getByRole('region', { name: 'Post-routine filler', exact: true });
  await before.getByRole('combobox', { name: 'Filler sound', exact: true }).selectOption('soft');
  await after.getByRole('combobox', { name: 'Filler sound', exact: true }).selectOption('drums');
  await sequence.getByRole('checkbox', { name: 'Pre-routine filler', exact: true }).uncheck();
  await expect(before).toHaveCount(0);
  await sequence.getByRole('checkbox', { name: 'Pre-routine filler', exact: true }).check();
  await expect(before.getByRole('combobox', { name: 'Filler sound', exact: true })).toHaveValue('soft');
  expect(await page.locator('.class-phase-config, .track-list').evaluateAll(nodes => nodes.map(node =>
    node.getAttribute('data-class-phase') ?? 'routine'))).toEqual(['walkIn', 'before', 'routine', 'after', 'walkOut']);
  await page.getByRole('textbox', { name: 'Routine name', exact: true }).fill('Inline morning class');
  await sequence.getByRole('spinbutton', { name: 'Crossfade (seconds)', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Routine saved locally.');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await sequence.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`class-sequence-${viewport.width}.png`), fullPage: true });
  }
  await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  for (const checkbox of await sequence.getByRole('checkbox').all()) await expect(checkbox).toBeChecked();
  await automaticReady(page);
  await expect(page.getByRole('button', { name: 'Start class', exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('.playing-title')).toHaveText('Arrival playlist.wav');
  await page.getByRole('button', { name: 'Start class', exact: true }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Start Announcements', exact: true }).click();
  await page.getByRole('button', { name: 'Start Routine', exact: true }).click();
  await page.getByRole('button', { name: 'Next track', exact: true }).click();
  await page.getByRole('button', { name: 'Next track', exact: true }).click();
  await page.getByRole('button', { name: 'Start Walk-out', exact: true }).click();
  await expect(page.locator('.playing-title')).toHaveText('Departure playlist.wav');
  await expect(page.locator('.app-shell')).toHaveClass(/class-mode/);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  expect(errors).toEqual([]);
});

test('full class workflow uses saved references, silent practice and real audio phases offline', async ({ page, context }, testInfo) => {
  page.on('dialog', dialog => dialog.accept());
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const contexts: AudioContext[] = [];
    const NativeContext = window.AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super(options); contexts.push(this); } };
    Object.assign(window, { classAudioDiagnostics: () => contexts.map(context => ({ state: context.state, time: context.currentTime, rate: context.sampleRate })) });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/'); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  await page.getByRole('textbox', { name: 'Routine name', exact: true }).fill('Synthetic full class');
  await page.locator('#app > input[type=file][aria-label="Import audio"]').setInputFiles([
    { name: 'Routine A.wav', mimeType: 'audio/wav', buffer: syntheticWav(9) },
    { name: 'Routine B.wav', mimeType: 'audio/wav', buffer: syntheticWav(9) },
  ]);
  const first = page.locator('details[data-track-id]').first();
  await expect(page.locator('details[data-track-id]')).toHaveCount(2);
  await first.locator('.track-preview').getByRole('button', { name: 'Add cue', exact: true }).click();
  await first.locator('textarea:focus').fill('First real-clock cue');
  await first.locator('.cue-row').getByLabel('Value', { exact: true }).fill('0:00.5');
  await first.locator('.cue-row').getByLabel('Value', { exact: true }).press('Tab');
  await first.locator(':scope > summary').click();
  await first.getByRole('button', { name: 'After Routine A.wav', exact: true }).click();
  const gap = page.getByRole('dialog');
  await gap.getByRole('combobox').first().selectOption('custom');
  await gap.getByRole('combobox', { name: 'Filler mode', exact: true }).selectOption('hold');
  await gap.getByRole('combobox', { name: 'Filler sound', exact: true }).selectOption('drums');
  await gap.getByRole('spinbutton', { name: 'Crossfade (seconds)', exact: true }).fill('0');
  await gap.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.draft-status')).not.toContainText('Unsaved');
  await automaticReady(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await page.getByRole('progressbar').getAttribute('aria-valuenow');
  await page.getByRole('button', { name: 'Edit cue times', exact: true }).click();
  await page.getByRole('button', { name: 'Move cue later', exact: true }).click();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.draft-status')).not.toContainText('Unsaved');
  const saved = await savedTracks(page);
  await automaticReady(page);
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', paused!);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  const library = page.locator('#panel-playlists');
  await page.getByRole('tab', { name: 'Playlists', exact: true }).click();
  await expect(library).toBeVisible();
  await library.getByRole('button', { name: 'New music playlist', exact: true }).click();
  await library.getByLabel('Playlist name', { exact: true }).fill('Lobby pair');
  await library.locator('summary[aria-label="Add track"]').click();
  const importButton = library.locator('.section-heading .command-menu-items').getByRole('button', { name: 'Import audio', exact: true });
  await expect(importButton).toHaveCount(1);
  let choosingFiles = page.waitForEvent('filechooser');
  await importButton.click();
  await (await choosingFiles).setFiles([
    { name: 'Lobby A.wav', mimeType: 'audio/wav', buffer: syntheticWav(2) },
    { name: 'Lobby B.wav', mimeType: 'audio/wav', buffer: syntheticWav(2) },
  ]);
  await library.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Playlist saved on this device.');
  await library.getByRole('button', { name: 'Close playlist', exact: true }).click();
  await library.getByRole('button', { name: 'New music playlist', exact: true }).click();
  await library.getByLabel('Playlist name', { exact: true }).fill('Departure pair');
  await library.locator('summary[aria-label="Add track"]').click();
  await expect(importButton).toHaveCount(1);
  choosingFiles = page.waitForEvent('filechooser');
  await importButton.click();
  await (await choosingFiles).setFiles([
    { name: 'Departure A.wav', mimeType: 'audio/wav', buffer: syntheticWav(2) },
    { name: 'Departure B.wav', mimeType: 'audio/wav', buffer: syntheticWav(2) },
  ]);
  await library.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Playlist saved on this device.');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  const sequence = page.getByRole('region', { name: 'Class sequence', exact: true });
  for (const [label, name] of [['Walk-in music', 'Lobby pair'], ['Walk-out music', 'Departure pair']]) {
    await sequence.getByRole('checkbox', { name: label!, exact: true }).check();
    const phase = page.getByRole('region', { name: label!, exact: true });
    const select = phase.getByRole('combobox', { name: 'Music playlist', exact: true });
    await expect(select.locator('option')).toHaveCount(3);
    await select.selectOption({ label: `${name} / Local / Draft` });
  }
  for (const label of ['Pre-routine filler', 'Post-routine filler']) {
    await sequence.getByRole('checkbox', { name: label, exact: true }).check();
    await page.getByRole('region', { name: label, exact: true }).getByRole('combobox', { name: 'Filler sound', exact: true }).selectOption('soft');
  }
  await sequence.getByLabel('Crossfade (seconds)', { exact: true }).fill('0');
  await expect(sequence.getByRole('spinbutton', { name: 'Revision', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Routine saved locally.');
  await sequence.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('class-setup-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await sequence.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath('class-setup-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await savedTracks(page)).routines[0]!.tracks).toEqual(saved.routines[0]!.tracks);
  expect((await savedTracks(page)).routines[0]!.sequence).toMatchObject({ walkIn: { name: 'Lobby pair' }, walkOut: { name: 'Departure pair' },
    before: { mode: 'hold' }, after: { mode: 'hold' } });
  await automaticReady(page);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); await context.setOffline(true); await page.reload();
  await automaticReady(page);
  await expect(page.locator('.playing-title')).toHaveText('Lobby A.wav');
  await page.getByRole('button', { name: 'Start class', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  const requests: string[] = []; page.on('request', request => requests.push(request.url()));
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  try { await expect(page.locator('.playing-title')).toHaveText('Lobby B.wav'); }
  catch (error) {
    console.log('Class clock diagnostic', await page.evaluate(async () => {
      const request = indexedDB.open('fitness-rehearsal');
      const playlists = await new Promise<unknown[]>((resolve, reject) => {
        request.onsuccess = () => {
          const database = request.result; const transaction = database.transaction('musicPlaylists');
          const records = transaction.objectStore('musicPlaylists').getAll();
          transaction.oncomplete = () => { database.close(); resolve(records.result); }; transaction.onerror = () => reject(transaction.error);
        };
      });
      return { contexts: (window as unknown as { classAudioDiagnostics(): unknown }).classAudioDiagnostics(), playlists,
        elapsed: document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') };
    }), errors);
    throw error;
  }
  await expect(page.locator('.playing-title')).toHaveText('Lobby A.wav');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const advance = page.getByRole('button', { name: 'Start Announcements', exact: true });
  await expect(advance).toBeDisabled(); await advance.dispatchEvent('click');
  await expect(page.locator('.move-note')).toHaveText('Walk-in');
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); await advance.click();
  await expect(page.locator('.move-note')).toHaveText('Announcements');
  await expect(page.locator('.cue-handles')).toBeHidden();
  await page.getByRole('button', { name: 'Start Routine', exact: true }).click();
  await expect(page.locator('.playing-title')).toHaveText('Routine A.wav');
  await expect(page.locator('.move-note')).toHaveText('First real-clock cue');
  await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible({ timeout: 14000 });
  await expect(page.locator('.app-shell')).toHaveClass(/class-mode/);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.playing-title')).toHaveText('Routine B.wav', { timeout: 14000 });
  await expect(page.locator('.move-note')).toHaveText('Announcements', { timeout: 14000 });
  await page.getByRole('button', { name: 'Start Walk-out', exact: true }).click();
  await expect(page.locator('.playing-title')).toHaveText('Departure A.wav');
  await expect(page.locator('.playing-title')).toHaveText('Departure B.wav');
  await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeVisible();
  await expect(page.locator('.app-shell')).toHaveClass(/class-mode/);
  expect(requests).toEqual([]); expect(errors).toEqual([]);
  await page.getByRole('button', { name: 'Exit class mode', exact: true }).click();
  await expect(page.locator('.app-footer')).toContainText('App ');
  await page.screenshot({ path: testInfo.outputPath('class-finished-mobile.png') });
});

test('custom filler summary follows its track while collapsed, reordered and reloaded', async ({ page }, testInfo) => {
  await demo(page);
  const first = page.locator('details[data-track-id]').first();
  const id = await first.getAttribute('data-track-id');
  const title = await first.locator('.track-title').textContent();
  await first.locator(':scope > summary').click();
  await first.getByRole('button', { name: `After ${title}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'After-track rule', exact: true }).selectOption('custom');
  await dialog.getByRole('combobox', { name: 'Filler mode', exact: true }).selectOption('hold');
  await dialog.getByRole('combobox', { name: 'Filler sound', exact: true }).selectOption('drums');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  const indicator = page.locator(`[data-after-track-id="${id}"]`);
  await expect(first).not.toHaveAttribute('open');
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveClass(/active/);
  await expect(indicator).toContainText(`Custom filler after ${title}`);
  await expect(indicator).toContainText('Synthetic drums / Until Continue');
  await expect(page.locator(`details[data-track-id="${id}"] + .after-track-status`)).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await indicator.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('custom-filler-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await indicator.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('custom-filler-mobile.png') });
  await first.getByRole('button', { name: `Reorder ${title}`, exact: true }).press('ArrowDown');
  await expect(indicator).toContainText('inactive on the last track');
  await expect(indicator).not.toHaveClass(/active/);
  await page.locator(`details[data-track-id="${id}"]`).getByRole('button', { name: `Reorder ${title}`, exact: true }).press('ArrowUp');
  await expect(indicator).toHaveClass(/active/);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(indicator).toContainText('Synthetic drums / Until Continue');
  await page.locator(`details[data-track-id="${id}"]`).getByRole('button', { name: `After ${title}`, exact: true }).click();
  await dialog.getByRole('combobox', { name: 'After-track rule', exact: true }).selectOption('inherit');
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(indicator).toBeHidden();
});

test('Settings disables demo loading persistently without deleting existing routines', async ({ page }) => {
  await demo(page);
  const saved = await savedTracks(page);
  const loadDemo = page.getByRole('button', { name: 'Load demo', exact: true, includeHidden: true });
  await expect(loadDemo).toBeHidden();
  await page.getByRole('button', { name: 'Close routine', exact: true }).click();
  await page.getByRole('dialog', { name: 'Close routine', exact: true }).getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New routine', exact: true })).toBeVisible();
  await expect(loadDemo).toBeVisible();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const disableDemos = page.getByRole('checkbox', { name: 'Disable demos', exact: true });
  await expect(disableDemos).not.toBeChecked();
  await disableDemos.check();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(loadDemo).toBeHidden();
  await expect(loadDemo).toBeDisabled();
  await loadDemo.dispatchEvent('click');
  expect((await savedTracks(page)).routines).toEqual(saved.routines);
  await page.reload();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(disableDemos).toBeChecked();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(loadDemo).toBeHidden();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await disableDemos.uncheck();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(loadDemo).toBeVisible();
  await expect(loadDemo).toBeEnabled();
  expect((await savedTracks(page)).routines).toEqual(saved.routines);
});

test('readiness, undo and recovered drafts preserve the saved routine and prepared class', async ({ page }, testInfo) => {
  page.on('dialog', dialog => dialog.accept());
  await demo(page);
  const original = (await savedTracks(page)).routines[0]!;
  const name = page.getByRole('textbox', { name: 'Routine name', exact: true });
  await name.fill('Recover my routine'); await name.press('Tab');
  await page.locator('.draft-protection').first().getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(name).toHaveValue(original.name);
  await page.locator('.draft-protection').first().getByRole('button', { name: 'Redo edit', exact: true }).click();
  await expect(name).toHaveValue('Recover my routine');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#panel-edit .draft-status')).not.toContainText('Unsaved');
  const saved = (await savedTracks(page)).routines[0]!;
  await page.locator('.draft-protection').first().getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(name).toHaveValue(original.name);
  expect((await savedTracks(page)).routines[0]!.revision).toBe(saved.revision);
  await name.fill('Unsaved recovered routine'); await name.press('Tab');
  await expect(page.locator('.draft-protection').first()).toContainText('Recovery up to date');
  await page.reload();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  const recovery = page.locator('#panel-edit .recovery-library');
  await recovery.locator(':scope > summary').click();
  const row = recovery.locator('.routine-library-row').filter({ hasText: 'Unsaved recovered routine' });
  await row.getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  await expect(name).toHaveValue('Unsaved recovered routine (recovered)');
  expect((await savedTracks(page)).routines[0]).toEqual(saved);
  await automaticReady(page);
  await expect(page.getByRole('button', { name: 'Start class', exact: true })).toBeEnabled({ timeout: 30000 });
  const readiness = page.getByRole('region', { name: 'Class readiness', exact: true });
  await expect(readiness).toContainText('Audio verified on this device');
  await readiness.getByRole('button', { name: 'Test sound', exact: true }).click();
  await readiness.getByRole('button', { name: 'Stop sound test', exact: true }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(readiness.getByRole('button', { name: 'Test sound', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await readiness.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('readiness-mobile.png') });
  await page.getByRole('button', { name: 'Start class', exact: true }).click();
  await expect(readiness).toBeHidden();
});

test('desktop practice keeps typed cue times during playback and saves repeated edits', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  await automaticReady(page);
  await page.getByRole('button', { name: 'Edit cue times', exact: true }).click();
  const cueTime = page.getByRole('textbox', { name: 'Cue time (m:ss.s)', exact: true });
  const choice = page.getByRole('combobox', { name: 'Selected cue', exact: true });
  const cueId = await choice.inputValue();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(async () => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(0);
  await cueTime.fill('0:02.5');
  await cueTime.press('Tab');
  await expect(cueTime).toHaveValue('0:02.5');
  await page.getByRole('button', { name: 'Move cue later', exact: true }).click();
  await expect(cueTime).toHaveValue('0:02.6');
  await cueTime.fill('0:03.2');
  await cueTime.press('Tab');
  await expect(cueTime).toHaveValue('0:03.2');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('.practice-tools').getByRole('button', { name: 'Save', exact: true }).click();
  const saved = await savedTracks(page);
  expect(saved.routines[0]!.tracks[0]!.cues.find(cue => cue.id === cueId)?.anchor).toEqual({ kind: 'timestamp', seconds: 3.2 });
});

test('Stop and Previous retain the current track in Practice and Class Mode', async ({ page }) => {
  await demo(page);
  await automaticReady(page);
  for (const classMode of [false, true]) {
    if (classMode) await page.getByRole('button', { name: 'Start class', exact: true }).click();
    await page.getByRole('button', { name: 'Next track', exact: true }).click();
    await expect(page.locator('.playing-title')).toHaveText('Synthetic drum practice');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('.playing-title')).toHaveText('Synthetic drum practice');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(async () => Number(await page.getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Previous track', exact: true }).click();
    await expect(page.locator('.playing-title')).toHaveText('Synthetic drum practice');
    await page.getByRole('button', { name: 'Previous track', exact: true }).click();
    await expect(page.locator('.playing-title')).toHaveText('Synthetic tonal warm-up');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
  }
});

test('playlist and class authoring recover independent copies with undo after save', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await demo(page);
  await page.getByRole('tab', { name: 'Playlists', exact: true }).click();
  const library = page.locator('#panel-playlists');
  await library.getByRole('button', { name: 'New music playlist', exact: true }).click();
  const playlistName = library.getByLabel('Playlist name', { exact: true });
  await playlistName.fill('Arrival'); await playlistName.press('Tab');
  await library.getByRole('button', { name: 'Save', exact: true }).click();
  await library.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(playlistName).toHaveValue('New music playlist');
  await library.getByRole('button', { name: 'Redo edit', exact: true }).click();
  await expect(playlistName).toHaveValue('Arrival');
  await playlistName.fill('Arrival recovered'); await playlistName.press('Tab');
  await expect(library.locator('.draft-protection')).toContainText('Recovery up to date');
  await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  const recovery = page.locator('#panel-edit .recovery-library');
  await recovery.locator(':scope > summary').click();
  await recovery.locator('.routine-library-row').filter({ hasText: 'Arrival recovered' })
    .getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  await expect(playlistName).toHaveValue('Arrival recovered (recovered)');
  await library.getByRole('button', { name: 'Save', exact: true }).click();
  await page.evaluate(async () => new Promise<void>((accept, reject) => {
    const request = indexedDB.open('fitness-rehearsal'); request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result; const transaction = database.transaction(['routines', 'routineWorkingCopies', 'draftRecovery', 'classSetups'], 'readwrite');
      const copies = transaction.objectStore('routineWorkingCopies').getAll();
      copies.onsuccess = () => {
        const routine = (copies.result[0] as RoutineWorkingCopy).envelope.routine;
        transaction.objectStore('routines').put(routine, routine.id);
        const setup: ClassSetup = { schemaVersion: 1, id: 'legacy-recovery', name: 'Morning', revision: 1, locked: false, published: false,
          routine: { id: routine.id, revision: routine.revision, published: false }, crossfade: 0 };
        transaction.objectStore('classSetups').put(setup, setup.id);
        transaction.objectStore('draftRecovery').put({ id: 'legacy-recovery', kind: 'class', source: 'local', value: setup,
          baseRevision: 1, media: {}, updatedAt: Date.now() }, 'legacy-recovery');
      };
      transaction.oncomplete = () => { database.close(); accept(); };
      transaction.onabort = () => { database.close(); reject(transaction.error); };
    };
  }));
  await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await recovery.locator(':scope > summary').click();
  await recovery.locator('.routine-library-row').filter({ hasText: 'Morning' }).getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  const setupName = page.locator('#panel-edit .routine-name-field').getByRole('textbox', { name: 'Routine name', exact: true });
  await expect(setupName).toHaveValue('Morning (recovered)');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await setupName.fill('Morning recovered'); await setupName.press('Tab');
  await expect(page.locator('#panel-edit .draft-protection')).toContainText('Recovery up to date');
  await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await recovery.locator(':scope > summary').click();
  await recovery.locator('.routine-library-row').filter({ hasText: 'Morning recovered' })
    .getByRole('button', { name: 'Restore as new draft', exact: true }).click();
  await expect(setupName).toHaveValue('Morning recovered (recovered)');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.draft-status')).not.toContainText('Unsaved');
  expect((await savedTracks(page)).routines.filter(routine => routine.name.startsWith('Morning'))).toHaveLength(2);
});

test('practice seeks and drags cue timing without changing class mode', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await demo(page);
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await automaticReady(page);
  const seek = page.getByRole('slider', { name: 'Seek current song', exact: true });
  const box = await seek.boundingBox();
  const duration = Number(await seek.getAttribute('aria-valuemax'));
  await seek.click({ position: { x: box!.width / 4, y: box!.height / 2 } });
  await expect.poll(async () => Math.abs(Number(await seek.getAttribute('aria-valuenow')) - duration / 4))
    .toBeLessThanOrEqual(duration / box!.width);
  const sought = await seek.getAttribute('aria-valuenow');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(Math.floor(Number(sought))));
  await page.getByRole('button', { name: 'Edit cue times', exact: true }).click();
  await expect(seek).toHaveAttribute('aria-disabled', 'true');
  const handle = page.locator('.cue-handle').nth(2);
  const id = await handle.getAttribute('data-cue-id');
  const start = await handle.boundingBox();
  await page.mouse.move(start!.x + start!.width / 2, start!.y + start!.height / 2);
  await page.mouse.down();
  await page.mouse.move(start!.x + start!.width / 2 + box!.width / 8, start!.y + start!.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(`.cue-handle[data-cue-id="${id}"]`)).toHaveAttribute('aria-label', /15 seconds/);
  await expect(seek).toHaveAttribute('aria-valuenow', sought!);
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(Math.floor(Number(sought))));
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  const moved = page.locator(`.cue-row[data-cue-id="${id}"]`);
  await expect(moved.getByLabel('Value', { exact: true })).toHaveValue('0:15.0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await page.getByRole('button', { name: 'Start class', exact: true }).click();
  await expect(seek).toBeHidden();
  await expect(page.locator('.cue-handles')).toBeHidden();
  await expect(page.locator('.next-cue-time')).toContainText('Next move in');
  await page.getByRole('button', { name: 'Exit class mode', exact: true }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('real drum BPM analysis and recorded filler work from the editor', async ({ page, context }) => {
  await demo(page);
  const drum = page.locator('details[data-track-id]').nth(1);
  await drum.locator(':scope > summary').click();
  await drum.locator('.analysis-details > summary').click();
  await drum.getByRole('button', { name: 'Detect BPM', exact: true }).click();
  await expect(drum.locator('.bpm-detection')).toContainText('Estimated BPM: 120', { timeout: 30000 });
  await drum.getByRole('button', { name: 'Apply BPM and first beat', exact: true }).click();
  await expect(drum.getByRole('spinbutton', { name: 'BPM', exact: true })).toHaveValue('120');
  expect(Number(await drum.getByLabel('First beat (seconds)', { exact: true }).inputValue())).toBeLessThan(0.1);
  await page.getByRole('combobox', { name: 'Filler sound', exact: true }).selectOption('lofi');
  await expect(page.getByRole('spinbutton', { name: 'Filler BPM', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Preview filler', exact: true }).click();
  await expect(page.locator('.filler-preview')).toContainText('Playing');
  await page.getByRole('button', { name: 'Stop filler preview', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.getByRole('button', { name: 'Preview filler', exact: true }).click();
  await expect(page.locator('.filler-preview')).toContainText('Playing');
  await page.getByRole('button', { name: 'Stop filler preview', exact: true }).click();
});

test('UserFiller imports, previews, loops, archives without stopping class, and survives offline v3 migration', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe = { starts: 0, stops: 0 };
    Object.assign(window, { fillerProbe: probe });
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.loop && this.buffer?.duration === 1) probe.starts++;
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function (...args) {
      if (this.loop && this.buffer?.duration === 1) probe.stops++;
      return stop.apply(this, args);
    };
  });
  const probe = () => page.evaluate(() => (window as unknown as { fillerProbe: { starts: number; stops: number } }).fillerProbe);
  const sampleRate = 22050;
  const wav = Buffer.alloc(44 + sampleRate * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(sampleRate * 2, 40);
  for (let frame = 0; frame < sampleRate; frame++) wav.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 220 * frame / sampleRate)), 44 + frame * 2);
  await demo(page);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  const library = page.getByRole('region', { name: 'Filler library', exact: true });
  await expect(library.locator('.filler-builtins li')).toHaveText([
    'Lo-fi instrumental (CC0): 120 BPM', 'Synthetic soft: 100 BPM', 'Synthetic bright: 100 BPM', 'Synthetic drums: 100 BPM',
  ]);
  await library.getByLabel('Recording audio file', { exact: true }).setInputFiles({ name: 'UserFiller.wav', mimeType: 'audio/wav', buffer: wav });
  await library.getByRole('button', { name: 'Add recording', exact: true }).click();
  await expect(library.locator('.filler-library-feedback')).toHaveText('Recording added on this device.');
  const recordings = library.getByRole('combobox', { name: 'Custom recordings', exact: true });
  await expect(recordings.locator('option:checked')).toHaveText('UserFiller (1 s)');
  await expect(library.locator('.filler-recording-details')).toContainText('0:01');
  await library.getByRole('button', { name: 'Preview filler', exact: true }).click();
  await expect.poll(async () => (await probe()).starts).toBe(1);
  await library.getByRole('button', { name: 'Stop filler preview', exact: true }).click();
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `test-results/filler-settings-${viewport.width}.png`, fullPage: true });
  }
  await page.reload();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  const sound = page.getByRole('combobox', { name: 'Filler sound', exact: true });
  await expect(sound.locator('option').filter({ hasText: /^UserFiller \(1 s\)$/ })).toHaveCount(1);
  await sound.selectOption({ label: 'UserFiller (1 s)' });
  await setSlider(page.getByRole('slider', { name: 'Filler level', exact: true }), Number('0.5') * 100);
  await page.getByRole('combobox', { name: 'Filler mode', exact: true }).selectOption('timed');
  await page.getByRole('spinbutton', { name: 'Filler duration (seconds)', exact: true }).fill('2');
  await page.getByRole('group', { name: 'Between tracks', exact: true }).getByRole('spinbutton', { name: 'Crossfade (seconds)', exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role="status"]')).toHaveText('Routine saved locally.');
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await automaticReady(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Hold', exact: true }).click();
  await page.getByRole('slider', { name: 'Seek current song', exact: true }).press('End');
  await expect(page.locator('.playing-title')).toHaveText('Filler');
  await expect.poll(async () => (await probe()).starts).toBeGreaterThan(0);
  const playing = await probe();
  const clock = await page.locator('.class-clock').textContent();
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(library.getByRole('button', { name: 'Refresh filler library', exact: true })).toBeEnabled();
  await recordings.selectOption({ label: 'UserFiller (1 s)' });
  page.once('dialog', async dialog => { expect(dialog.message()).toContain('UserFiller'); await dialog.dismiss(); });
  await library.getByRole('button', { name: 'Remove recording', exact: true }).click();
  await expect(recordings.locator('option:checked')).toHaveText('UserFiller (1 s)');
  page.once('dialog', dialog => dialog.accept());
  await library.getByRole('button', { name: 'Remove recording', exact: true }).click();
  await expect(recordings.locator('option')).toHaveCount(1);
  await expect(library.locator('.filler-builtins li')).toHaveCount(4);
  expect(await probe()).toEqual(playing);
  await expect(page.locator('.class-clock')).not.toHaveText(clock!);
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(sound.locator('option:checked')).toHaveText('UserFiller (1 s)');
  await expect(page.getByRole('slider', { name: 'Filler level', exact: true })).toHaveValue('50');
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.locator('.playing-title')).toHaveText('Synthetic drum practice');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.route('**/migration-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Generated migration fixture</title>' }));
  await page.goto('/migration-fixture');
  await page.evaluate(async () => {
    const requestValue = <Value>(request: IDBRequest<Value>) => new Promise<Value>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const database = await requestValue(indexedDB.open('fitness-rehearsal'));
    const working = await requestValue(database.transaction('routineWorkingCopies').objectStore('routineWorkingCopies').getAll()) as RoutineWorkingCopy[];
    const names = ['tracks', 'routines', 'meta', 'cloudRoutines'];
    const entries = await Promise.all(names.map(async name => {
      const store = database.transaction(name).objectStore(name);
      const [keys, values] = await Promise.all([requestValue(store.getAllKeys()), requestValue(store.getAll())]);
      return { name, keys, values };
    }));
    const routines = entries.find(entry => entry.name === 'routines')!;
    for (const copy of working) {
      const routine = { ...copy.envelope.routine, schemaVersion: 1 as const };
      delete routine.sequence;
      const index = routines.keys.indexOf(routine.id);
      if (index < 0) { routines.keys.push(routine.id); routines.values.push(routine); }
      else routines.values[index] = routine;
    }
    database.close();
    await requestValue(indexedDB.deleteDatabase('fitness-rehearsal'));
    const legacy = indexedDB.open('fitness-rehearsal', 3);
    legacy.onupgradeneeded = () => { for (const name of names) legacy.result.createObjectStore(name); };
    const old = await requestValue(legacy);
    await new Promise<void>((resolve, reject) => {
      const transaction = old.transaction(names, 'readwrite');
      for (const entry of entries) entry.values.forEach((value, index) => transaction.objectStore(entry.name).put(value, entry.keys[index]!));
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
    old.close();
  });
  await page.goto('/');
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  await automaticReady(page);
  expect(await page.evaluate(async () => (await indexedDB.databases()).find(database => database.name === 'fitness-rehearsal')?.version)).toBe(8);
  await context.setOffline(true);
  await page.reload();
  const failures: string[] = [];
  page.on('requestfailed', request => failures.push(request.url()));
  await page.evaluate(() => {
    const requests: string[] = [];
    Object.assign(window, { offlineFetches: requests });
    const fetcher = window.fetch;
    window.fetch = (...args) => { requests.push(String(args[0])); return fetcher(...args); };
  });
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(sound.locator('option:checked')).toHaveText('UserFiller (1 s)');
  await page.getByRole('button', { name: 'Preview filler', exact: true }).click();
  await expect(page.locator('.notice [role="status"]')).toHaveText('Recording ready. Tap Preview filler to play.');
  expect((await probe()).starts).toBe(0);
  await page.getByRole('button', { name: 'Preview filler', exact: true }).click();
  await expect.poll(async () => (await probe()).starts).toBe(1);
  await page.getByRole('tab', { name: 'Teach', exact: true }).click();
  await automaticReady(page);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('slider', { name: 'Seek current song', exact: true }).press('End');
  await expect(page.locator('.playing-title')).toHaveText('Filler');
  await expect(page.locator('.playing-title')).toHaveText('Synthetic drum practice');
  expect(failures).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as { offlineFetches: string[] }).offlineFetches)).toEqual([]);
  expect(errors).toEqual([]);
});

test('downloads selected Excel columns and an offline PDF workout packet', async ({ page, context }, testInfo) => {
  await demo(page);
  const note = '=SUM(1,2) - Pli\u00e9';
  await page.getByRole('textbox', { name: 'Move / note', exact: true }).first().fill(note);
  await page.locator('.analysis-details > summary').first().click();
  await setSlider(page.getByRole('slider', { name: 'Track level', exact: true }).first(), Number('1.25') * 100);
  await setSlider(page.getByRole('slider', { name: 'Filler level', exact: true }), Number('0.65') * 100);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.export-section')).not.toHaveAttribute('open', '');
  await page.locator('.export-section > summary').click();
  await page.getByRole('button', { name: 'Export Excel cue sheet', exact: true }).click();
  await page.getByRole('button', { name: 'Clear all columns', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: 'Move / note', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Track level', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Filler level', exact: true }).check();
  const columnCount = await page.getByRole('dialog').getByRole('checkbox').count();
  await expect(page.locator('.export-dialog[open] .export-column-count')).toHaveText(`3 of ${columnCount} columns selected`);
  await page.getByRole('textbox', { name: 'Filename', exact: true }).fill('../selected.xlsx.xlsx');
  const excelDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const excel = await excelDownload;
  expect(excel.suggestedFilename()).toBe('selected.xlsx');
  await expect(page.getByRole('button', { name: 'Export Excel cue sheet', exact: true })).toBeFocused();
  const excelPath = testInfo.outputPath('selected-cues.xlsx');
  await excel.saveAs(excelPath);
  const contents = unzipSync(await readFile(excelPath));
  const sheet = new TextDecoder().decode(contents['xl/worksheets/sheet1.xml']);
  const strings = new TextDecoder().decode(contents['xl/sharedStrings.xml'] ?? new Uint8Array());
  const values = await page.evaluate(({ sheet, strings }) => {
    const xml = new DOMParser().parseFromString(sheet, 'application/xml');
    const shared = new DOMParser().parseFromString(strings || '<sst/>', 'application/xml');
    return { formulas: xml.getElementsByTagName('f').length,
      rows: Array.from(xml.getElementsByTagName('row')).map(row => row.getElementsByTagName('c').length),
      filter: xml.getElementsByTagName('autoFilter')[0]?.getAttribute('ref'),
      numeric: Array.from(xml.getElementsByTagName('row')).slice(1).map(row => Array.from(row.getElementsByTagName('c'))
        .filter(cell => cell.getAttribute('t') !== 's' && cell.getAttribute('t') !== 'inlineStr').map(cell => Number(cell.textContent))),
      text: (xml.documentElement.textContent ?? '') + (shared.documentElement.textContent ?? '') };
  }, { sheet, strings });
  expect(values.formulas).toBe(0);
  expect(values.rows.every(count => count === 3)).toBe(true);
  expect(values.filter).toMatch(/^A1:C\d+$/);
  expect(values.numeric[0]).toEqual([1.25, 0.65]);
  expect(values.text).toContain(note);
  expect(values.text).not.toContain('Synthetic drum practice');
  expect(new TextDecoder().decode(contents['xl/worksheets/sheet2.xml'])).not.toContain('Synthetic drum practice');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await context.setOffline(true);
  await page.reload();
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await page.locator('.export-section > summary').click();
  await page.getByRole('button', { name: 'Export PDF packet', exact: true }).click();
  await page.getByRole('button', { name: 'Clear all columns', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Move / note', exact: true }).check();
  await page.getByRole('textbox', { name: 'Filename', exact: true }).fill('selected-notes.pdf');
  const pdfDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const pdf = await pdfDownload;
  const pdfPath = testInfo.outputPath('workout.pdf');
  await pdf.saveAs(pdfPath);
  const bytes = await readFile(pdfPath);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(10000);
  expect(bytes.toString('latin1')).toContain('/FontFile2');
  expect(pdf.suggestedFilename()).toBe('selected-notes.pdf');
  const text = pdfText(bytes);
  expect(text).toContain(note); expect(text).not.toContain('Synthetic drum practice');
  expect(text).not.toContain('Two-song practice'); expect(text).not.toContain('Filler level');
  await page.getByRole('button', { name: 'Export PDF packet', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('checkbox', { checked: true })).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Filename', exact: true }).fill('selected-notes.pdf');
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    const dialog = page.getByRole('dialog');
    expect(await dialog.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight
        && node.scrollWidth <= node.clientWidth + 1;
    })).toBe(true);
    await dialog.evaluate(node => node.scrollTo(0, 0));
    await expect(page.getByRole('textbox', { name: 'Filename', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`export-form-${viewport.width}-top.png`) });
    await page.getByRole('checkbox', { name: 'Move / note', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('checkbox', { name: 'Move / note', exact: true })).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath(`export-form-${viewport.width}-selection.png`) });
    await dialog.evaluate(node => node.scrollTo(0, node.scrollHeight));
    await expect(page.getByRole('button', { name: 'Download', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`export-form-${viewport.width}-bottom.png`) });
  }
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export PDF packet', exact: true })).toBeFocused();
});

test('editor acceptance workflow preserves 1:05.5, analyzed levels and bounded tinted track groups', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('Fitness Music Player');
  await expect(page.locator('.brand-name')).toHaveText('Fitness Music Player');
  await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await expect(page.locator('details[data-track-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Routine name', exact: true })).toHaveValue('My fitness routine');
  const wav = syntheticWav(70);
  await page.locator('#app > input[type=file][aria-label="Import audio"]').setInputFiles({ name: 'Synthetic seventy seconds.wav', mimeType: 'audio/wav', buffer: wav });
  const song = page.locator('details[data-track-id]').first();
  await expect(song).toBeVisible();
  if (!await song.evaluate(node => (node as HTMLDetailsElement).open)) await song.locator(':scope > summary').click();
  await song.locator('.track-preview').getByRole('button', { name: 'Add cue', exact: true }).click();
  const row = song.locator('.cue-row').first();
  await row.getByRole('textbox', { name: 'Move / note', exact: true }).fill('Selected final stretch');
  await row.getByLabel('Value', { exact: true }).fill('1:05.5');
  await row.getByLabel('Value', { exact: true }).press('Tab');
  await row.getByRole('combobox', { name: 'Source', exact: true }).selectOption('interval');
  await expect(row.getByLabel('Value', { exact: true })).toHaveValue('1:05.5');
  await song.getByRole('spinbutton', { name: 'BPM', exact: true }).fill('120');
  await row.getByRole('combobox', { name: 'Source', exact: true }).selectOption('count');
  await row.getByRole('combobox', { name: 'Source', exact: true }).selectOption('timestamp');
  await expect(row.getByLabel('Value', { exact: true })).toHaveValue('1:05.5');
  await song.getByRole('button', { name: 'Play preview', exact: true }).click();
  const cursor = song.getByRole('slider', { name: 'Seek preview', exact: true });
  await expect.poll(async () => Number(await cursor.inputValue())).toBeGreaterThan(0.1);
  await song.locator('.track-preview').getByRole('button', { name: 'Add cue', exact: true }).click();
  await expect(page.locator('textarea:focus')).toHaveValue('New move');
  await page.locator('textarea:focus').fill('Fresh playhead');
  await expect(song.locator('.preview-cue-marker')).toHaveCount(2);
  page.once('dialog', dialog => dialog.dismiss());
  await song.getByRole('button', { name: 'Delete cue', exact: true }).first().click();
  await expect(song.locator('.cue-row')).toHaveCount(2);
  await song.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await song.locator('.analysis-details > summary').click();
  await song.getByRole('button', { name: 'Analyze loudness', exact: true }).click();
  const apply = song.getByRole('button', { name: 'Apply recommended level', exact: true });
  await expect(apply).toBeEnabled({ timeout: 30000 });
  await expect(song.locator('.loudness-analysis')).toContainText('LUFS');
  await apply.click();
  const gain = await song.getByRole('slider', { name: 'Track level', exact: true }).inputValue();
  expect(Number(gain)).toBeGreaterThan(0); expect(Number(gain)).toBeLessThanOrEqual(125);
  await setSlider(page.getByRole('slider', { name: 'Filler level', exact: true }), Number('0.65') * 100);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.notice [role=status]')).toHaveText('Routine saved locally.');
  await page.reload(); await page.getByRole('tab', { name: 'Routines', exact: true }).click();
  await song.locator('.analysis-details > summary').click();
  await expect(song.getByRole('slider', { name: 'Track level', exact: true })).toHaveValue(gain);
  await expect(page.getByRole('slider', { name: 'Filler level', exact: true })).toHaveValue('65');
  expect(await song.getByLabel('Value', { exact: true }).evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement).value))).toContain('1:05.5');
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`editor-workflow-${viewport.width}.png`), fullPage: true });
  }
  const contrast = await song.locator(':scope > summary').evaluate(node => {
    const style = getComputedStyle(node);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    const luminance = (color: string) => {
      context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
        .map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    const foreground = luminance(style.color), background = luminance(style.backgroundColor);
    return { ratio: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      tinted: style.backgroundColor !== getComputedStyle(document.body).backgroundColor,
      border: getComputedStyle(node.parentElement!).borderInlineStartWidth };
  });
  expect(contrast.ratio).toBeGreaterThanOrEqual(4.5); expect(contrast.tinted).toBe(true); expect(contrast.border).toBe('3px');
  expect(errors).toEqual([]);
});