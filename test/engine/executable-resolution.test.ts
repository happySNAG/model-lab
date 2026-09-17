// Cernum · finding a CLI the person installed, from a process that was not started by their shell.
//
// THE FAILURE THIS FILE PINS. On the Mac mini, on 2026-09-17, both of these were true at once:
//
//     $ opencode models opencode --refresh | grep union     ->  opencode/union-alpha
//     $ cernum providers                                    ->  OpenCode (metered API) [notInstalled]
//
// The CLI was installed, authenticated, and listing Union Alpha. `findExecutable` read `PATH` and
// nothing else, OpenCode installs to `~/.opencode/bin` and puts that directory in the SHELL PROFILE,
// and neither a Finder-launched app nor a non-interactive `sh -c` reads a shell profile. So the
// status view was reporting on how Cernum had been launched while appearing to report on the machine.
//
// Every path below is a real installed location on that machine.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findExecutable } from '../../src/engine/cli-process';

/** The PATH a macOS app inherits from `launchd` when it is opened from Finder or the Dock. */
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

let home = '';
const executable = (...segments: string[]) => path.join(home, ...segments);

function install(where: string, name: string): string {
  fs.mkdirSync(where, { recursive: true });
  const file = path.join(where, name);
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(file, 0o755);
  return file;
}

beforeAll(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'cernum-exec-')); });
afterAll(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('findExecutable · a truncated PATH is a fact about the launcher, not about the machine', () => {
  it('finds the OpenCode CLI in its installer directory when PATH is what Finder gives an app', () => {
    const installed = install(executable('.opencode', 'bin'), 'opencode');
    expect(findExecutable('opencode', { PATH: FINDER_PATH, HOME: home })).toBe(installed);
  });

  it('finds a CLI installed to ~/.local/bin, which is where most `curl | sh` installers put one', () => {
    const installed = install(executable('.local', 'bin'), 'codex');
    expect(findExecutable('codex', { PATH: FINDER_PATH, HOME: home })).toBe(installed);
  });

  it('still says nothing is there when nothing is there — the fallback widens the search, not the claim', () => {
    expect(findExecutable('a-cli-nobody-installed', { PATH: FINDER_PATH, HOME: home })).toBeUndefined();
  });

  it('lets PATH win, so a build the person deliberately put first is the one that runs', () => {
    const chosen = install(path.join(home, 'chosen'), 'opencode');
    install(executable('.opencode', 'bin'), 'opencode');
    expect(findExecutable('opencode', { PATH: `${path.join(home, 'chosen')}:${FINDER_PATH}`, HOME: home })).toBe(chosen);
  });

  it('searches nothing under a home directory it was never told about', () => {
    install(executable('.opencode', 'bin'), 'opencode');
    expect(findExecutable('opencode', { PATH: FINDER_PATH })).toBeUndefined();
  });
});
