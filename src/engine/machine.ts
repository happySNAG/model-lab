// Benchmark engine · reading this machine, for the guards.
//
// Lifted out of the live Ollama host for one reason: a campaign with no local candidates still runs
// ON a machine, and a benchmark that fills the disk or drives the box into swap is still a benchmark
// that must stop — whoever is answering its prompts. The guards need a reading either way, and they
// should not have to construct an Ollama transport to get one.
//
// Every probe here is READ-ONLY and best-effort. A figure that cannot be read is reported as the
// value least likely to cause a spurious abort, with the reasoning written down beside it, because a
// guard that fails because it could not measure would stop every campaign on a platform it does not
// recognise.

import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], timeout = 5_000): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Ports with a listener, as the OS reports them. Read-only; nothing is opened or closed. */
export async function readListeners(): Promise<Record<string, number>> {
  const listeners: Record<string, number> = {};
  if (process.platform === 'win32') {
    const out = await run('netstat', ['-ano', '-p', 'TCP']);
    for (const line of (out ?? '').split('\n')) {
      const match = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (match) listeners[match[1]] = Number(match[2]);
    }
    return listeners;
  }
  // `lsof -nP -iTCP -sTCP:LISTEN` is the portable-enough answer on macOS and Linux.
  const out = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn'], 8_000);
  let pid = 0;
  for (const line of (out ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n')) {
      const match = /:(\d+)$/.exec(line);
      if (match) listeners[match[1]] = pid;
    }
  }
  return listeners;
}

export async function freeDiskBytes(path: string): Promise<number> {
  try {
    const stats = fs.statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export async function swapUsedBytes(): Promise<number> {
  if (process.platform === 'darwin') {
    const out = await run('sysctl', ['-n', 'vm.swapusage']);
    const match = /used\s*=\s*([\d.]+)M/.exec(out ?? '');
    return match ? Math.round(Number(match[1]) * 1024 * 1024) : 0;
  }
  if (process.platform === 'linux') {
    try {
      const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
      const total = /SwapTotal:\s+(\d+) kB/.exec(meminfo);
      const free = /SwapFree:\s+(\d+) kB/.exec(meminfo);
      if (total && free) return (Number(total[1]) - Number(free[1])) * 1024;
    } catch { /* fall through */ }
  }
  // An unreadable swap figure is reported as zero rather than as a breach: a guard that fails
  // because it could not measure would stop every campaign on a platform it does not know.
  return 0;
}

/**
 * The machine, without a model store.
 *
 * The store fields are the caller's to fill: a campaign with local candidates reads them from its
 * runtime, and a frontier-only campaign has no store to read and no store guard to satisfy.
 */
export async function readMachine(diskPath?: string): Promise<{
  freeDiskBytes: number; swapUsedBytes: number; freeMemoryBytes: number; totalMemoryBytes: number;
  listeners: Record<string, number>;
}> {
  return {
    freeDiskBytes: await freeDiskBytes(diskPath ?? os.tmpdir()),
    swapUsedBytes: await swapUsedBytes(),
    freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(),
    listeners: await readListeners(),
  };
}
