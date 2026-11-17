// What the browser tests share: the built files and the watch on what a page must never do (a request, a violation of
// its policy, a write to another app's IndexedDB; appkit-web/e2e).

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Page } from '@playwright/test';
import { idbWrites, spyOnIndexedDb, violations, watchPage as watchKitPage, type IdbWrite, type Watch } from 'appkit-web/e2e';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export type PageName = 'casedesk.html' | 'probe.html' | 'engine-check.html';

/** The address of a built page. */
export function pageUrl(name: PageName): string {
  const file = resolve(root, name);
  if (!existsSync(file)) throw new Error(`${file} is not there: run "pnpm build" first`);
  return pathToFileURL(file).href;
}

/** Watch the page from now on; the page itself is not a request. */
export function watchPage(page: Page, name: PageName): Promise<Watch> {
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

/**
 * A case folder in memory, handed out by `showDirectoryPicker`, read only: `tree` maps `/`-separated paths to texts.
 * `showOpenFilePicker` hands out the file `catalog` (name and text), when given.
 *
 * IndexedDB keeps a handle as a structured clone, which drops the methods of these fakes (Chrome keeps a real handle
 * whole). So that the folders used before and the catalog survive a reload as with real handles, a value read back from
 * IndexedDB that looks like one of these fakes (same kind and name) is given back as the fake again. The writes the
 * page makes are untouched (`spyOnIndexedDb` sees them as they are).
 */
export async function fakeCase(
  page: Page,
  opts: { name: string; tree: Record<string, string>; catalog?: { name: string; text: string } },
): Promise<void> {
  await page.addInitScript((o: { name: string; tree: Record<string, string>; catalog?: { name: string; text: string } }) => {
    type Node = { kind: 'file'; name: string; text: string } | { kind: 'directory'; name: string; children: Map<string, Node> };
    const root: Node = { kind: 'directory', name: o.name, children: new Map() };
    for (const [path, text] of Object.entries(o.tree)) {
      const parts = path.split('/');
      let at = root as Extract<Node, { kind: 'directory' }>;
      for (const part of parts.slice(0, -1)) {
        let next = at.children.get(part);
        if (!next) {
          next = { kind: 'directory', name: part, children: new Map() };
          at.children.set(part, next);
        }
        at = next as Extract<Node, { kind: 'directory' }>;
      }
      at.children.set(parts.at(-1)!, { kind: 'file', name: parts.at(-1)!, text });
    }
    // Classes, so that the methods live on the prototypes and a handle can be stored (a structured clone keeps `kind`
    // and `name`); what a handle stands for is kept in a WeakMap, never on the handle, so no text reaches IndexedDB.
    const of = new WeakMap<object, Node>();
    class FakeFile {
      kind = 'file' as const;
      constructor(public name: string) {}
      async queryPermission() {
        return 'granted';
      }
      async requestPermission() {
        return 'granted';
      }
      async getFile() {
        const n = of.get(this) as Extract<Node, { kind: 'file' }>;
        return new File([n.text], n.name);
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
      async isSameEntry(other: { name?: string; kind?: string }) {
        return other?.kind === 'directory' && other?.name === this.name;
      }
      async *values() {
        const n = of.get(this) as Extract<Node, { kind: 'directory' }>;
        for (const c of n.children.values()) yield c.kind === 'directory' ? dirHandle(c) : fileHandle(c);
      }
    }
    const fileHandle = (n: Extract<Node, { kind: 'file' }>) => {
      const f = new FakeFile(n.name);
      of.set(f, n);
      return f;
    };
    const dirHandle = (n: Extract<Node, { kind: 'directory' }>) => {
      const d = new FakeDir(n.name);
      of.set(d, n);
      return d;
    };
    const rootHandle = dirHandle(root);
    const catalogHandle = o.catalog ? fileHandle({ kind: 'file', ...o.catalog }) : null;
    const w = window as unknown as Record<string, unknown>;
    w.showDirectoryPicker = async () => rootHandle;
    if (catalogHandle) w.showOpenFilePicker = async () => [catalogHandle];
    const revive = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(revive);
      if (v && typeof v === 'object') {
        const r = v as Record<string, unknown>;
        if (r.kind === 'directory' && r.name === o.name) return rootHandle;
        if (catalogHandle && r.kind === 'file' && r.name === catalogHandle.name) return catalogHandle;
        return Object.fromEntries(Object.entries(r).map(([k, x]) => [k, revive(x)]));
      }
      return v;
    };
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, key);
      const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result')!;
      Object.defineProperty(request, 'result', { get: () => revive(desc.get!.call(request)) });
      return request;
    };
  }, opts);
}
