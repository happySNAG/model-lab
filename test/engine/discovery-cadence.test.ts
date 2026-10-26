// Cernum · discovery cadence cds2: two GENERATED launchd jobs, a light provider listing every 6 hours
// and a nightly full reconciliation in quiet hours, that are never installed.
//
// What is pinned here: the two plists and their triggers; the 6 GiB floor, its minimum and its run-time
// re-check; the memory-pressure guard; the quiet-hours window on the nightly job only; the capped
// exponential rate-limit backoff; that nothing installs, loads or enables either job; and that cds1's
// output is byte-identical to the golden recorded before cds2 was added
// (fixtures/discovery-schedule/cds1).
//
// THE GUARDS ARE RUN, BUT ONLY AGAINST FAKES. Section (6) executes the generated zsh with a temporary
// directory first on PATH holding fake `date`, `df` and `sysctl`, and a fake `cernum` that prints a
// canned discovery-run summary and records its arguments. Nothing reaches launchd, a provider, a model
// or the network, and every file lands in a temporary directory.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOGUE_PROVIDERS } from '../../src/engine/catalogue-discovery';
import {
  DISCOVERY_CADENCE_BACKOFF_FILE, DISCOVERY_CADENCE_DEFAULT_BACKOFF, DISCOVERY_CADENCE_DEFAULT_LISTING_PROVIDERS,
  DISCOVERY_CADENCE_LISTING_INTERVAL_SECONDS, DISCOVERY_CADENCE_MAXIMUM_BACKOFF_CAP_MINUTES,
  DISCOVERY_CADENCE_MEMORY_PRESSURE_REFUSE_AT, DISCOVERY_CADENCE_REFUSAL_CODES, DISCOVERY_CADENCE_SCHEMA,
  DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB, DISCOVERY_SCHEDULE_NOT_INSTALLED, DISCOVERY_SCHEDULE_REFUSAL_CODES,
  DiscoveryCadenceOptions, DiscoveryScheduleError, DiscoveryScheduleOptions, generateDiscoveryCadence,
  generateDiscoverySchedule, writeDiscoveryCadence,
} from '../../src/engine/discovery-schedule';

const REPOSITORY = path.resolve(__dirname, '..', '..');
const GOLDEN = path.join(REPOSITORY, 'fixtures', 'discovery-schedule', 'cds1');

const temporaries: string[] = [];
afterEach(() => { for (const directory of temporaries.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
function temporary(prefix = 'cernum-discovery-cadence-'): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaries.push(directory);
  return directory;
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((entry) => fs.statSync(path.join(directory, entry)).isFile()).sort();
}

const BASE: DiscoveryCadenceOptions = {
  root: '/fixture/campaigns', cernum: '/fixture/bin/cernum', directory: '/fixture/schedule',
};

function cadence(overrides: Partial<DiscoveryCadenceOptions> = {}) {
  return generateDiscoveryCadence({ ...BASE, ...overrides });
}

describe('(1) cds1 is unchanged: byte-identical to the golden recorded before cds2', () => {
  const cases: Record<string, DiscoveryScheduleOptions> = {
    default: { root: '/fixture/campaigns', cernum: '/fixture/bin/cernum', directory: '/fixture/schedule' },
    named: {
      root: "/fixture/it's & <here>", cernum: '/fixture/bin/cernum', directory: '/fixture/a & b',
      window: '23:30-01:15', floorGiB: 20, label: 'org.example.discovery', providers: ['ollama', 'claudeCLI'],
    },
  };
  for (const [name, options] of Object.entries(cases)) {
    it(`the ${name} plist and guard match fixtures/discovery-schedule/cds1/${name}.*`, () => {
      const schedule = generateDiscoverySchedule(options);
      expect(schedule.schema).toBe('cds1');
      expect(Buffer.from(schedule.plist)).toEqual(fs.readFileSync(path.join(GOLDEN, `${name}.plist`)));
      expect(Buffer.from(schedule.script)).toEqual(fs.readFileSync(path.join(GOLDEN, `${name}.guard.zsh`)));
    });
  }

  it('keeps cds1 refusal codes as they were', () => {
    expect(DISCOVERY_SCHEDULE_REFUSAL_CODES).toEqual({
      outsideWindow: 10, diskBelowFloor: 11, memoryPressureCritical: 12, lockHeld: 13, cannotTell: 14,
    });
  });
});

describe('(2) cds2 generates two jobs: a light listing every 6 hours and a nightly full reconciliation', () => {
  it('is schema cds2, listing first, reconciliation second, each with its own label, guard and log', () => {
    const generated = cadence();
    expect(generated.schema).toBe(DISCOVERY_CADENCE_SCHEMA);
    expect(DISCOVERY_CADENCE_SCHEMA).toBe('cds2');
    expect(generated.jobs.map((job) => job.kind)).toEqual(['listing', 'reconciliation']);
    const [listing, reconciliation] = generated.jobs;
    expect(listing.label).toBe('com.cernum.discovery.listing');
    expect(reconciliation.label).toBe('com.cernum.discovery.reconciliation');
    expect(listing.plistFileName).toBe('com.cernum.discovery.listing.plist');
    expect(listing.guardPath).toBe('/fixture/schedule/discovery-cadence-listing-guard.zsh');
    expect(reconciliation.guardPath).toBe('/fixture/schedule/discovery-cadence-reconciliation-guard.zsh');
    expect(listing.logPath).not.toBe(reconciliation.logPath);
    for (const job of generated.jobs) {
      expect(job.plist).toContain(`<key>Label</key>\n  <string>${job.label}</string>`);
      expect(job.plist).toContain(`<key>ProgramArguments</key>\n  <array>\n    <string>/bin/zsh</string>\n    <string>${job.guardPath}</string>\n  </array>`);
      expect(job.plist).toContain('<key>RunAtLoad</key>\n  <false/>');
      expect(job.plist).toContain('<key>ProcessType</key>\n  <string>Background</string>');
      expect(job.plist).toContain('<key>LowPriorityIO</key>\n  <true/>');
      expect(job.plist).toContain('<key>PATH</key>\n    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>');
      for (const absent of ['KeepAlive', 'WatchPaths', 'QueueDirectories', 'Weekday', 'Month']) expect(job.plist, absent).not.toContain(absent);
    }
  });

  it('starts the light listing every 6 hours, by interval, with no calendar entry', () => {
    const [listing] = cadence().jobs;
    expect(DISCOVERY_CADENCE_LISTING_INTERVAL_SECONDS).toBe(21600);
    expect(listing.trigger).toEqual({ every: 'interval', seconds: 21600 });
    expect(listing.plist).toContain('  <key>StartInterval</key>\n  <integer>21600</integer>');
    expect(listing.plist).not.toContain('StartCalendarInterval');
  });

  it('asks the catalogue providers in the listing, and every provider in the reconciliation', () => {
    const [listing, reconciliation] = cadence().jobs;
    expect([...DISCOVERY_CADENCE_DEFAULT_LISTING_PROVIDERS]).toEqual([...CATALOGUE_PROVIDERS]);
    expect(listing.providers).toEqual(['anthropicAPI', 'claudeCLI', 'codexCLI']);
    expect(listing.script).toContain("readonly -a PROVIDERS=('anthropicAPI' 'claudeCLI' 'codexCLI')");
    expect(reconciliation.providers).toEqual([]);
    expect(reconciliation.script).toContain('readonly -a PROVIDERS=()');
    const named = cadence({ listingProviders: ['codexCLI'], reconciliationProviders: ['ollama', 'codexCLI'] });
    expect(named.jobs[0].script).toContain("readonly -a PROVIDERS=('codexCLI')");
    expect(named.jobs[1].script).toContain("readonly -a PROVIDERS=('ollama' 'codexCLI')");
    expect(() => cadence({ listingProviders: [] })).toThrow(/at least one provider/);
    expect(() => cadence({ listingProviders: ['codexCLI; rm -rf /'] })).toThrow(/not a provider name/);
  });

  it('starts the reconciliation once a day at the start of the quiet-hours window, and checks the window', () => {
    const [, reconciliation] = cadence().jobs;
    expect(reconciliation.trigger).toEqual({ every: 'day', hour: 2, minute: 0 });
    expect(reconciliation.plist.match(/<key>StartCalendarInterval<\/key>/g)).toHaveLength(1);
    expect(reconciliation.plist).toContain('<key>Hour</key>\n    <integer>2</integer>\n    <key>Minute</key>\n    <integer>0</integer>');
    expect(reconciliation.plist).not.toContain('StartInterval<');
    expect(reconciliation.quietHours).toBe(true);
    expect(reconciliation.script).toContain(`(( inside )) || refuse ${DISCOVERY_CADENCE_REFUSAL_CODES.outsideWindow} "it is \${hour}:\${minute} local, outside the quiet-hours window 02:00-05:00"`);
    const wrapped = cadence({ window: '23:30-01:15' }).jobs[1];
    expect(wrapped.trigger).toEqual({ every: 'day', hour: 23, minute: 30 });
    expect(wrapped.script).toContain('readonly WINDOW_START_MINUTE=1410   # 23:30 local');
    expect(wrapped.script).toContain('readonly WINDOW_END_MINUTE=75   # 01:15 local, exclusive');
  });

  it('does not hold the light listing to the quiet-hours window', () => {
    const [listing] = cadence().jobs;
    expect(listing.quietHours).toBe(false);
    expect(listing.script).not.toContain('WINDOW_START_MINUTE');
    expect(listing.script).not.toContain('outside the quiet-hours window');
  });

  it('refuses a label prefix that is not reverse-DNS, and relative or control-character paths', () => {
    expect(cadence({ labelPrefix: 'org.example.d' }).jobs[1].label).toBe('org.example.d.reconciliation');
    for (const bad of ['org.example;x', '.org', 'org.']) expect(() => cadence({ labelPrefix: bad }), bad).toThrow(/label prefix/);
    expect(() => cadence({ root: 'campaigns' })).toThrow(/absolute/);
    expect(() => cadence({ directory: '/fixture/a\nb' })).toThrow(/control character/);
  });
});

describe('(3) the 6 GiB floor and the memory-pressure guard', () => {
  it('keeps the 6 GiB floor in both jobs: default, minimum, and re-checked at run time', () => {
    expect(DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB).toBe(6);
    const generated = cadence();
    expect(generated.floorGiB).toBe(6);
    for (const job of generated.jobs) {
      expect(job.script).toContain('readonly FLOOR_GIB=6\n');
      expect(job.script).toContain('readonly MINIMUM_FLOOR_GIB=6\n');
      expect(job.script).toContain('df -Pk /');
      expect(job.script).toContain('(( available_kib >= floor_kib ))');
      expect(job.script).toMatch(/\(\( FLOOR_GIB >= MINIMUM_FLOOR_GIB \)\) \\\n {2}\|\| refuse 14 /);
    }
    expect(cadence({ floorGiB: 20 }).jobs[0].script).toContain('readonly FLOOR_GIB=20\n');
    for (const bad of [5, 0, -6, 5.9, 6.5, Number.NaN]) {
      expect(() => cadence({ floorGiB: bad }), String(bad)).toThrow(/at least 6/);
    }
  });

  it('refuses the listing at critical pressure and the reconciliation already at warning', () => {
    expect(DISCOVERY_CADENCE_MEMORY_PRESSURE_REFUSE_AT).toEqual({ listing: 4, reconciliation: 2 });
    const [listing, reconciliation] = cadence().jobs;
    expect(listing.memoryPressureRefuseAt).toBe(4);
    expect(reconciliation.memoryPressureRefuseAt).toBe(2);
    expect(listing.script).toContain('readonly MEMORY_PRESSURE_REFUSE_AT=4 ');
    expect(reconciliation.script).toContain('readonly MEMORY_PRESSURE_REFUSE_AT=2 ');
    for (const job of [listing, reconciliation]) {
      expect(job.script).toContain('pressure=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)');
      expect(job.script).toContain(`(( pressure < MEMORY_PRESSURE_REFUSE_AT )) \\\n  || refuse ${DISCOVERY_CADENCE_REFUSAL_CODES.memoryPressure} `);
      expect(job.script).toContain('(( MEMORY_PRESSURE_REFUSE_AT >= 1 && MEMORY_PRESSURE_REFUSE_AT <= 4 ))');
    }
  });

  it('gives each refusal its own code, above discovery-run\'s own 4', () => {
    const codes = Object.values(DISCOVERY_CADENCE_REFUSAL_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toBeGreaterThan(4);
    expect(DISCOVERY_CADENCE_REFUSAL_CODES.rateLimitBackoff).toBe(15);
  });
});

describe('(4) rate-limit backoff: exponential, capped, shared by both jobs', () => {
  it('defaults to 30 minutes doubling to a cap of 24 hours, in one state file both jobs read', () => {
    expect(DISCOVERY_CADENCE_DEFAULT_BACKOFF).toEqual({ baseMinutes: 30, capMinutes: 1440 });
    const generated = cadence();
    expect(generated.backoff).toEqual({ baseMinutes: 30, capMinutes: 1440, statePath: path.join('/fixture/schedule', DISCOVERY_CADENCE_BACKOFF_FILE) });
    for (const job of generated.jobs) {
      expect(job.script).toContain(`readonly BACKOFF_FILE='/fixture/schedule/${DISCOVERY_CADENCE_BACKOFF_FILE}'`);
      expect(job.script).toContain('readonly BACKOFF_BASE_MINUTES=30\n');
      expect(job.script).toContain('readonly BACKOFF_CAP_MINUTES=1440\n');
      expect(job.script).toContain('(( delay > BACKOFF_CAP_MINUTES )) && delay=$BACKOFF_CAP_MINUTES');
    }
  });

  it('refuses a base or cap that is not whole, a base above its cap, and a cap past a week', () => {
    expect(cadence({ backoff: { baseMinutes: 5, capMinutes: 60 } }).backoff).toMatchObject({ baseMinutes: 5, capMinutes: 60 });
    expect(DISCOVERY_CADENCE_MAXIMUM_BACKOFF_CAP_MINUTES).toBe(10080);
    for (const backoff of [{ baseMinutes: 0 }, { baseMinutes: 1.5 }, { baseMinutes: 61, capMinutes: 60 },
      { capMinutes: 10081 }, { capMinutes: 0 }]) {
      expect(() => cadence({ backoff }), JSON.stringify(backoff)).toThrow(DiscoveryScheduleError);
    }
  });
});

describe('(5) nothing is installed, loaded or enabled', () => {
  it('says so in every file and never names launchctl or LaunchAgents', () => {
    for (const job of cadence().jobs) {
      for (const text of [job.plist, job.script]) {
        expect(text).toContain(DISCOVERY_SCHEDULE_NOT_INSTALLED);
        expect(text).not.toMatch(/launchctl/i);
        expect(text).not.toContain('LaunchAgents');
      }
      const comment = /<!--([\s\S]*?)-->/.exec(job.plist)![1];
      expect(comment).not.toContain('--');
    }
  });

  it('writes the four files into the directory named and nothing under the home directory', () => {
    const home = temporary();
    const out = path.join(temporary(), 'cadence');
    const generated = cadence({ directory: out });
    const written = writeDiscoveryCadence(generated, home);
    expect(written).toHaveLength(2);
    expect(filesUnder(out)).toEqual([
      'com.cernum.discovery.listing.plist', 'com.cernum.discovery.reconciliation.plist',
      'discovery-cadence-listing-guard.zsh', 'discovery-cadence-reconciliation-guard.zsh',
    ]);
    for (const [index, job] of generated.jobs.entries()) {
      expect(fs.readFileSync(written[index].plistPath, 'utf8')).toBe(job.plist);
      expect(fs.readFileSync(written[index].guardPath, 'utf8')).toBe(job.script);
      expect(fs.statSync(written[index].guardPath).mode & 0o111).not.toBe(0);
      expect(fs.statSync(written[index].plistPath).mode & 0o111).toBe(0);
    }
    expect(filesUnder(home)).toEqual([]);
  });

  it('refuses ~/Library/LaunchAgents, directly, beneath it and through a symbolic link, writing nothing', () => {
    const home = temporary();
    const agents = path.join(home, 'Library', 'LaunchAgents');
    for (const out of [agents, path.join(agents, 'cernum')]) {
      expect(() => writeDiscoveryCadence(cadence({ directory: out }), home), out).toThrow(/launchd reads jobs from/);
    }
    expect(fs.existsSync(agents)).toBe(false);
    fs.mkdirSync(agents, { recursive: true });
    const link = path.join(temporary(), 'looks-harmless');
    fs.symlinkSync(agents, link);
    expect(() => writeDiscoveryCadence(cadence({ directory: link }), home)).toThrow(/launchd reads jobs from/);
    expect(filesUnder(agents)).toEqual([]);
    expect(() => writeDiscoveryCadence(cadence({ directory: '/Library/LaunchDaemons' }), temporary())).toThrow(/launchd reads jobs from/);
  });

  it('never overwrites, and writes none of the four when any one is already there', () => {
    const out = temporary();
    fs.writeFileSync(path.join(out, 'com.cernum.discovery.reconciliation.plist'), 'a person put this here');
    expect(() => writeDiscoveryCadence(cadence({ directory: out }), temporary())).toThrow(/refusing to overwrite/);
    expect(filesUnder(out)).toEqual(['com.cernum.discovery.reconciliation.plist']);
    expect(fs.readFileSync(path.join(out, 'com.cernum.discovery.reconciliation.plist'), 'utf8')).toBe('a person put this here');
  });

  it('starts no process: the generator imports nothing that could', () => {
    const source = fs.readFileSync(path.join(REPOSITORY, 'src', 'engine', 'discovery-schedule.ts'), 'utf8');
    expect(source).not.toMatch(/child_process|execSync|spawn\(|execFile/);
    expect(source).not.toMatch(/['"`]launchctl/);
    expect(source).not.toMatch(/from '\.\/catalogue-discovery'/);
  });
});

// ------------------------------------------------------------------ the guards, run against fakes only

interface World {
  epoch: number; hour: string; minute: string; availableKiB: number; pressure: string;
  summary: string; status?: number;
}

const QUIET: Omit<World, 'summary'> = { epoch: 1_800_000_000, hour: '02', minute: '30', availableKiB: 50 * 1024 * 1024, pressure: '1' };
const CLEAN = JSON.stringify({ schema: 'cdr1', command: 'discovery-run', status: 'completed', providersAnswered: ['codexCLI'], providersNotAnswered: [], routes: 3, changed: false });
const THROTTLED = JSON.stringify({
  schema: 'cdr1', command: 'discovery-run', status: 'completed', providersAnswered: ['claudeCLI'],
  providersNotAnswered: [{ provider: 'anthropicAPI', detail: 'HTTP 429 Too Many Requests' }], routes: 3, changed: false,
});

/** A directory of fakes for every outside tool the guards ask: the clock, the disk, the pressure, and cernum. */
function fakes(): { bin: string; cernum: string; calls: string } {
  const bin = temporary('cernum-discovery-cadence-bin-');
  const calls = path.join(bin, 'cernum.calls');
  const script = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  script('date', [
    'for argument in "$@"; do last="$argument"; done',
    'case "$last" in',
    '  +%H) echo "$FAKE_HOUR" ;;',
    '  +%M) echo "$FAKE_MINUTE" ;;',
    '  +%s) echo "$FAKE_EPOCH" ;;',
    '  *) echo "2027-01-15T02:30:00Z" ;;',
    'esac',
  ].join('\n'));
  script('df', 'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/disk3s1 900000000 1 $FAKE_AVAILABLE_KIB 1% /"');
  script('sysctl', 'echo "$FAKE_PRESSURE"');
  script('launchctl', `echo "$@" >> "${bin}/launchctl.invocations"`);
  const cernum = path.join(bin, 'cernum');
  script('cernum', `echo "$@" >> "${calls}"\nprintf '%s\\n' "$FAKE_SUMMARY"\nexit "\${FAKE_STATUS:-0}"`);
  return { bin, cernum, calls };
}

function runGuard(guardPath: string, bin: string, world: World): { status: number | null; output: string } {
  const result = spawnSync('/bin/zsh', [guardPath], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`, HOME: temporary(),
      FAKE_EPOCH: String(world.epoch), FAKE_HOUR: world.hour, FAKE_MINUTE: world.minute,
      FAKE_AVAILABLE_KIB: String(world.availableKiB), FAKE_PRESSURE: world.pressure,
      FAKE_SUMMARY: world.summary, FAKE_STATUS: String(world.status ?? 0),
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function setup(overrides: Partial<DiscoveryCadenceOptions> = {}) {
  const fake = fakes();
  const directory = temporary();
  const generated = cadence({ root: temporary(), cernum: fake.cernum, directory, ...overrides });
  writeDiscoveryCadence(generated, temporary());
  const [listing, reconciliation] = generated.jobs;
  const statePath = generated.backoff.statePath;
  const calls = () => (fs.existsSync(fake.calls) ? fs.readFileSync(fake.calls, 'utf8').trim().split('\n') : []);
  const state = () => (fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8').trim() : undefined);
  return { fake, generated, listing, reconciliation, statePath, calls, state };
}

const HAS_ZSH = fs.existsSync('/bin/zsh');
const codes = DISCOVERY_CADENCE_REFUSAL_CODES;

describe.runIf(HAS_ZSH)('(6) the generated guards, run against fakes', () => {
  it('runs the light listing over its providers, and the reconciliation over every provider, when every check passes', () => {
    const { fake, generated, listing, reconciliation, calls, state } = setup();
    expect(runGuard(listing.guardPath, fake.bin, { ...QUIET, summary: CLEAN }).status).toBe(0);
    expect(runGuard(reconciliation.guardPath, fake.bin, { ...QUIET, summary: CLEAN }).status).toBe(0);
    const root = generated.lockFile.replace(/\/\.discovery-run\/campaign\.lock$/, '');
    expect(calls()).toEqual([
      `discovery-run --json --root ${root} anthropicAPI claudeCLI codexCLI`,
      `discovery-run --json --root ${root}`,
    ]);
    expect(state()).toBeUndefined();
    expect(fs.existsSync(path.join(fake.bin, 'launchctl.invocations'))).toBe(false);
  }, 60_000);

  it('holds only the reconciliation to the quiet-hours window', () => {
    const { fake, listing, reconciliation, calls } = setup();
    const noon = { ...QUIET, hour: '12', minute: '00', summary: CLEAN };
    const refused = runGuard(reconciliation.guardPath, fake.bin, noon);
    expect(refused.status).toBe(codes.outsideWindow);
    expect(refused.output).toContain('outside the quiet-hours window 02:00-05:00');
    expect(runGuard(listing.guardPath, fake.bin, noon).status).toBe(0);
    expect(calls()).toHaveLength(1);
  }, 60_000);

  it('refuses either job under the 6 GiB floor, and starts nothing', () => {
    const { fake, listing, reconciliation, calls } = setup();
    const low = { ...QUIET, availableKiB: 6 * 1024 * 1024 - 1, summary: CLEAN };
    for (const job of [listing, reconciliation]) {
      const result = runGuard(job.guardPath, fake.bin, low);
      expect(result.status, job.kind).toBe(codes.diskBelowFloor);
      expect(result.output).toContain('under the floor of 6 GiB');
    }
    expect(runGuard(listing.guardPath, fake.bin, { ...low, availableKiB: 6 * 1024 * 1024 }).status).toBe(0);
    expect(calls()).toHaveLength(1);
  }, 60_000);

  it('applies the memory-pressure guard: warning stops the reconciliation, critical stops both, unreadable stops both', () => {
    const { fake, listing, reconciliation, calls } = setup();
    const warning = { ...QUIET, pressure: '2', summary: CLEAN };
    expect(runGuard(reconciliation.guardPath, fake.bin, warning).status).toBe(codes.memoryPressure);
    expect(runGuard(listing.guardPath, fake.bin, warning).status).toBe(0);
    for (const job of [listing, reconciliation]) {
      expect(runGuard(job.guardPath, fake.bin, { ...QUIET, pressure: '4', summary: CLEAN }).status, job.kind).toBe(codes.memoryPressure);
      expect(runGuard(job.guardPath, fake.bin, { ...QUIET, pressure: '', summary: CLEAN }).status, job.kind).toBe(codes.cannotTell);
    }
    expect(calls()).toHaveLength(1);
  }, 60_000);

  it('refuses while a live process holds the discovery lock', () => {
    const { fake, generated, listing, calls } = setup();
    fs.mkdirSync(path.dirname(generated.lockFile), { recursive: true });
    fs.writeFileSync(generated.lockFile, JSON.stringify({ pid: process.pid }));
    expect(runGuard(listing.guardPath, fake.bin, { ...QUIET, summary: CLEAN }).status).toBe(codes.lockHeld);
    expect(calls()).toEqual([]);
  }, 60_000);

  it('backs off exponentially after rate-limited runs, refuses inside the wait, and never waits past the cap', () => {
    const { fake, listing, reconciliation, calls, state } = setup({ backoff: { baseMinutes: 30, capMinutes: 240 } });
    let epoch = QUIET.epoch;
    const expectedDelays = [30, 60, 120, 240, 240, 240];
    for (const [index, delay] of expectedDelays.entries()) {
      const run = runGuard(listing.guardPath, fake.bin, { ...QUIET, epoch, summary: THROTTLED });
      expect(run.status, `run ${index + 1}`).toBe(0);
      expect(run.output).toContain(`backing off ${delay} minute(s) after ${index + 1} consecutive`);
      expect(state()).toBe(`consecutive=${index + 1} not_before=${epoch + delay * 60}`);
      // One second before the wait ends, BOTH jobs refuse: the backoff is shared.
      for (const job of [listing, reconciliation]) {
        const early = runGuard(job.guardPath, fake.bin, { ...QUIET, epoch: epoch + delay * 60 - 1, summary: CLEAN });
        expect(early.status, `${job.kind} after run ${index + 1}`).toBe(codes.rateLimitBackoff);
        expect(early.output).toContain('rate-limit backoff');
      }
      epoch += delay * 60;
    }
    expect(calls()).toHaveLength(expectedDelays.length);
    // A run that completes with no rate-limited provider clears the backoff.
    expect(runGuard(listing.guardPath, fake.bin, { ...QUIET, epoch, summary: CLEAN }).status).toBe(0);
    expect(state()).toBeUndefined();
    const fresh = runGuard(listing.guardPath, fake.bin, { ...QUIET, epoch, summary: THROTTLED });
    expect(fresh.output).toContain('backing off 30 minute(s) after 1 consecutive');
  }, 120_000);

  it('caps the default backoff at 24 hours however many runs were rate-limited', () => {
    const { fake, listing, statePath, state } = setup();
    fs.writeFileSync(statePath, `consecutive=40 not_before=${QUIET.epoch}\n`);
    const run = runGuard(listing.guardPath, fake.bin, { ...QUIET, summary: THROTTLED });
    expect(run.output).toContain('backing off 1440 minute(s) after 41 consecutive');
    expect(state()).toBe(`consecutive=41 not_before=${QUIET.epoch + 1440 * 60}`);
  }, 60_000);

  it('reads only the not-answered details: a marker elsewhere in the summary is not a rate limit', () => {
    const { fake, listing, state } = setup();
    const elsewhere = JSON.stringify({
      schema: 'cdr1', command: 'discovery-run', status: 'completed', providersNotAnswered: [],
      changes: [{ routeKey: 'codexCLI:quota-429-rate-limit', kinds: ['new'] }], routes: 429, changed: true,
    });
    expect(runGuard(listing.guardPath, fake.bin, { ...QUIET, summary: elsewhere }).status).toBe(0);
    expect(state()).toBeUndefined();
    const unrelated = JSON.stringify({ providersNotAnswered: [{ provider: 'codexCLI', detail: 'codex is not installed' }], routes: 429 });
    expect(runGuard(listing.guardPath, fake.bin, { ...QUIET, summary: unrelated }).status).toBe(0);
    expect(state()).toBeUndefined();
  }, 60_000);

  it('treats an unreadable backoff state as the longest wait, not as no wait', () => {
    const { fake, listing, statePath, calls, state } = setup();
    fs.writeFileSync(statePath, 'garbled');
    const run = runGuard(listing.guardPath, fake.bin, { ...QUIET, summary: CLEAN });
    expect(run.status).toBe(codes.rateLimitBackoff);
    expect(run.output).toContain('could not read the backoff state');
    expect(state()).toBe(`consecutive=0 not_before=${QUIET.epoch + 1440 * 60}`);
    expect(calls()).toEqual([]);
  }, 60_000);

  it('keeps the backoff when discovery-run itself fails, and passes its exit status through', () => {
    const { fake, listing, statePath, state } = setup();
    fs.writeFileSync(statePath, `consecutive=2 not_before=${QUIET.epoch}\n`);
    const run = runGuard(listing.guardPath, fake.bin, { ...QUIET, summary: CLEAN, status: 4 });
    expect(run.status).toBe(4);
    expect(state()).toBe(`consecutive=2 not_before=${QUIET.epoch}`);
  }, 60_000);
});
