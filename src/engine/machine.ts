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
/**
 * MEMORY THAT IS ACTUALLY AVAILABLE TO A NEW ALLOCATION, which on macOS is not `os.freemem()`.
 *
 * THE DEFECT THIS CORRECTS. `os.freemem()` returns Mach's "pages free" and nothing else. On Darwin
 * that number stays near zero on a healthy machine BY DESIGN: the kernel keeps recently-used pages
 * on the INACTIVE list rather than returning them to the free pool, and hands them to the next
 * allocation that asks. A Mac mini with 32 GiB, 16 GiB of it immediately reclaimable and no memory
 * pressure whatsoever, reports 4.7% free — and a 5% floor then aborts a campaign for a shortage
 * that does not exist. That is a guard measuring the wrong quantity, not a machine running out.
 *
 * THIS DOES NOT LOOSEN THE FLOOR, and the distinction matters. The floor stays exactly where it was
 * set; what changes is that "free memory" starts meaning, on this platform, what the platform means
 * by it. A guard whose reading is wrong is not a strict guard — it is a guard that fires on the
 * wrong events and teaches its operator to route around it, which is the failure mode a safety floor
 * can least afford.
 *
 * WHAT IS SUMMED, AND WHAT IS DELIBERATELY NOT. free + inactive + speculative. Purgeable pages are
 * NOT added: they are already counted within the active and inactive lists, and adding them would
 * double-count reclaimable memory and overstate the figure — an error in the dangerous direction for
 * a floor. Wired and active pages are not available and are never counted.
 *
 * EVERY OTHER PLATFORM IS UNTOUCHED. Linux's `MemAvailable` would be the equivalent correction
 * there; it is not made here because nothing has measured it on Linux, and a correction written from
 * reasoning rather than observation is how the first defect arrived.
 */
export async function availableMemoryBytes(): Promise<number> {
  if (process.platform !== 'darwin') return os.freemem();

  const out = await run('vm_stat', []);
  if (out === undefined) return os.freemem();

  // The page size is read from vm_stat's own header rather than assumed to be 4096: Apple Silicon
  // reports 16384 on some configurations, and a hardcoded 4096 would understate available memory by
  // a factor of four — which is exactly the direction that causes the spurious abort again.
  const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
  const pages = (label: string): number | undefined => {
    const match = new RegExp(`Pages ${label}:\\s+(\\d+)`).exec(out);
    return match ? Number(match[1]) : undefined;
  };

  const free = pages('free');
  const inactive = pages('inactive');
  const speculative = pages('speculative');
  // A vm_stat that parsed but did not carry the fields this depends on is not interpreted. Falling
  // back to `os.freemem()` reports a real, merely narrower, number — the module's posture for a
  // figure it cannot read, and the conservative direction for a floor.
  if (free === undefined || inactive === undefined) return os.freemem();

  return (free + inactive + (speculative ?? 0)) * pageSize;
}

export async function readMachine(diskPath?: string): Promise<{
  freeDiskBytes: number; swapUsedBytes: number; freeMemoryBytes: number; totalMemoryBytes: number;
  listeners: Record<string, number>;
}> {
  return {
    freeDiskBytes: await freeDiskBytes(diskPath ?? os.tmpdir()),
    swapUsedBytes: await swapUsedBytes(),
    freeMemoryBytes: await availableMemoryBytes(),
    totalMemoryBytes: os.totalmem(),
    listeners: await readListeners(),
  };
}
