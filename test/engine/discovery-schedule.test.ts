// Cernum · `discovery-schedule`, a GENERATED recurring-discovery schedule that is never installed.
//
// What is pinned here is the generated TEXT: the launchd plist starts the guard once a day at the start
// of the quiet-hours window; the guard checks the window, a free-space floor on / that defaults to and
// can never go below 6 GiB, macOS memory pressure and the discovery lock, and refuses with a logged
// reason on each; and nothing anywhere installs, loads or enables it.
//
// NOTHING HERE RUNS THE GUARD OR TOUCHES launchd. Every file lands in a temporary directory, the home
// directory the CLI sees is a temporary one, and a fake `launchctl` first on PATH records any
// invocation so that an accidental one would fail the assertion that there were none.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commandSpec } from '../../src/cli/command-spec';
import {
  DISCOVERY_SCHEDULE_DEFAULT_FLOOR_GIB, DISCOVERY_SCHEDULE_GUARD_FILE, DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB,
  DISCOVERY_SCHEDULE_NOT_INSTALLED, DISCOVERY_SCHEDULE_REFUSAL_CODES, DiscoveryScheduleError, DiscoveryScheduleOptions,
  generateDiscoverySchedule, launchdJobDirectories, parseDiscoveryWindow, writeDiscoverySchedule,
} from '../../src/engine/discovery-schedule';

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix = 'cernum-discovery-schedule-'): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaries.push(directory);
  return directory;
}

/** Every file under a directory, relative to it. */
function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => fs.statSync(path.join(directory, entry)).isFile()).sort();
}

const BASE: DiscoveryScheduleOptions = {
  root: '/fixture/campaigns', cernum: '/fixture/bin/cernum', directory: '/fixture/schedule',
};

function generate(overrides: Partial<DiscoveryScheduleOptions> = {}) {
  return generateDiscoverySchedule({ ...BASE, ...overrides });
}

describe('(1) the interval: once a day, at the start of the quiet-hours window', () => {
  it('defaults the window to 02:00-05:00 local and starts the guard at 02:00 every day', () => {
    const schedule = generate();
    expect(schedule.window).toEqual({ start: 120, end: 300, text: '02:00-05:00' });
    // ONE calendar entry, naming only an hour and a minute: launchd reads that as every day.
    expect(schedule.plist.match(/<key>StartCalendarInterval<\/key>/g)).toHaveLength(1);
    expect(schedule.plist).toContain([
      '  <key>StartCalendarInterval</key>', '  <dict>',
      '    <key>Hour</key>', '    <integer>2</integer>', '    <key>Minute</key>', '    <integer>0</integer>',
      '  </dict>',
    ].join('\n'));
    for (const absent of ['Weekday', 'Day</key>', 'Month', 'StartInterval<', 'KeepAlive', 'WatchPaths', 'QueueDirectories']) {
      expect(schedule.plist, absent).not.toContain(absent);
    }
    // Loading it would not run it on the spot either.
    expect(schedule.plist).toContain('<key>RunAtLoad</key>\n  <false/>');
  });

  it('runs the guard through zsh, as a low-priority background job, with a system-only PATH', () => {
    const schedule = generate();
    expect(schedule.guardPath).toBe(path.join('/fixture/schedule', DISCOVERY_SCHEDULE_GUARD_FILE));
    expect(schedule.plist).toContain(`<key>ProgramArguments</key>\n  <array>\n    <string>/bin/zsh</string>\n    <string>${schedule.guardPath}</string>\n  </array>`);
    expect(schedule.plist).toContain('<key>ProcessType</key>\n  <string>Background</string>');
    expect(schedule.plist).toContain('<key>LowPriorityIO</key>\n  <true/>');
    expect(schedule.plist).toContain('<key>PATH</key>\n    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>');
    expect(schedule.plist).toContain(`<key>StandardOutPath</key>\n  <string>${schedule.logPath}</string>`);
    expect(schedule.plist).toContain(`<key>StandardErrorPath</key>\n  <string>${schedule.logPath}</string>`);
    expect(schedule.plist).toContain('<key>Label</key>\n  <string>com.cernum.discovery-run</string>');
    expect(schedule.plistFileName).toBe('com.cernum.discovery-run.plist');
  });

  it('starts at the start of a named window, and the guard handles one that wraps past midnight', () => {
    const schedule = generate({ window: '23:30-01:15' });
    expect(schedule.plist).toContain('<key>Hour</key>\n    <integer>23</integer>\n    <key>Minute</key>\n    <integer>30</integer>');
    expect(schedule.script).toContain('readonly WINDOW_START_MINUTE=1410   # 23:30 local');
    expect(schedule.script).toContain('readonly WINDOW_END_MINUTE=75   # 01:15 local, exclusive');
    // Both branches are always generated; which one runs is decided by the numbers above.
    expect(schedule.script).toContain('(( now_minute >= WINDOW_START_MINUTE && now_minute < WINDOW_END_MINUTE ))');
    expect(schedule.script).toContain('(( now_minute >= WINDOW_START_MINUTE || now_minute < WINDOW_END_MINUTE ))');
  });

  it('refuses a window it cannot read, or one that is empty', () => {
    for (const bad of ['2-5', '02:00', '24:00-05:00', '02:60-05:00', '02:00-02:00', '']) {
      expect(() => parseDiscoveryWindow(bad), bad).toThrow(DiscoveryScheduleError);
    }
  });
});

describe('(2) the free-space floor: 6 GiB by default, and never below 6 GiB', () => {
  it('defaults to 6 GiB, which is also the minimum', () => {
    expect(DISCOVERY_SCHEDULE_DEFAULT_FLOOR_GIB).toBe(6);
    expect(DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB).toBe(6);
    const schedule = generate();
    expect(schedule.floorGiB).toBe(6);
    expect(schedule.script).toContain('readonly FLOOR_GIB=6\n');
    expect(schedule.script).toContain('readonly MINIMUM_FLOOR_GIB=6\n');
  });

  it('accepts a higher floor, and refuses to generate one below 6 GiB or one that is not whole', () => {
    expect(generate({ floorGiB: 6 }).floorGiB).toBe(6);
    expect(generate({ floorGiB: 20 }).script).toContain('readonly FLOOR_GIB=20\n');
    for (const bad of [5, 0, -6, 5.9, 6.5, Number.NaN]) {
      expect(() => generate({ floorGiB: bad }), String(bad)).toThrow(/at least 6/);
    }
  });

  it('measures / in KiB and re-checks the minimum itself, so a hand edit below 6 GiB is refused at run time', () => {
    const { script } = generate();
    expect(script).toContain('df -Pk /');
    expect(script).toContain('floor_kib=$(( FLOOR_GIB * 1024 * 1024 ))');
    expect(script).toContain('(( available_kib >= floor_kib ))');
    expect(script).toMatch(/\(\( FLOOR_GIB >= MINIMUM_FLOOR_GIB \)\) \\\n {2}\|\| refuse 14 /);
  });
});

describe('(3) every refusal is logged with its reason and starts nothing', () => {
  const { script } = generate();
  const codes = DISCOVERY_SCHEDULE_REFUSAL_CODES;

  it('logs before it exits, with a timestamp, saying discovery-run was not started', () => {
    expect(script).toContain('log() { print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) cernum discovery-schedule guard: $*"; }');
    expect(script).toContain('refuse() { local code=$1; shift; log "REFUSED, discovery-run not started: $*"; exit $code; }');
  });

  it('refuses outside the quiet-hours window', () => {
    expect(script).toContain(`(( inside )) || refuse ${codes.outsideWindow} "it is \${hour}:\${minute} local, outside the quiet-hours window 02:00-05:00"`);
  });

  it('refuses when / has less free than the floor', () => {
    expect(script).toContain(`|| refuse ${codes.diskBelowFloor} "\${available_kib} KiB free on /, under the floor of \${FLOOR_GIB} GiB`);
  });

  it('refuses when macOS memory pressure is critical (level 4)', () => {
    expect(script).toContain('pressure=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)');
    expect(script).toContain(`(( pressure < 4 )) || refuse ${codes.memoryPressureCritical} "macOS memory pressure is critical`);
  });

  it('refuses when the discovery lock file names a live process, or no process at all', () => {
    const schedule = generate();
    expect(schedule.lockFile).toBe('/fixture/campaigns/.discovery-run/campaign.lock');
    expect(script).toContain("readonly LOCK_FILE='/fixture/campaigns/.discovery-run/campaign.lock'");
    expect(script).toContain(`ps -p $lock_pid >/dev/null 2>&1 && refuse ${codes.lockHeld} "another discovery run holds $LOCK_FILE (pid $lock_pid)"`);
    expect(script).toContain(`refuse ${codes.lockHeld} "the lock file $LOCK_FILE exists and names no process this guard can read"`);
  });

  it('refuses, rather than passes, a check it cannot read', () => {
    for (const unreadable of ['could not read the local time', 'could not read the free space on / from df',
      'could not read macOS memory pressure', 'is not an executable']) {
      expect(script).toMatch(new RegExp(`refuse ${codes.cannotTell} "[^"]*${unreadable.replace(/[/]/g, '\\/')}`));
    }
  });

  it('gives each reason its own exit code', () => {
    expect(new Set(Object.values(codes)).size).toBe(Object.values(codes).length);
    for (const code of Object.values(codes)) expect(code).toBeGreaterThan(4); // 4 is discovery-run's own lock refusal
  });

  it('starts discovery-run once, only after every check, against the generated root', () => {
    const run = script.indexOf('"$CERNUM" discovery-run --json --root "$CAMPAIGN_ROOT" "${PROVIDERS[@]}"');
    expect(run).toBeGreaterThan(0);
    expect(script.indexOf('discovery-run --json')).toBe(script.lastIndexOf('discovery-run --json'));
    for (const check of ['(( inside ))', '(( available_kib >= floor_kib ))', '(( pressure < 4 ))', 'if [[ -e $LOCK_FILE ]]', '[[ -x $CERNUM ]]']) {
      const at = script.indexOf(check);
      expect(at, check).toBeGreaterThan(0);
      expect(at, check).toBeLessThan(run);
    }
    expect(script).toContain("readonly CERNUM='/fixture/bin/cernum'");
    expect(script).toContain("readonly CAMPAIGN_ROOT='/fixture/campaigns'");
    expect(script).toContain('readonly -a PROVIDERS=()');
    expect(generate({ providers: ['ollama', 'claudeCLI'] }).script).toContain("readonly -a PROVIDERS=('ollama' 'claudeCLI')");
  });
});

describe('(4) nothing is installed, loaded or enabled', () => {
  it('says so in both files and never names launchctl', () => {
    const schedule = generate();
    expect(DISCOVERY_SCHEDULE_NOT_INSTALLED).toContain('separate human act');
    for (const text of [schedule.plist, schedule.script]) {
      expect(text).toContain(DISCOVERY_SCHEDULE_NOT_INSTALLED);
      expect(text).not.toMatch(/launchctl/i);
      expect(text).not.toContain('LaunchAgents');
    }
    // An XML comment may not contain a double hyphen; the note is in one.
    const comment = /<!--([\s\S]*?)-->/.exec(schedule.plist)![1];
    expect(comment).not.toContain('--');
  });

  it('starts no process: the generator imports nothing that could', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'src', 'engine', 'discovery-schedule.ts'), 'utf8');
    expect(source).not.toMatch(/child_process|execSync|spawn\(|execFile/);
    expect(source).not.toMatch(/['"`]launchctl/);
  });

  it('declares the command as writing local files only, never as spending', () => {
    expect(commandSpec('discovery-schedule')?.effect).toBe('writesLocal');
  });
});

describe('(5) writing refuses every directory launchd reads jobs from', () => {
  it('writes the two files into the directory named, guard executable, plist not', () => {
    const home = temporary();
    const out = path.join(temporary(), 'schedule');
    const schedule = generate({ directory: out });
    const written = writeDiscoverySchedule(schedule, home);
    expect(written).toEqual({ guardPath: path.join(out, DISCOVERY_SCHEDULE_GUARD_FILE), plistPath: path.join(out, 'com.cernum.discovery-run.plist') });
    expect(fs.readFileSync(written.guardPath, 'utf8')).toBe(schedule.script);
    expect(fs.readFileSync(written.plistPath, 'utf8')).toBe(schedule.plist);
    expect(fs.statSync(written.guardPath).mode & 0o111).not.toBe(0);
    expect(fs.statSync(written.plistPath).mode & 0o111).toBe(0);
    expect(filesUnder(home)).toEqual([]);
  });

  it('refuses ~/Library/LaunchAgents and anything under it, writing nothing', () => {
    const home = temporary();
    const agents = path.join(home, 'Library', 'LaunchAgents');
    for (const out of [agents, path.join(agents, 'cernum'), path.join(agents, '..', 'LaunchAgents')]) {
      expect(() => writeDiscoverySchedule(generate({ directory: out }), home), out).toThrow(/launchd reads jobs from/);
    }
    expect(fs.existsSync(agents)).toBe(false);
    expect(filesUnder(home)).toEqual([]);
  });

  it('refuses a directory that reaches LaunchAgents through a symbolic link', () => {
    const home = temporary();
    const agents = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(agents, { recursive: true });
    const elsewhere = temporary();
    const link = path.join(elsewhere, 'looks-harmless');
    fs.symlinkSync(agents, link);
    expect(() => writeDiscoverySchedule(generate({ directory: link }), home)).toThrow(/launchd reads jobs from/);
    expect(() => writeDiscoverySchedule(generate({ directory: path.join(link, 'deeper') }), home)).toThrow(/launchd reads jobs from/);
    expect(filesUnder(agents)).toEqual([]);
  });

  it('names the system job directories as refused too', () => {
    expect(launchdJobDirectories('/Users/fixture')).toEqual([
      '/Users/fixture/Library/LaunchAgents', '/Library/LaunchAgents', '/Library/LaunchDaemons',
      '/System/Library/LaunchAgents', '/System/Library/LaunchDaemons',
    ]);
    expect(() => writeDiscoverySchedule(generate({ directory: '/Library/LaunchDaemons' }), temporary())).toThrow(/launchd reads jobs from/);
  });

  it('never overwrites a file that is already there', () => {
    const out = temporary();
    fs.writeFileSync(path.join(out, 'com.cernum.discovery-run.plist'), 'a person put this here');
    expect(() => writeDiscoverySchedule(generate({ directory: out }), temporary())).toThrow(/refusing to overwrite/);
    expect(fs.readFileSync(path.join(out, 'com.cernum.discovery-run.plist'), 'utf8')).toBe('a person put this here');
    expect(fs.existsSync(path.join(out, DISCOVERY_SCHEDULE_GUARD_FILE))).toBe(false);
  });
});

describe('(6) what the generated files embed is quoted, absolute and checked', () => {
  it('single-quotes paths for zsh and escapes them for XML', () => {
    const schedule = generate({ root: "/fixture/it's & <here>", directory: '/fixture/a & b' });
    expect(schedule.script).toContain(`readonly CAMPAIGN_ROOT='/fixture/it'\\''s & <here>'`);
    expect(schedule.plist).toContain('<string>/fixture/a &amp; b/discovery-schedule-guard.zsh</string>');
    expect(schedule.plist).not.toContain('a & b');
  });

  it('refuses relative paths, control characters, odd labels and provider names that are not names', () => {
    expect(() => generate({ root: 'campaigns' })).toThrow(/absolute/);
    expect(() => generate({ cernum: 'cernum' })).toThrow(/absolute/);
    expect(() => generate({ directory: '/fixture/a\nb' })).toThrow(/control character/);
    expect(() => generate({ label: 'com.cernum;x' })).toThrow(/label/);
    expect(() => generate({ providers: ['ollama; rm -rf /'] })).toThrow(/not a provider name/);
  });
});

// ------------------------------------------------------------------ the command, in a subprocess

function cernum(args: string[], home: string, fakeBin: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // tsx directly rather than through npx, so nothing but the command itself can write under HOME.
    const repository = path.resolve(__dirname, '..', '..');
    const child = spawn(path.join(repository, 'node_modules', '.bin', 'tsx'), ['src/cli/cernum.ts', 'discovery-schedule', ...args], {
      cwd: repository,
      env: { ...process.env, HOME: home, PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin` },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

/** A `launchctl` that records being called. It must never be. */
function fakeLaunchctl(): string {
  const bin = temporary('cernum-discovery-schedule-bin-');
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/sh\necho "$@" >> "${bin}/launchctl.invocations"\n`, { mode: 0o755 });
  return bin;
}

describe('(7) `cernum discovery-schedule` generates and says it installed nothing', () => {
  it('prints both files and writes nothing when no --out is named', async () => {
    const home = temporary();
    const root = temporary();
    const bin = fakeLaunchctl();
    const result = await cernum(['--root', root, '--cernum', '/fixture/bin/cernum'], home, bin);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('<key>StartCalendarInterval</key>');
    expect(result.stdout).toContain('readonly FLOOR_GIB=6');
    expect(result.stdout).toContain(DISCOVERY_SCHEDULE_NOT_INSTALLED);
    expect(filesUnder(root)).toEqual([]);
    expect(filesUnder(home)).toEqual([]);
    expect(fs.existsSync(path.join(bin, 'launchctl.invocations'))).toBe(false);
  }, 120_000);

  it('writes into --out, and nowhere under ~/Library/LaunchAgents', async () => {
    const home = temporary();
    const root = temporary();
    const out = path.join(temporary(), 'schedule');
    const bin = fakeLaunchctl();
    const result = await cernum(['--root', root, '--cernum', '/fixture/bin/cernum', '--out', out,
      '--window', '01:00-04:30', '--floor-gib', '10', 'ollama'], home, bin);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(DISCOVERY_SCHEDULE_NOT_INSTALLED);
    expect(filesUnder(out)).toEqual(['com.cernum.discovery-run.plist', DISCOVERY_SCHEDULE_GUARD_FILE]);
    const script = fs.readFileSync(path.join(out, DISCOVERY_SCHEDULE_GUARD_FILE), 'utf8');
    expect(script).toContain('readonly FLOOR_GIB=10\n');
    expect(script).toContain('readonly WINDOW_START_MINUTE=60 ');
    expect(script).toContain("readonly -a PROVIDERS=('ollama')");
    expect(script).toContain(`readonly LOCK_FILE='${path.join(root, '.discovery-run', 'campaign.lock')}'`);
    expect(filesUnder(home)).toEqual([]);
    expect(fs.existsSync(path.join(bin, 'launchctl.invocations'))).toBe(false);
  }, 120_000);

  it('refuses --out under the home directory\'s LaunchAgents, and a floor below 6 GiB, writing nothing', async () => {
    const home = temporary();
    const root = temporary();
    const bin = fakeLaunchctl();
    const agents = await cernum(['--root', root, '--out', path.join(home, 'Library', 'LaunchAgents')], home, bin);
    expect(agents.status).toBe(2);
    expect(agents.stderr).toContain('launchd reads jobs from');
    const low = await cernum(['--root', root, '--out', path.join(temporary(), 'schedule'), '--floor-gib', '5'], home, bin);
    expect(low.status).toBe(2);
    expect(low.stderr).toContain('at least 6');
    expect(filesUnder(home)).toEqual([]);
    expect(filesUnder(root)).toEqual([]);
    expect(fs.existsSync(path.join(bin, 'launchctl.invocations'))).toBe(false);
  }, 120_000);
});
