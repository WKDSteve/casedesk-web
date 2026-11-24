// What a page needs beyond its features, in Chrome from disk: targets a pointer hits, names a translator leaves alone,
// numbers in the language of the page, long words that break, a side bar that says it is empty, a splitter that moves
// with the keys, forms that say what is wrong at the field, dialogs that ask before they drop what was typed, and a
// click that starts one reading, not two.

import { type Page, expect, test } from '@playwright/test';
// @ts-expect-error a plain JavaScript module of this repository
import { fixtures } from '../build/bundle.mjs';
import { fakeCase, pageUrl, spyOnIndexedDb, watchPage } from './page';

const fx: Record<string, string> = fixtures();
const LONG = `${'x'.repeat(120)}.log`;

const TREE = {
  '.case.json': JSON.stringify({ case: '4711-TEST', title: 'An invented case' }),
  'assets/browserstack-device.log': fx['browserstack-device.log'],
  'assets/merge-fileservice.log': fx['merge-fileservice.log'],
  'assets/merge-gateway.log': fx['merge-gateway.log'],
  [`assets/${LONG}`]: fx['browserstack-device.log'],
};

async function start(page: Page): Promise<void> {
  await spyOnIndexedDb(page);
  await fakeCase(page, { name: '4711-folder', tree: TREE });
  await watchPage(page, 'casedesk.html');
  await page.goto(pageUrl('casedesk.html'));
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await page.locator('#pick').click();
  await expect(page.locator('#logs')).toBeVisible();
}

async function openFirst(page: Page): Promise<void> {
  await page.locator('#logs').getByRole('button', { name: 'browserstack-device.log', exact: true }).click();
  await expect(page.locator('.loghead')).toBeVisible();
}

/** The controls that are smaller than 24 px in either direction (a checkbox counts with the label around it). */
const small = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    const shown = (el: Element) => (el as HTMLElement).offsetParent !== null || el.closest('dialog[open]') !== null;
    for (const el of document.querySelectorAll('button, summary, select, textarea, input, a[href], [role=separator][tabindex]')) {
      if (!shown(el) || (el as HTMLInputElement).type === 'hidden') continue;
      if (el instanceof HTMLAnchorElement && (el.parentElement?.textContent?.trim().length ?? 0) > (el.textContent?.trim().length ?? 0)) continue; // inside a sentence
      const box = ((el as HTMLInputElement).type === 'checkbox' ? el.closest('label') ?? el : el).getBoundingClientRect();
      if (box.width < 23.5 || box.height < 23.5) out.push(`${el.outerHTML.slice(0, 80)} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    return out;
  });

test('every control is a target of at least 24 px: start, picker, reading copy with its side bar, menus, dialogs', async ({ page }) => {
  await spyOnIndexedDb(page);
  await fakeCase(page, { name: '4711-folder', tree: TREE });
  await page.goto(pageUrl('casedesk.html'));
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  expect(await small(page), 'start').toEqual([]);
  await page.locator('#pick').click();
  await expect(page.locator('#logs')).toBeVisible();
  expect(await small(page), 'picker').toEqual([]);
  await openFirst(page);
  expect(await small(page), 'reading copy').toEqual([]);
  await page.locator('#menubutton-view').click();
  expect(await small(page), 'menu').toEqual([]);
  await page.keyboard.press('Escape');
  await page.locator('#menubutton-filter').click();
  await page.getByRole('menuitem', { name: /Filter hinzufügen/ }).click();
  expect(await small(page), 'dialog').toEqual([]);
});

test('the splitter has a gutter of 24 px, and the arrow keys move it', async ({ page }) => {
  await start(page);
  await openFirst(page);
  const bar = page.locator('#splitter');
  expect((await bar.boundingBox())!.width).toBeGreaterThanOrEqual(24);
  await bar.focus();
  const before = Number(await bar.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowLeft');
  expect(Number(await bar.getAttribute('aria-valuenow'))).toBe(before + 20);
  expect((await page.locator('#sidebar').boundingBox())!.width).toBe(before + 20);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  expect(Number(await bar.getAttribute('aria-valuenow'))).toBe(before - 20);
  await page.keyboard.press('Home');
  expect(await bar.getAttribute('aria-valuenow')).toBe(await bar.getAttribute('aria-valuemin'));
  // a key that moves the bar does not also move the cursor of the reading copy
  expect(await page.evaluate(() => localStorage.getItem('casedesk-web.view'))).toContain('"sidebarWidth":200');
});

test('names, paths and keys are left to the translator, the page says it is German, a field takes no spell check', async ({ page }) => {
  await start(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.locator('#where')).toHaveAttribute('translate', 'no');
  await expect(page.locator('h1')).toContainText('Fall 4711-TEST');
  await expect(page.locator('h1 [translate=no]')).toHaveText('4711-TEST');
  await expect(page.locator('#logs button.link').first()).toHaveAttribute('translate', 'no');
  await openFirst(page);
  await expect(page.locator('#rows')).toHaveAttribute('translate', 'no');
  await expect(page.locator('#sidebar button.jump').first()).toHaveAttribute('translate', 'no');
  await page.keyboard.press('g');
  await page.keyboard.press('?');
  await expect(page.locator('#dialog kbd').first()).toHaveAttribute('translate', 'no');
  await page.keyboard.press('Escape');
  await page.locator('#menubutton-settings').click();
  await page.getByRole('menuitem', { name: 'Startzeile für Chrome …' }).click();
  const line = page.locator('#start-line');
  await expect(line).toHaveAttribute('spellcheck', 'false');
  await expect(line).toHaveAttribute('translate', 'no');
  // the fields of a dialog are at least 16 px, so that no browser zooms into them
  expect(await line.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
});

test('sizes and counts are written as the German page writes them', async ({ page }) => {
  await start(page);
  const cells = await page.locator('#logs td.size').allTextContents();
  expect(cells.length).toBeGreaterThan(1);
  for (const cell of cells) expect(cell, 'size').toMatch(/^(\d{1,3}(\.\d{3})* B|\d{1,3}(\.\d{3})*,\d (kB|MB))$/);
  expect(cells.some((c) => c.includes(','))).toBe(true);
  await openFirst(page);
  await expect(page.locator('#status')).toContainText(/\d+\/\d+ Einträge/);
  await expect(page.locator('.loghead')).toContainText('Zeilen');
});

test('numbers keep one width, headings balance, a word as long as the line breaks inside the page', async ({ page }) => {
  await start(page);
  const style = await page.evaluate(() => ({
    size: getComputedStyle(document.querySelector('td.size')!).fontVariantNumeric,
    status: getComputedStyle(document.querySelector('#status')!).fontVariantNumeric,
    h1: getComputedStyle(document.querySelector('.picker h1')!).textWrapStyle,
  }));
  expect(style.size).toContain('tabular-nums');
  expect(style.status).toContain('tabular-nums');
  // a browser without `text-wrap: balance` keeps `auto` and wraps as before
  expect(['balance', 'auto']).toContain(style.h1);
  // the file with the 120 character name is in the list and does not widen the page
  await expect(page.locator('#logs').getByRole('button', { name: LONG })).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('#log')!.scrollWidth - document.querySelector('#log')!.clientWidth)).toBeLessThanOrEqual(0);
  await page.locator('#logs').getByRole('button', { name: LONG }).click();
  await expect(page.locator('.loghead')).toBeVisible();
  // a known message with a very long word wraps in the side bar
  const wide = await page.evaluate(() => {
    const host = document.querySelector('#sidebar')!;
    const block = document.createElement('div');
    block.className = 'known-item';
    const explain = document.createElement('div');
    explain.className = 'explain';
    explain.textContent = 'y'.repeat(300);
    block.append(explain);
    host.append(block);
    return host.scrollWidth - host.clientWidth;
  });
  expect(wide).toBeLessThanOrEqual(0);
});

test('a group of the side bar without a hit says so', async ({ page }) => {
  await start(page);
  await openFirst(page);
  const empty = page.locator('#sidebar details.group', { hasText: '(0)' });
  expect(await empty.count()).toBeGreaterThan(0);
  for (const g of await empty.all()) await expect(g.locator('.hint')).toHaveText('Keine Treffer.');
});

test('a filter sent without a value says so at the field, with the focus there, and the dialog stays', async ({ page }) => {
  await start(page);
  await openFirst(page);
  await page.keyboard.press('g');
  await page.keyboard.press('f');
  const raw = page.locator('#filter-raw');
  await page.getByRole('button', { name: 'Hinzufügen' }).click();
  await expect(raw).toHaveAttribute('aria-invalid', 'true');
  await expect(raw).toBeFocused();
  await expect(page.locator('#filter-raw-error')).toHaveText('Bitte einen Wert eintragen.');
  expect(await raw.getAttribute('aria-describedby')).toBe('filter-raw-error');
  await expect(page.locator('#dialog')).toBeVisible();
  // an empty dialog closes on Esc without a question
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).not.toBeVisible();
  // a value that is only "!" is refused the same way, and typing clears the notice on the next send
  await page.keyboard.press('g');
  await page.keyboard.press('f');
  await raw.fill('!');
  await raw.press('Enter');
  await expect(page.locator('#filter-raw-error')).toHaveText('Nach dem ! fehlt der Text.');
  await raw.fill('session');
  await raw.press('Enter');
  await expect(page.locator('#dialog')).not.toBeVisible();
  await expect(page.locator('#status')).toContainText('Filter: text~session');
});

test('the settings say which value is wrong, at its field, and keep the dialog', async ({ page }) => {
  await start(page);
  await openFirst(page);
  await page.locator('#menubutton-settings').click();
  await page.getByRole('menuitem', { name: 'Abstände und Lücken …' }).click();
  await page.locator('#set-delta').fill('');
  await page.locator('#set-gap').fill('-3');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.locator('#set-delta')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#set-gap')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#set-delta')).toBeFocused();
  await expect(page.locator('#set-gap-error')).toContainText('ab 0');
  await expect(page.locator('#dialog')).toBeVisible();
  // right values go through, the notices are gone with the dialog
  await page.locator('#set-delta').fill('100');
  await page.locator('#set-gap').fill('2');
  await page.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(page.locator('#dialog')).not.toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('casedesk-web.view'))).toContain('"delta_ms":100');
});

test('a dialog with typed input does not close on Esc, the close button or Cancel without asking', async ({ page }) => {
  await start(page);
  await openFirst(page);
  const dialog = page.locator('#dialog');
  await page.keyboard.press('g');
  await page.keyboard.press('f');
  await expect(dialog).toHaveAttribute('closedby', 'none');
  await page.locator('#filter-raw').fill('typed');
  for (const how of ['Escape', 'close', 'cancel']) {
    if (how === 'Escape') await page.keyboard.press('Escape');
    else if (how === 'close') await page.getByRole('button', { name: 'Schließen' }).click();
    else await page.getByRole('button', { name: 'Abbrechen' }).click();
    await expect(dialog).toBeVisible();
    await expect(page.locator('.discard')).toContainText('gehen verloren');
    await expect(page.getByRole('button', { name: 'Weiter bearbeiten' })).toBeFocused();
  }
  // keep editing: the notice goes, the text stays; then drop it
  await page.getByRole('button', { name: 'Weiter bearbeiten' }).click();
  await expect(page.locator('.discard')).toHaveCount(0);
  await expect(page.locator('#filter-raw')).toHaveValue('typed');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  await expect(dialog).not.toBeVisible();
  // the changed settings are asked about too, unchanged ones are not
  await page.locator('#menubutton-settings').click();
  await page.getByRole('menuitem', { name: 'Abstände und Lücken …' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.locator('#menubutton-settings').click();
  await page.getByRole('menuitem', { name: 'Abstände und Lücken …' }).click();
  await page.locator('#set-gap').fill('9');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.discard')).toBeVisible();
  // a dialog without input closes at once and carries no closedby
  await page.getByRole('button', { name: 'Verwerfen' }).click();
  await page.keyboard.press('g');
  await page.keyboard.press('?');
  await expect(dialog).not.toHaveAttribute('closedby', 'none');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
});

test('a click on "Angekreuzte zusammenlegen" starts one reading even when it is clicked twice', async ({ page }) => {
  // the readings the page asks of its worker, counted at the worker's door
  await page.addInitScript(() => {
    const w = window as unknown as { __opens: number };
    w.__opens = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, message: unknown, ...rest: unknown[]) {
      if ((message as { method?: string } | null)?.method === 'open') w.__opens++;
      return (post as (...a: unknown[]) => void).call(this, message, ...rest);
    };
  });
  await start(page);
  await page.getByLabel('merge-fileservice.log zusammenlegen').check();
  await page.getByLabel('merge-gateway.log zusammenlegen').check();
  await page.evaluate(() => {
    const button = document.getElementById('merge') as HTMLButtonElement;
    button.click();
    button.click();
  });
  await expect(page.locator('.loghead')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __opens: number }).__opens)).toBe(1);
});
