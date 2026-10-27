// Cernum · the owner's Master Vision v1.0 is kept in the repository byte for byte, and every conflict
// between it and existing behaviour is on the register.
//
// Vision: docs/VISION.md. Register: docs/ordra-lane/vision-conflicts.md.

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file));

/** sha256 of the owner's CERNUM-VISION-MANIFESTO-v1.0-20261026.md. */
const VISION_SHA256 = 'f6588f46fdacb7d24e20ff088a2f2ea09652557ddb929754c8d70a6fdcef9f93';

describe('the Cernum Master Vision v1.0', () => {
  it('is docs/VISION.md, byte for byte', () => {
    expect(createHash('sha256').update(read('docs/VISION.md')).digest('hex')).toBe(VISION_SHA256);
  });

  it('is linked from README.md and docs/ARCHITECTURE.md', () => {
    expect(read('README.md').toString('utf8')).toContain('](docs/VISION.md)');
    expect(read('docs/ARCHITECTURE.md').toString('utf8')).toContain('](VISION.md)');
  });
});

describe('the vision conflict register', () => {
  const register = read('docs/ordra-lane/vision-conflicts.md').toString('utf8');

  it('records K1 to K5, each with a resolution', () => {
    const sections = register.split(/^## /m).slice(1);
    for (const id of ['K1', 'K2', 'K3', 'K4', 'K5']) {
      const section = sections.find((text) => text.startsWith(`${id} `));
      expect(section, id).toBeDefined();
      expect(section, id).toMatch(/\*\*Resolution\.\*\*/);
    }
  });

  it('names the owner decisions and passes that resolve them', () => {
    expect(register).toContain('B4-4');
    expect(register).toContain('B4-2');
    expect(register).toContain('B4-3');
    expect(register).toContain('reliability, cost, speed everywhere');
    expect(register).toContain('MacBook Ordra lane');
  });

  it('cites code locations that exist', () => {
    for (const [, file] of register.matchAll(/`(src\/[\w/.-]+\.ts):\d/g)) expect(fs.existsSync(path.join(root, file)), file).toBe(true);
  });
});
