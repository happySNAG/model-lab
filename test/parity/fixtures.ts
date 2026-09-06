import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixturesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/parity');

export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixturesRoot, name), 'utf8')) as T;
}

/** Strip `undefined` properties the way JSON encoding does, so deep-equality with decoded fixtures is exact. */
export function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
