// engine-check.html in Chrome, from disk: the Lua core starts in its worker, builds the reading copy of the embedded
// test log, and the page makes no request, breaks no rule of its policy and writes nothing to IndexedDB.

import { expect, test } from '@playwright/test';
import { idbWrites, pageUrl, spyOnIndexedDb, violations, watchPage } from './page';

test('the Lua core builds the reading copy of the test log, without a request', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await spyOnIndexedDb(page);
  const watch = await watchPage(page, 'engine-check.html');
  await page.goto(pageUrl('engine-check.html'));

  await expect(page.locator('body')).toHaveAttribute('data-state', /^(done|fail)$/, { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-state', 'done');

  for (const id of ['env', 'unpack', 'start', 'hello', 'copy-doc']) {
    await expect(page.locator(`#row-${id} td.state`), id).toHaveClass(/\bok\b/);
  }
  await expect(page.locator('#row-hello')).toContainText('Lua 5.4');
  await expect(page.locator('#row-copy-doc')).toContainText('format browserstack');
  await expect(page.locator('#row-copy-doc')).toContainText('11 entries');
  await expect(page.locator('#row-copy-doc')).toContainText('times 07:58:30.904 .. 08:01:01.262');

  // the reading copy: one row per entry, the page source unfolded, the cut line with its note
  const rows = page.locator('#entries tr');
  await expect(rows).toHaveCount(11);
  await expect(rows.nth(6)).toContainText('GET /source → page source · 10 nodes');
  await expect(rows.nth(6)).toContainText('(+10 lines)');
  await expect(rows.nth(9)).toContainText('invalid JSON: Expected value but found unexpected end of string');
  await expect(page.locator('#entries tr.level-error')).toHaveCount(1);

  // "Copy result" puts the text of the result on the clipboard
  await page.getByRole('button', { name: 'Copy result' }).click();
  await expect(page.locator('#row-copy td.state')).toHaveClass(/\bok\b/);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('casedesk-web engine check');
  expect(copied).toContain('- OK Reading copy of the test log: format browserstack');

  expect(watch.requests, 'requests that left the page').toEqual([]);
  expect(watch.errors, 'errors of the page').toEqual([]);
  expect(await violations(page), 'violations of the policy').toEqual([]);
  expect(await idbWrites(page), 'writes to IndexedDB').toEqual([]);
});
