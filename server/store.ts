import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Diagnostic, Track } from './types';
export const dataDir = path.resolve(process.env.SONOS_DATA_DIR || '.local');
export type Settings = { favorites: Track[]; roomOrder: string[]; hiddenRooms: string[] };
export class Store<T> {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private name: string,
    private initial: T,
  ) {}
  async read(): Promise<T> {
    try {
      return JSON.parse(await readFile(path.join(dataDir, this.name), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(this.initial);
      throw e;
    }
  }
  update(fn: (value: T) => T | Promise<T>): Promise<T> {
    const operation = this.chain.then(async () => {
      const next = await fn(await this.read());
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const temp = path.join(dataDir, `${this.name}.${randomBytes(6).toString('hex')}.tmp`);
      await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
      await rename(temp, path.join(dataDir, this.name));
      return next;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}
export const settings = new Store<Settings>('settings.json', {
  favorites: [],
  roomOrder: [],
  hiddenRooms: [],
});
export const diagnostics: Diagnostic[] = [];
export function diagnose(source: string, code: string, message: string, hint: string) {
  // Callers use safe summaries, never upstream URLs or OAuth tokens.
  diagnostics.unshift({ at: new Date().toISOString(), source, code, message, hint });
  diagnostics.splice(100);
}
