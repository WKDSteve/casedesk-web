// What the browser tests share: the built files and the watch on what a page must never do (a request, a violation of
// its policy, a write to another app's IndexedDB; appkit-web/e2e).

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { idbWrites, spyOnIndexedDb, violations, watchPage as watchKitPage, type IdbWrite, type Watch } from 'appkit-web/e2e';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The address of a built page. */
export function pageUrl(name: 'probe.html' | 'engine-check.html'): string {
  const file = resolve(root, name);
  if (!existsSync(file)) throw new Error(`${file} is not there: run "pnpm build" first`);
  return pathToFileURL(file).href;
}

/** Watch the page from now on; the page itself is not a request. */
export function watchPage(page: Page, name: 'probe.html' | 'engine-check.html'): Promise<Watch> {
  return watchKitPage(page, { pageUrl: pageUrl(name) });
}

/** The one database casedesk-web may write to. */
export const OWN_DB = 'casedesk-web';

export { idbWrites, spyOnIndexedDb, violations, type IdbWrite, type Watch };

/**
 * A `showDirectoryPicker` that hands out an empty in-memory folder named `name`, writable like a real one (the probe's
 * write, read back, move, delete). `window.__probeFolder()` lists the names in it. Methods live on the prototypes, so
 * that the handle can be stored in IndexedDB (the structured clone keeps `kind` and `name`).
 */
export async function fakePicker(page: Page, name = 'empty-test-folder'): Promise<void> {
  await page.addInitScript((rootName: string) => {
    const files = new Map<string, string>();
    class FakeFile {
      kind = 'file' as const;
      constructor(public name: string) {}
      async getFile() {
        const text = files.get(this.name) ?? '';
        return new File([text], this.name);
      }
      async createWritable() {
        let text = '';
        const handle = this;
        return {
          async write(chunk: string) {
            text += chunk;
          },
          async close() {
            files.set(handle.name, text);
          },
        };
      }
      async move(to: string) {
        const text = files.get(this.name);
        if (text === undefined) throw Object.assign(new Error('gone'), { name: 'NotFoundError' });
        files.delete(this.name);
        files.set(to, text);
        this.name = to;
      }
    }
    class FakeDir {
      kind = 'directory' as const;
      constructor(public name: string) {}
      async queryPermission() {
        return 'granted';
      }
      async requestPermission() {
        return 'granted';
      }
      async getFileHandle(file: string, opts?: { create?: boolean }) {
        if (!files.has(file)) {
          if (!opts?.create) throw Object.assign(new Error(`${file} not found`), { name: 'NotFoundError' });
          files.set(file, '');
        }
        return new FakeFile(file);
      }
      async removeEntry(file: string) {
        if (!files.delete(file)) throw Object.assign(new Error(`${file} not found`), { name: 'NotFoundError' });
      }
      async *entries() {
        for (const file of [...files.keys()]) yield [file, new FakeFile(file)] as const;
      }
    }
    const w = window as unknown as Record<string, unknown>;
    w.showDirectoryPicker = async () => new FakeDir(rootName);
    w.__probeFolder = () => [...files.keys()];
  }, name);
}
