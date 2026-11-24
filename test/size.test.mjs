// The size budget of the pages (build/check-size.mjs): the pages of the repository are inside it, and the check says so
// when one is not.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BUDGET, judge, measure } from '../build/check-size.mjs';

describe('the size budget of the pages', () => {
  test('the built pages of the repository are inside it', () => {
    assert.deepEqual(judge(measure()), []);
  });

  test('a page over its budget by one byte is named, one at the budget is not', () => {
    const at = Object.fromEntries(Object.entries(BUDGET));
    assert.deepEqual(judge(at), []);
    const over = { ...at, 'casedesk.html': BUDGET['casedesk.html'] + 1 };
    assert.equal(judge(over).length, 1);
    assert.match(judge(over)[0], /casedesk\.html: 441001 B is over the budget of 441000 B/);
  });

  test('a page that is not there is a problem, not a pass', () => {
    assert.match(judge({ ...BUDGET, 'probe.html': null })[0], /probe\.html: missing/);
    assert.match(judge({})[0], /missing/);
  });

  test('the budget keeps about 10 % over what the pages measure now', () => {
    for (const [page, size] of Object.entries(measure())) {
      assert.ok(BUDGET[page] / size < 1.15, `${page}: the budget is more than 15 % over its size, tighten it`);
    }
  });
});
