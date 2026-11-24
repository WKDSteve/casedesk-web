// The size of each built page, checked after the build (the CI has no Python, so this is Node): a page is one HTML file
// that Chrome reads from disk, and growth is a decision, not an accident. The budget of a page is the size measured on
// 2026-11-24 plus 10 % (what a build gave, not a guess), rounded up; a change that outgrows it raises the number here
// on purpose and says why in its commit, or cuts something.
//
//   node build/check-size.mjs            checks the pages of the repository (exit 1 over the budget, 2 a page missing)
//   node build/check-size.mjs --measure  prints the sizes, to set a new budget

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root } from './bundle.mjs';

/**
 * Measured 2026-11-24: casedesk.html 400,678 B, engine-check.html 321,165 B, probe.html 544,031 B (it carries a filler
 * the size of the Lua VM on purpose). Plus 10 %, rounded up to the next thousand.
 * @type {Record<string, number>}
 */
export const BUDGET = {
  'casedesk.html': 441_000,
  'engine-check.html': 354_000,
  'probe.html': 599_000,
};

/**
 * The pages that are over their budget, or missing a size.
 * @param {Record<string, number | null>} sizes bytes by page, null for a missing file
 * @param {Record<string, number>} [budget]
 * @returns {string[]} one line per problem
 */
export function judge(sizes, budget = BUDGET) {
  const problems = [];
  for (const [page, max] of Object.entries(budget)) {
    const size = sizes[page];
    if (size === null || size === undefined) problems.push(`${page}: missing (build first: pnpm build)`);
    else if (size > max) problems.push(`${page}: ${size} B is over the budget of ${max} B`);
  }
  return problems;
}

/** The sizes of the pages in `dir`, null for one that is not there. */
export function measure(dir = root, pages = Object.keys(BUDGET)) {
  return Object.fromEntries(pages.map((p) => [p, existsSync(join(dir, p)) ? statSync(join(dir, p)).size : null]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sizes = measure();
  for (const [page, size] of Object.entries(sizes)) console.log(`${page.padEnd(20)} ${String(size ?? 'missing').padStart(8)} B   budget ${BUDGET[page]} B`);
  if (!process.argv.includes('--measure')) {
    const problems = judge(sizes);
    if (problems.length) {
      for (const p of problems) console.error(p);
      console.error('cut something, or raise BUDGET in build/check-size.mjs and say why in the commit');
      process.exit(Object.values(sizes).includes(null) ? 2 : 1);
    }
  }
}
