// probe.html in Chrome, from disk, with an in-memory test folder in place of the picker: the startup checks pass, the
// probe writes, reads back, renames and deletes its one test file, keeps its marker in IndexedDB over a reload, and
// writes only to the database of casedesk-web. Its one request (the test of the CSP) is refused by the policy.

import { expect, test } from '@playwright/test';
import { fakePicker, idbWrites, OWN_DB, pageUrl, spyOnIndexedDb, violations, watchPage } from './page';

const BLOCKED = 'https://example.invalid/';

async function startupDone(page: import('@playwright/test').Page) {
  await expect(page.locator('#row-time')).toBeVisible({ timeout: 20_000 });
}

test('the probe: startup checks, the test file, the marker over a reload, no request', async ({ page }) => {
  await fakePicker(page);
  await spyOnIndexedDb(page);
  const watch = await watchPage(page, 'probe.html');
  await page.goto(pageUrl('probe.html'));
  await startupDone(page);

  for (const id of ['env', 'fsa', 'wasm', 'worker-classic', 'filler', 'idb', 'csp']) {
    await expect(page.locator(`#row-${id} td.state`), id).toHaveClass(/\bok\b/);
  }
  await expect(page.locator('#row-marker')).toContainText('IndexedDB = none');

  await page.getByRole('button', { name: '1. Pick an empty test folder' }).click();
  await expect(page.locator('#row-store td.state')).toHaveClass(/\bok\b/);
  await expect(page.locator('#row-write td.state')).toHaveClass(/\bok\b/);
  await expect(page.locator('#row-write')).toContainText('move() ok, delete ok');
  // the test file is gone again: nothing is left in the folder
  expect(await page.evaluate(() => (window as unknown as { __probeFolder(): string[] }).__probeFolder())).toEqual([]);

  // over a reload the marker of the first visit is still there, in both stores
  await page.reload();
  await startupDone(page);
  await expect(page.locator('#row-marker')).toContainText(/IndexedDB = \d{4}-\d\d-\d\dT/);
  await expect(page.locator('#row-marker')).toContainText(/localStorage = \d{4}-\d\d-\d\dT/);

  // the one request of the page is its test of the CSP, and the policy refused it
  const left = watch.requests.filter((url) => url !== BLOCKED);
  expect(left, 'requests that left the page').toEqual([]);
  const broken = (await violations(page)).filter((v) => !v.includes(BLOCKED));
  expect(broken, 'violations of the policy other than the test of the CSP').toEqual([]);
  // Chrome writes the refused fetch of that test to the console as an error, twice per visit
  const errors = watch.errors.filter((e) => !e.includes(BLOCKED));
  expect(errors, 'errors of the page other than the test of the CSP').toEqual([]);
  expect(watch.errors.length).toBeGreaterThan(0);

  const writes = await idbWrites(page);
  expect(writes.length).toBeGreaterThan(0);
  expect([...new Set(writes.map((w) => w.db))], 'databases written to').toEqual([OWN_DB]);
});
