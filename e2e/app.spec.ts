// casedesk.html in Chrome, from disk, with an invented case folder (the invented logs of casedesk.nvim's tests at the
// pinned commit) and an invented catalog: the folder, the list of logs, the reading copy with its unfolding, the side
// bar, the keys of Neovim, filters, time modes, repeats, merged logs and known messages. Throughout: no request, no
// violation of the policy, no write to an IndexedDB but casedesk-web, and nothing of a log or the catalog in the
// browser's storage.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
// @ts-expect-error a plain JavaScript module of this repository
import { fixtures } from '../build/bundle.mjs';
import { fakeCase, idbWrites, OWN_DB, pageUrl, spyOnIndexedDb, violations, watchPage } from './page';

const here = dirname(fileURLToPath(import.meta.url));
const fx: Record<string, string> = fixtures();
const CATALOG = readFileSync(join(here, 'fixtures', 'log-patterns.conf'), 'utf8');

const TREE = {
  '.case.json': JSON.stringify({ case: '4711-TEST', title: 'An invented case' }),
  'assets/browserstack-device.log': fx['browserstack-device.log'],
  'assets/agent/tbox-agent.log': fx['tbox-agent.log'],
  'assets/appium-server.ndjson.log': fx['appium-server.ndjson.log'],
  'assets/merge-fileservice.log': fx['merge-fileservice.log'],
  'assets/merge-gateway.log': fx['merge-gateway.log'],
  'assets/browserstack-device.redacted.log': 'a redacted copy is never offered',
  'assets/screen.png': 'not a log',
  'Research/01_Notes.md': 'not under assets/',
};

/** Texts of the logs and the catalog that must never reach the browser's storage. */
const SECRETS = ['clickGesture', 'Heartbeat', 'Keep-alive failed', 'FileService did not answer', 'Invented idle timeout', 'explanation'];

async function start(page: Page, catalog = false) {
  await spyOnIndexedDb(page);
  await fakeCase(page, { name: '4711-folder', tree: TREE, catalog: catalog ? { name: 'log-patterns.conf', text: CATALOG } : undefined });
  const watch = await watchPage(page, 'casedesk.html');
  await page.goto(pageUrl('casedesk.html'));
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  return watch;
}

async function openLog(page: Page, path: string) {
  await page.locator('#logs').getByRole('button', { name: path, exact: true }).click();
  await expect(page.locator('.loghead')).toBeVisible();
}

const rows = (page: Page) => page.locator('#rows .row');
const entries = (page: Page) => page.locator('#rows .row.entry');
const cursor = (page: Page) => page.locator('#rows .row.cursor');
const keys = async (page: Page, ...ks: string[]) => {
  for (const k of ks) await page.keyboard.press(k);
};
const group = (page: Page, key: string) => page.locator(`#sidebar details[data-group="${key}"]`);

async function clean(page: Page, watch: Awaited<ReturnType<typeof watchPage>>) {
  expect(watch.requests, 'requests that left the page').toEqual([]);
  expect(watch.errors, 'errors of the page').toEqual([]);
  expect(await violations(page), 'violations of the policy').toEqual([]);
  const writes = await idbWrites(page);
  for (const w of writes) {
    expect(w.db, 'only the own database').toBe(OWN_DB);
    for (const s of SECRETS) expect(w.json, `no "${s}" in IndexedDB`).not.toContain(s);
  }
  const stored = await page.evaluate(() => Object.entries(localStorage));
  for (const [k, v] of stored) {
    expect(k).toBe('casedesk-web.view');
    for (const s of SECRETS) expect(v).not.toContain(s);
  }
  return writes;
}

test('a case folder, its logs, the reading copy, the side bar and the keys of Neovim', async ({ page }) => {
  const watch = await start(page);

  await page.locator('#pick').click();
  await expect(page.locator('#where')).toHaveText('4711-TEST');
  const listed = page.locator('#logs tbody tr');
  await expect(listed).toHaveCount(5);
  await expect(listed.nth(0)).toContainText('agent/tbox-agent.log');
  await expect(page.locator('#logs')).not.toContainText('redacted');
  await expect(page.locator('#logs')).not.toContainText('screen.png');

  await openLog(page, 'browserstack-device.log');
  await expect(page.locator('#where')).toHaveText('4711-TEST · browserstack-device.log');
  await expect(page.locator('.loghead')).toContainText('11 Einträge');
  await expect(rows(page)).toHaveCount(11);
  await expect(page.locator('#rows .row[data-id="e7"]')).toContainText('GET /source → page source · 10 nodes (177 ms)');
  await expect(page.locator('#rows .row[data-id="e10"]')).toContainText('⚠ invalid JSON: Expected value but found unexpected end of string');
  await expect(page.locator('#rows .row.lvl-error')).toHaveCount(1);
  await expect(page.locator('#status')).toContainText('11/11 Einträge');

  // the side bar: groups with counts, a click jumps
  await expect(group(page, 'errors').locator('summary')).toHaveText('Fehler (1)');
  await expect(group(page, 'warnings').locator('summary')).toHaveText('Warnungen (1)');
  await expect(group(page, 'known').locator('summary')).toHaveText('Bekannt (kein Katalog)');
  await group(page, 'warnings').getByRole('button').click();
  await expect(cursor(page)).toHaveAttribute('data-id', 'e11');

  // jumps as in Neovim
  await keys(page, 'g', 'g');
  await expect(cursor(page)).toHaveAttribute('data-id', 'e1');
  await keys(page, ']', 'e');
  await expect(cursor(page)).toHaveAttribute('data-id', 'e6');
  await keys(page, ']', 'w');
  await expect(cursor(page)).toHaveAttribute('data-id', 'e11');
  await keys(page, '[', 'r');
  await expect(cursor(page)).toHaveAttribute('data-id', 'e10');
  await keys(page, ']', 'e');
  await expect(page.locator('#message')).toHaveText('Kein weiterer Fehler');

  // unfold the page source, switch its mode, fold everything
  await page.locator('#rows .row[data-id="e7"]').click();
  await keys(page, 'z', 'a');
  await expect(page.locator('#rows .row[data-id="e7/info"]')).toHaveText(/10 nodes, 5 with text\/id\/description · showing 5 \(labelled; gs switches\)/);
  await expect(page.locator('#rows .row[data-id="e7/2"]')).toContainText('Button "Scan" #scan clickable focusable [800,400][1300,520]');
  await keys(page, 'g', 's');
  await expect(page.locator('#rows .row[data-id="e7/info"]')).toContainText('(all; gs switches)');
  await expect(page.locator('#status')).toContainText('Seitenquelltext: all');
  await keys(page, 'g', 's', 'g', 's');
  await expect(page.locator('#rows .row[data-id="e7/info"]')).toContainText('(labelled; gs switches)');
  await keys(page, 'j', 'j', 'z', 'c');
  await expect(page.locator('#rows .row[data-id="e7/info"]')).toHaveCount(0);
  await expect(cursor(page)).toHaveAttribute('data-id', 'e7');
  await keys(page, 'z', 'Shift+R');
  await expect(page.locator('#rows .row[data-id="e6/p1"]')).toHaveText(/request/);
  await keys(page, 'z', 'Shift+M');
  await expect(rows(page)).toHaveCount(11);

  // time: original -> UTC -> relative to the first entry, the unfolded rows stay open
  await page.locator('#rows .row[data-id="e7"]').click();
  await keys(page, 'Enter');
  await keys(page, 't', 'z');
  await expect(page.locator('#status')).toContainText('Zeit: UTC');
  await keys(page, 't', 'z');
  await expect(page.locator('#rows .row[data-id="e1"] .time')).toHaveText('+00:00:00.000');
  await expect(page.locator('#rows .row[data-id="e7/info"]')).toBeVisible();
  await expect(cursor(page)).toHaveAttribute('data-id', 'e7');
  await keys(page, 't', 'z');
  await expect(page.locator('#rows .row[data-id="e1"] .time')).toHaveText('07:58:30.904');

  // the original lines of an entry
  await page.locator('#rows .row[data-id="e10"]').click();
  await keys(page, 'g', 'Shift+O');
  await expect(page.locator('#dialog')).toContainText('browserstack-device.log, Zeilen 14');
  await expect(page.locator('#dialog pre')).toContainText('GET');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).not.toBeVisible();

  // filters: add one, drop it; the menu has the same
  await keys(page, 'g', 'f');
  await page.locator('#filter-field').selectOption('text');
  await page.locator('#filter-raw').fill('/source/');
  await page.locator('#filter-raw').press('Enter');
  await expect(entries(page)).toHaveCount(2);
  await expect(page.locator('#status')).toContainText('2/11 Einträge · Filter: text=~source');
  await keys(page, 'g', 'Shift+F');
  await expect(entries(page)).toHaveCount(11);
  await page.locator('#menubutton-filter').click();
  await page.getByRole('menuitem', { name: /Nur Fehler/ }).click();
  await expect(entries(page)).toHaveCount(1);
  await expect(entries(page).first()).toHaveAttribute('data-id', 'e6');
  await keys(page, 'g', '0');
  await expect(entries(page)).toHaveCount(11);

  // the help lists the keys
  await keys(page, 'g', '?');
  await expect(page.locator('#dialog')).toContainText(']e');
  await page.keyboard.press('Escape');

  // the line for a shortcut that opens the page as its own window
  await page.locator('#menubutton-settings').click();
  await page.getByRole('menuitem', { name: 'Startzeile für Chrome …' }).click();
  await expect(page.locator('#start-line')).toHaveValue(/^"C:\\Program Files\\Google\\Chrome\\Application\\chrome\.exe" --app="file:\/\/\/.*\/casedesk\.html"$/);
  await page.keyboard.press('Escape');

  await clean(page, watch);
});

test('repeats, exceptions, stack trees and merged logs', async ({ page }) => {
  const watch = await start(page);
  await page.locator('#pick').click();
  await openLog(page, 'agent/tbox-agent.log');

  await expect(rows(page)).toHaveCount(6);
  await expect(page.locator('#rows .row[data-id="e2"] .rep')).toContainText('×3');
  await expect(group(page, 'repeats').locator('summary')).toHaveText('Wiederholungen (1)');
  await expect(group(page, 'exceptions')).toContainText('OpenQA.Selenium.WebDriverException');
  await keys(page, 'g', 'r');
  await expect(rows(page)).toHaveCount(8);
  await expect(page.locator('#status')).toContainText('ungefaltet');
  await keys(page, 'g', 'r');
  await expect(rows(page)).toHaveCount(6);

  // the stack trace as a tree: the foreign frames fold into one row
  await group(page, 'exceptions').getByRole('button').click();
  await expect(cursor(page)).toHaveAttribute('data-id', 'e7');
  await keys(page, 'z', 'o');
  await expect(page.locator('#rows .row[data-id="e7/3"]')).toContainText('3 foreign frames (OpenQA.Selenium)');
  await expect(page.locator('#rows .row[data-id="e7/4"] .hl-CaselogOwn')).toContainText('Tricentis.Demo.Agent.Remote.KeepAlive.Ping');

  // two logs merged by time: the file column, UTC, a gap
  await page.locator('#menubutton-file').click();
  await page.getByRole('menuitem', { name: 'Log wählen …' }).click();
  await page.getByRole('checkbox', { name: 'merge-fileservice.log zusammenlegen' }).check();
  await page.getByRole('checkbox', { name: 'merge-gateway.log zusammenlegen' }).check();
  await page.locator('#merge').click();
  await expect(page.locator('#where')).toHaveText('4711-TEST · merge-fileservice.log + merge-gateway.log');
  await expect(page.locator('.loghead')).toContainText('2 logs merged');
  await expect(page.locator('#rows .row .tag').first()).toBeVisible();
  await expect(page.locator('#rows')).toContainText('merge-gateway');
  await expect(page.locator('#status')).toContainText('Zeit: UTC');
  const gaps = await group(page, 'gaps').locator('li').count();
  expect(gaps).toBeGreaterThan(0);
  await keys(page, 'g', 'g', ']', 'g');
  await expect(cursor(page)).toHaveClass(/\bgap\b/);
  await expect(cursor(page)).toContainText('without an entry');

  await clean(page, watch);
});

test('the catalog of known messages, and a reload keeps the folder and the catalog but no content', async ({ page }) => {
  const watch = await start(page, true);
  await page.locator('#pick').click();
  await page.locator('#menubutton-catalog').click();
  await page.getByRole('menuitem', { name: 'Katalog-Datei wählen …' }).click();
  await expect(page.locator('#message')).toHaveText('Katalog log-patterns.conf gewählt');
  await openLog(page, 'browserstack-device.log');

  await expect(page.locator('#rows .row[data-id="e11"] .known')).toHaveText('⚑ known: Invented idle timeout');
  const known = group(page, 'known');
  await expect(known.locator('summary')).toHaveText('Bekannt (1)');
  await expect(known).toContainText('✱ Invented idle timeout · warn');
  await expect(known).toContainText('An invented explanation: the session sat idle for too long.');
  await expect(known.locator('a')).toHaveAttribute('href', 'https://example.invalid/kb/0000001');
  await expect(known.locator('a')).toHaveAttribute('target', '_blank');
  await expect(known).toContainText('KB0000001');
  await expect(known).toContainText('Fall 4711');
  await keys(page, 'g', 'g', ']', 'k');
  await expect(cursor(page)).toHaveAttribute('data-id', 'e11');
  await expect(page.locator('#message')).toHaveText('known: Invented idle timeout [warn]');

  // the broken block is reported, the others count
  await page.locator('#menubutton-catalog').click();
  await expect(page.locator('#menu-catalog')).toContainText('2 Einträge, 1 Treffer in diesem Log');
  await page.getByRole('menuitem', { name: /1 Probleme im Katalog/ }).click();
  await expect(page.locator('#dialog')).toContainText('example-broken');
  await page.keyboard.press('Escape');

  // what was kept before the reload: the folder used (its handle) and the catalog file's handle, no content
  const before = await clean(page, watch);
  expect(before.some((w) => w.json.includes('4711-folder'))).toBe(true);
  expect(before.some((w) => w.json.includes('log-patterns.conf'))).toBe(true);

  // a reload: the folder is in the list of folders used, the catalog is still chosen, no log is open
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await expect(page.locator('.recent')).toContainText('4711-folder');
  await page.locator('.recent').getByRole('button', { name: '4711-folder' }).click();
  await openLog(page, 'agent/tbox-agent.log');
  await expect(group(page, 'known')).toContainText('Invented lost session');
  await expect(page.locator('#rows .row[data-id="e7"] .known')).toHaveText('⚑ known: Invented lost session');

  const after = await clean(page, watch);
  expect(after.some((w) => w.json.includes('4711-folder'))).toBe(true);
});
