// Benchmark engine · a GENERATED schedule for `discovery-run`, never an installed one.
//
// WHAT THIS PRODUCES. Two pieces of text: a launchd property list that would start a guard script once a
// day at the start of a quiet-hours window, and that zsh guard script, which runs `cernum discovery-run`
// once only when every check passes and otherwise logs why it refused:
//
//   QUIET HOURS    the local time is inside the window (default 02:00 to 05:00). launchd starts a
//                  calendar job that a sleeping Mac missed when it wakes, at whatever hour that is, so
//                  the window is checked by the guard and not left to the calendar entry.
//   FREE SPACE     the internal disk, `/`, has at least the floor free. The floor defaults to 6 GiB and
//                  can never be generated below 6 GiB; the guard re-checks the minimum itself, so a hand
//                  edit below it is refused at run time too.
//   MEMORY         macOS memory pressure is not critical (`kern.memorystatus_vm_pressure_level` 4).
//   OWNERSHIP      no live process holds discovery-run's lock file. A lock left by a process that is gone
//                  is logged and left to `discovery-run`, whose own lock decides whether to recover it.
//
// A check that cannot be read is a refusal, not a pass: a guard that cannot see the disk does not know
// the disk is fine.
//
// WHAT THIS NEVER DOES. It installs nothing, loads nothing, enables nothing and runs nothing. It does
// not spawn a process at all, and `writeDiscoverySchedule` refuses any directory launchd reads jobs
// from. Putting the plist where launchd will find it, and loading it, is a separate human act.
//
// TWO SCHEMAS. cds1 (`generateDiscoverySchedule`) is the single daily job above and its output is
// pinned byte for byte. cds2 (`generateDiscoveryCadence`, at the end of this file) generates a CADENCE
// of two jobs: a light provider listing every 6 hours and a nightly full reconciliation inside the
// quiet-hours window, each with the same floor and lock checks, a memory-pressure guard and a capped
// exponential backoff after a rate-limited run. It is generate-only in exactly the same way.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALLOWANCE_EXHAUSTION_MARKERS } from './attempt-disposition';
import { discoveryRunDirectory } from './discovery-run';
import { campaignLockPath } from './lock';

export const DISCOVERY_SCHEDULE_SCHEMA = 'cds1' as const;

/** The floor the guard is generated with when none is named, and the lowest it may ever be. */
export const DISCOVERY_SCHEDULE_DEFAULT_FLOOR_GIB = 6;
export const DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB = 6;
export const DISCOVERY_SCHEDULE_DEFAULT_WINDOW = '02:00-05:00';
export const DISCOVERY_SCHEDULE_DEFAULT_LABEL = 'com.cernum.discovery-run';
export const DISCOVERY_SCHEDULE_GUARD_FILE = 'discovery-schedule-guard.zsh';
export const DISCOVERY_SCHEDULE_LOG_FILE = 'discovery-schedule.log';

/** What the guard exits with when it refuses, one code per reason, so a log reader can tell them apart. */
export const DISCOVERY_SCHEDULE_REFUSAL_CODES = {
  outsideWindow: 10, diskBelowFloor: 11, memoryPressureCritical: 12, lockHeld: 13, cannotTell: 14,
} as const;

/** The sentence every generated file and every printed schedule carries. */
export const DISCOVERY_SCHEDULE_NOT_INSTALLED =
  'Nothing was installed, loaded or enabled. Installing this schedule is a separate human act.';

/** The PATH launchd gives the guard: system tools only. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export class DiscoveryScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryScheduleError';
  }
}

export interface DiscoveryScheduleOptions {
  /** The campaign root `discovery-run` uses; its lock file is under it. Absolute. */
  root: string;
  /** The `cernum` executable the guard runs. Absolute: launchd's PATH does not contain it. */
  cernum: string;
  /** The directory the guard script and its log will live in. Absolute. */
  directory: string;
  /** Local `HH:MM-HH:MM`, start inclusive, end exclusive. May wrap past midnight. */
  window?: string;
  /** Whole GiB that must be free on `/`. At least DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB. */
  floorGiB?: number;
  label?: string;
  /** Providers passed through to `discovery-run`; empty means every one it refreshes. */
  providers?: string[];
}

export interface DiscoverySchedule {
  schema: typeof DISCOVERY_SCHEDULE_SCHEMA;
  label: string;
  /** Minutes after local midnight. */
  window: { start: number; end: number; text: string };
  floorGiB: number;
  lockFile: string;
  guardPath: string;
  logPath: string;
  /** The file name the plist would conventionally have. Where it goes is the installer's decision. */
  plistFileName: string;
  plist: string;
  script: string;
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function parseDiscoveryWindow(text: string): { start: number; end: number; text: string } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/.exec(text.trim());
  if (!match) {
    throw new DiscoveryScheduleError(`the window '${text}' is not local HH:MM-HH:MM, like ${DISCOVERY_SCHEDULE_DEFAULT_WINDOW}`);
  }
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start === end) throw new DiscoveryScheduleError(`the window '${text}' starts and ends at the same minute`);
  return { start, end, text: `${hhmm(start)}-${hhmm(end)}` };
}

/** A path the generated files may embed: absolute, one line, and no character a plist or zsh mangles. */
function embeddable(what: string, value: string): string {
  if (!path.isAbsolute(value)) throw new DiscoveryScheduleError(`${what} must be an absolute path, not '${value}'`);
  if (/[\0-\x1f\x7f]/.test(value)) throw new DiscoveryScheduleError(`${what} contains a control character`);
  return path.normalize(value);
}

/** Single-quoted for zsh: nothing inside is expanded. */
function zshQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Generate the plist and the guard script. Pure: it reads nothing and writes nothing. */
export function generateDiscoverySchedule(options: DiscoveryScheduleOptions): DiscoverySchedule {
  const root = embeddable('the campaign root', options.root);
  const cernum = embeddable('the cernum executable', options.cernum);
  const directory = embeddable('the schedule directory', options.directory);
  const window = parseDiscoveryWindow(options.window ?? DISCOVERY_SCHEDULE_DEFAULT_WINDOW);
  const floorGiB = options.floorGiB ?? DISCOVERY_SCHEDULE_DEFAULT_FLOOR_GIB;
  if (!Number.isInteger(floorGiB) || floorGiB < DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB) {
    throw new DiscoveryScheduleError(`the free-space floor must be a whole number of GiB, at least `
      + `${DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB}; ${floorGiB} was asked for`);
  }
  const label = options.label ?? DISCOVERY_SCHEDULE_DEFAULT_LABEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(label)) {
    throw new DiscoveryScheduleError(`the label '${label}' is not a reverse-DNS name of letters, digits, dots and hyphens`);
  }
  const providers = (options.providers ?? []).filter((entry) => entry.trim().length > 0);
  for (const provider of providers) {
    if (!/^[A-Za-z0-9]+$/.test(provider)) throw new DiscoveryScheduleError(`'${provider}' is not a provider name`);
  }

  const lockFile = campaignLockPath(discoveryRunDirectory(root));
  const guardPath = path.join(directory, DISCOVERY_SCHEDULE_GUARD_FILE);
  const logPath = path.join(directory, DISCOVERY_SCHEDULE_LOG_FILE);
  const codes = DISCOVERY_SCHEDULE_REFUSAL_CODES;

  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- Generated by cernum discovery-schedule (${DISCOVERY_SCHEDULE_SCHEMA}). ${DISCOVERY_SCHEDULE_NOT_INSTALLED}`,
    `     Starts the guard once a day at ${hhmm(window.start)} local; the guard runs discovery-run only inside`,
    `     ${window.text}, with at least ${floorGiB} GiB free on /, memory pressure not critical, and no run holding the lock. -->`,
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>`,
    `  <string>${xml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/zsh</string>',
    `    <string>${xml(guardPath)}</string>`,
    '  </array>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    '    <key>Hour</key>',
    `    <integer>${Math.floor(window.start / 60)}</integer>`,
    '    <key>Minute</key>',
    `    <integer>${window.start % 60}</integer>`,
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>LowPriorityIO</key>',
    '  <true/>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${LAUNCHD_PATH}</string>`,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  const script = [
    '#!/bin/zsh',
    `# Cernum discovery-schedule guard (${DISCOVERY_SCHEDULE_SCHEMA}), generated by \`cernum discovery-schedule\`.`,
    `# ${DISCOVERY_SCHEDULE_NOT_INSTALLED}`,
    '#',
    '# Runs `cernum discovery-run` once, and only when every check below passes. Each refusal is logged',
    '# with its reason and exits with its own code without running anything. A check that cannot be read',
    '# refuses: not knowing the disk is fine is not the same as the disk being fine.',
    '',
    'emulate -L zsh',
    'setopt pipe_fail',
    '',
    `readonly CERNUM=${zshQuote(cernum)}`,
    `readonly CAMPAIGN_ROOT=${zshQuote(root)}`,
    `readonly LOCK_FILE=${zshQuote(lockFile)}`,
    `readonly WINDOW_START_MINUTE=${window.start}   # ${hhmm(window.start)} local`,
    `readonly WINDOW_END_MINUTE=${window.end}   # ${hhmm(window.end)} local, exclusive`,
    `readonly FLOOR_GIB=${floorGiB}`,
    `readonly MINIMUM_FLOOR_GIB=${DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB}`,
    `readonly -a PROVIDERS=(${providers.map(zshQuote).join(' ')})`,
    '',
    'log() { print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) cernum discovery-schedule guard: $*"; }',
    'refuse() { local code=$1; shift; log "REFUSED, discovery-run not started: $*"; exit $code; }',
    '',
    '# The floor. Never generated below its minimum; a hand edit below it is refused here.',
    `[[ $FLOOR_GIB == <-> ]] && (( FLOOR_GIB >= MINIMUM_FLOOR_GIB )) \\`,
    `  || refuse ${codes.cannotTell} "the free-space floor is \${FLOOR_GIB} GiB, below the minimum of \${MINIMUM_FLOOR_GIB} GiB"`,
    '',
    '# 1. Quiet hours, in local time. launchd starts a missed calendar job on wake, at any hour.',
    'hour=$(date +%H)',
    'minute=$(date +%M)',
    '[[ $hour == [0-9][0-9] && $minute == [0-9][0-9] ]] \\',
    `  || refuse ${codes.cannotTell} "could not read the local time"`,
    'now_minute=$(( 10#$hour * 60 + 10#$minute ))',
    'if (( WINDOW_START_MINUTE < WINDOW_END_MINUTE )); then',
    '  (( now_minute >= WINDOW_START_MINUTE && now_minute < WINDOW_END_MINUTE )) && inside=1 || inside=0',
    'else',
    '  (( now_minute >= WINDOW_START_MINUTE || now_minute < WINDOW_END_MINUTE )) && inside=1 || inside=0',
    'fi',
    `(( inside )) || refuse ${codes.outsideWindow} "it is \${hour}:\${minute} local, outside the quiet-hours window ${window.text}"`,
    '',
    '# 2. Free space on the internal disk, /, in KiB from POSIX df.',
    'df_lines=("${(@f)$(df -Pk / 2>/dev/null)}")',
    'df_fields=(${=df_lines[-1]})',
    'available_kib=${df_fields[4]}',
    `[[ $available_kib == <-> ]] || refuse ${codes.cannotTell} "could not read the free space on / from df"`,
    'floor_kib=$(( FLOOR_GIB * 1024 * 1024 ))',
    '(( available_kib >= floor_kib )) \\',
    `  || refuse ${codes.diskBelowFloor} "\${available_kib} KiB free on /, under the floor of \${FLOOR_GIB} GiB (\${floor_kib} KiB)"`,
    '',
    '# 3. macOS memory pressure: 1 normal, 2 warning, 4 critical.',
    'pressure=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)',
    `[[ $pressure == <-> ]] || refuse ${codes.cannotTell} "could not read macOS memory pressure (kern.memorystatus_vm_pressure_level)"`,
    `(( pressure < 4 )) || refuse ${codes.memoryPressureCritical} "macOS memory pressure is critical (kern.memorystatus_vm_pressure_level=\${pressure})"`,
    '',
    '# 4. Another run. discovery-run takes this lock itself; a live holder means one is running now.',
    'if [[ -e $LOCK_FILE ]]; then',
    '  lock_text=$(<$LOCK_FILE)',
    `  pid_pattern='"pid":[[:space:]]*([0-9]+)'`,
    '  if [[ $lock_text =~ $pid_pattern ]]; then',
    '    lock_pid=$match[1]',
    `    ps -p $lock_pid >/dev/null 2>&1 && refuse ${codes.lockHeld} "another discovery run holds $LOCK_FILE (pid $lock_pid)"`,
    '    log "the lock file $LOCK_FILE names pid $lock_pid, which is not running; discovery-run decides whether to recover it"',
    '  else',
    `    refuse ${codes.lockHeld} "the lock file $LOCK_FILE exists and names no process this guard can read"`,
    '  fi',
    'fi',
    '',
    `[[ -x $CERNUM ]] || refuse ${codes.cannotTell} "$CERNUM is not an executable"`,
    '',
    'log "every check passed (${hour}:${minute} local, ${available_kib} KiB free, pressure level ${pressure}); starting discovery-run"',
    '"$CERNUM" discovery-run --json --root "$CAMPAIGN_ROOT" "${PROVIDERS[@]}"',
    'run_status=$?',
    'log "discovery-run exited ${run_status}"',
    'exit $run_status',
    '',
  ].join('\n');

  return {
    schema: DISCOVERY_SCHEDULE_SCHEMA, label, window, floorGiB, lockFile, guardPath, logPath,
    plistFileName: `${label}.plist`, plist, script,
  };
}

/** The directories launchd reads jobs from. `writeDiscoverySchedule` refuses every one of them. */
export function launchdJobDirectories(home: string): string[] {
  return [
    path.join(home, 'Library', 'LaunchAgents'),
    '/Library/LaunchAgents', '/Library/LaunchDaemons', '/System/Library/LaunchAgents', '/System/Library/LaunchDaemons',
  ];
}

/** The path as the filesystem resolves it, following links for whatever part of it already exists. */
function resolved(target: string): string {
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...rest);
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Throws when `directory` is or is under one launchd reads jobs from, checked through symbolic links. */
function refuseLaunchdDirectory(directory: string, home: string): void {
  const where = resolved(directory);
  for (const forbidden of launchdJobDirectories(home)) {
    if (inside(where, resolved(forbidden)) || inside(path.resolve(directory), path.resolve(forbidden))) {
      throw new DiscoveryScheduleError(`refusing to write into ${directory}: launchd reads jobs from ${forbidden}, `
        + `and this command only generates. ${DISCOVERY_SCHEDULE_NOT_INSTALLED}`);
    }
  }
}

/**
 * Write the schedule's two files into the directory it was generated for, `schedule.guardPath`'s.
 *
 * Refuses, writing nothing, when that directory is or is under one launchd reads jobs from (checked
 * through symbolic links), or when either file already exists: a schedule a person may already have
 * installed is not overwritten by a generator.
 */
export function writeDiscoverySchedule(schedule: DiscoverySchedule, home: string): { guardPath: string; plistPath: string } {
  const directory = path.dirname(schedule.guardPath);
  refuseLaunchdDirectory(directory, home);
  const plistPath = path.join(directory, schedule.plistFileName);
  for (const file of [schedule.guardPath, plistPath]) {
    if (fs.existsSync(file)) throw new DiscoveryScheduleError(`refusing to overwrite ${file}; nothing was written`);
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(schedule.guardPath, schedule.script, { mode: 0o755, flag: 'wx' });
  fs.writeFileSync(plistPath, schedule.plist, { mode: 0o644, flag: 'wx' });
  return { guardPath: schedule.guardPath, plistPath };
}

// MARK: - cds2, the discovery cadence: a light listing every 6 hours and a nightly full reconciliation
//
//   LISTING          launchd starts its guard every 6 hours (`StartInterval` 21600). It runs
//                    `discovery-run` over the listing providers only, by default the three whose
//                    catalogues name new Claude and Codex releases. It has no quiet-hours check: it is
//                    the light job, and the discovery lock keeps it from overlapping the nightly one.
//   RECONCILIATION   launchd starts its guard once a day at the start of the quiet-hours window. It
//                    checks the window, as cds1 does, and runs `discovery-run` over every provider.
//
// Both guards keep cds1's free-space floor (6 GiB by default and never lower, re-checked at run time)
// and its lock check, and add two:
//
//   MEMORY PRESSURE  each job refuses at or above its own `kern.memorystatus_vm_pressure_level`: the
//                    listing at 4 (critical), the reconciliation, which probes every provider, already
//                    at 2 (warning). A hand edit that would never refuse is refused at run time.
//   RATE LIMIT       after a run whose summary says a provider did not answer because of a rate limit or
//                    a spent allowance, the guard records a backoff in one state file both jobs share,
//                    and every run before its end is refused. The wait doubles with each consecutive
//                    rate-limited run, from the base, and never exceeds the cap. A run that completes
//                    with no such provider clears it. A state file the guard cannot read is treated as
//                    the longest wait, the cap, not as no wait.
//
// Generate-only, exactly as cds1: nothing here writes outside the directory it is given, and
// `writeDiscoveryCadence` refuses every directory launchd reads jobs from.

export const DISCOVERY_CADENCE_SCHEMA = 'cds2' as const;

/** The light listing's interval. Fixed: the cadence is the schema. */
export const DISCOVERY_CADENCE_LISTING_INTERVAL_SECONDS = 6 * 60 * 60;
export const DISCOVERY_CADENCE_DEFAULT_LABEL_PREFIX = 'com.cernum.discovery';

/**
 * The providers the light listing asks by default: the catalogue providers of catalogue discovery
 * ccd1. Kept as a literal here so this module imports nothing that can start a process; the cadence
 * test pins it equal to `CATALOGUE_PROVIDERS`.
 */
export const DISCOVERY_CADENCE_DEFAULT_LISTING_PROVIDERS: readonly string[] = ['anthropicAPI', 'claudeCLI', 'codexCLI'];

export const DISCOVERY_CADENCE_DEFAULT_BACKOFF = { baseMinutes: 30, capMinutes: 24 * 60 } as const;
/** The longest cap that may be generated: a week. A longer one would amount to switching discovery off. */
export const DISCOVERY_CADENCE_MAXIMUM_BACKOFF_CAP_MINUTES = 7 * 24 * 60;

/** The pressure level, from `kern.memorystatus_vm_pressure_level` (1 normal, 2 warning, 4 critical), at which each job refuses. */
export const DISCOVERY_CADENCE_MEMORY_PRESSURE_REFUSE_AT = { listing: 4, reconciliation: 2 } as const;

/** Words in a provider's not-answered detail that mean the account was throttled: the engine's own list, and HTTP 429. */
export const DISCOVERY_CADENCE_RATE_LIMIT_MARKERS: readonly string[] = [...ALLOWANCE_EXHAUSTION_MARKERS, '429'];

export const DISCOVERY_CADENCE_REFUSAL_CODES = {
  outsideWindow: 10, diskBelowFloor: 11, memoryPressure: 12, lockHeld: 13, cannotTell: 14, rateLimitBackoff: 15,
} as const;

export const DISCOVERY_CADENCE_BACKOFF_FILE = 'discovery-cadence.backoff';

export type DiscoveryCadenceJobKind = 'listing' | 'reconciliation';

export interface DiscoveryCadenceOptions {
  /** The campaign root `discovery-run` uses; its lock file is under it. Absolute. */
  root: string;
  /** The `cernum` executable the guards run. Absolute. */
  cernum: string;
  /** The directory both guards, their logs and the backoff state will live in. Absolute. */
  directory: string;
  /** The reconciliation's quiet hours, local `HH:MM-HH:MM`. Defaults to cds1's. */
  window?: string;
  /** Whole GiB that must be free on `/` for either job. At least DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB. */
  floorGiB?: number;
  /** Each job's label is `<prefix>.listing` or `<prefix>.reconciliation`. */
  labelPrefix?: string;
  /** The light listing's providers. Defaults to DISCOVERY_CADENCE_DEFAULT_LISTING_PROVIDERS; never empty. */
  listingProviders?: string[];
  /** The reconciliation's providers. Empty, the default, means every one `discovery-run` refreshes. */
  reconciliationProviders?: string[];
  backoff?: { baseMinutes?: number; capMinutes?: number };
}

export interface DiscoveryCadenceJob {
  kind: DiscoveryCadenceJobKind;
  label: string;
  /** What starts the guard: every `seconds`, or daily at `hour`:`minute` local. */
  trigger: { every: 'interval'; seconds: number } | { every: 'day'; hour: number; minute: number };
  quietHours: boolean;
  memoryPressureRefuseAt: number;
  providers: string[];
  guardPath: string;
  logPath: string;
  plistFileName: string;
  plist: string;
  script: string;
}

export interface DiscoveryCadence {
  schema: typeof DISCOVERY_CADENCE_SCHEMA;
  window: { start: number; end: number; text: string };
  floorGiB: number;
  lockFile: string;
  backoff: { baseMinutes: number; capMinutes: number; statePath: string };
  /** Always two, in this order: the listing, then the reconciliation. */
  jobs: [DiscoveryCadenceJob, DiscoveryCadenceJob];
}

function providerList(what: string, entries: string[]): string[] {
  const providers = entries.filter((entry) => entry.trim().length > 0);
  for (const provider of providers) {
    if (!/^[A-Za-z0-9]+$/.test(provider)) throw new DiscoveryScheduleError(`'${provider}' is not a provider name (${what})`);
  }
  return providers;
}

function wholeMinutes(what: string, value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DiscoveryScheduleError(`${what} must be a whole number of minutes from ${minimum} to ${maximum}; ${value} was asked for`);
  }
  return value;
}

/** Generate both jobs' plists and guard scripts. Pure: it reads nothing and writes nothing. */
export function generateDiscoveryCadence(options: DiscoveryCadenceOptions): DiscoveryCadence {
  const root = embeddable('the campaign root', options.root);
  const cernum = embeddable('the cernum executable', options.cernum);
  const directory = embeddable('the schedule directory', options.directory);
  const window = parseDiscoveryWindow(options.window ?? DISCOVERY_SCHEDULE_DEFAULT_WINDOW);
  const floorGiB = options.floorGiB ?? DISCOVERY_SCHEDULE_DEFAULT_FLOOR_GIB;
  if (!Number.isInteger(floorGiB) || floorGiB < DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB) {
    throw new DiscoveryScheduleError(`the free-space floor must be a whole number of GiB, at least `
      + `${DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB}; ${floorGiB} was asked for`);
  }
  const prefix = options.labelPrefix ?? DISCOVERY_CADENCE_DEFAULT_LABEL_PREFIX;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(prefix) || prefix.endsWith('.')) {
    throw new DiscoveryScheduleError(`the label prefix '${prefix}' is not a reverse-DNS name of letters, digits, dots and hyphens`);
  }
  const listingProviders = providerList('listing', options.listingProviders ?? [...DISCOVERY_CADENCE_DEFAULT_LISTING_PROVIDERS]);
  if (listingProviders.length === 0) {
    throw new DiscoveryScheduleError('the light listing needs at least one provider; an empty list would make it a full reconciliation every 6 hours');
  }
  const reconciliationProviders = providerList('reconciliation', options.reconciliationProviders ?? []);
  const capMinutes = wholeMinutes('the backoff cap', options.backoff?.capMinutes ?? DISCOVERY_CADENCE_DEFAULT_BACKOFF.capMinutes,
    1, DISCOVERY_CADENCE_MAXIMUM_BACKOFF_CAP_MINUTES);
  const baseMinutes = wholeMinutes('the backoff base', options.backoff?.baseMinutes ?? DISCOVERY_CADENCE_DEFAULT_BACKOFF.baseMinutes,
    1, capMinutes);

  const lockFile = campaignLockPath(discoveryRunDirectory(root));
  const statePath = path.join(directory, DISCOVERY_CADENCE_BACKOFF_FILE);
  const shared = { root, cernum, directory, window, floorGiB, lockFile, statePath, baseMinutes, capMinutes };
  const listing = cadenceJob(shared, {
    kind: 'listing', label: `${prefix}.listing`, providers: listingProviders, quietHours: false,
    trigger: { every: 'interval', seconds: DISCOVERY_CADENCE_LISTING_INTERVAL_SECONDS },
    memoryPressureRefuseAt: DISCOVERY_CADENCE_MEMORY_PRESSURE_REFUSE_AT.listing,
  });
  const reconciliation = cadenceJob(shared, {
    kind: 'reconciliation', label: `${prefix}.reconciliation`, providers: reconciliationProviders, quietHours: true,
    trigger: { every: 'day', hour: Math.floor(window.start / 60), minute: window.start % 60 },
    memoryPressureRefuseAt: DISCOVERY_CADENCE_MEMORY_PRESSURE_REFUSE_AT.reconciliation,
  });
  return {
    schema: DISCOVERY_CADENCE_SCHEMA, window, floorGiB, lockFile,
    backoff: { baseMinutes, capMinutes, statePath }, jobs: [listing, reconciliation],
  };
}

interface CadenceShared {
  root: string; cernum: string; directory: string; window: { start: number; end: number; text: string };
  floorGiB: number; lockFile: string; statePath: string; baseMinutes: number; capMinutes: number;
}

type CadenceJobShape = Pick<DiscoveryCadenceJob, 'kind' | 'label' | 'providers' | 'quietHours' | 'trigger' | 'memoryPressureRefuseAt'>;

function cadenceJob(shared: CadenceShared, job: CadenceJobShape): DiscoveryCadenceJob {
  const { window, floorGiB } = shared;
  const guardPath = path.join(shared.directory, `discovery-cadence-${job.kind}-guard.zsh`);
  const logPath = path.join(shared.directory, `discovery-cadence-${job.kind}.log`);
  const codes = DISCOVERY_CADENCE_REFUSAL_CODES;
  const what = job.kind === 'listing'
    ? `the light provider listing (${job.providers.join(', ')})`
    : `the full reconciliation (${job.providers.length === 0 ? 'every provider' : job.providers.join(', ')})`;
  const when = job.trigger.every === 'interval'
    ? `Starts the guard every ${job.trigger.seconds / 3600} hours`
    : `Starts the guard once a day at ${hhmm(window.start)} local`;
  const conditions = `${job.quietHours ? `only inside ${window.text}, ` : ''}with at least ${floorGiB} GiB free on /, `
    + `memory pressure below level ${job.memoryPressureRefuseAt}, no rate-limit backoff in force, and no run holding the lock`;

  const trigger = job.trigger.every === 'interval'
    ? ['  <key>StartInterval</key>', `  <integer>${job.trigger.seconds}</integer>`]
    : [
      '  <key>StartCalendarInterval</key>', '  <dict>',
      '    <key>Hour</key>', `    <integer>${job.trigger.hour}</integer>`,
      '    <key>Minute</key>', `    <integer>${job.trigger.minute}</integer>`,
      '  </dict>',
    ];

  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    `<!-- Generated by cernum discovery-schedule (${DISCOVERY_CADENCE_SCHEMA}), ${job.kind}. ${DISCOVERY_SCHEDULE_NOT_INSTALLED}`,
    `     ${when}; the guard runs ${what}`,
    `     ${conditions}. -->`,
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(job.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/zsh</string>',
    `    <string>${xml(guardPath)}</string>`,
    '  </array>',
    ...trigger,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>LowPriorityIO</key>',
    '  <true/>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PATH</key>',
    `    <string>${LAUNCHD_PATH}</string>`,
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');

  const quietHours = job.quietHours ? [
    '# Quiet hours, in local time. launchd starts a missed calendar job on wake, at any hour.',
    'hour=$(date +%H)',
    'minute=$(date +%M)',
    '[[ $hour == [0-9][0-9] && $minute == [0-9][0-9] ]] \\',
    `  || refuse ${codes.cannotTell} "could not read the local time"`,
    'now_minute=$(( 10#$hour * 60 + 10#$minute ))',
    'if (( WINDOW_START_MINUTE < WINDOW_END_MINUTE )); then',
    '  (( now_minute >= WINDOW_START_MINUTE && now_minute < WINDOW_END_MINUTE )) && inside=1 || inside=0',
    'else',
    '  (( now_minute >= WINDOW_START_MINUTE || now_minute < WINDOW_END_MINUTE )) && inside=1 || inside=0',
    'fi',
    `(( inside )) || refuse ${codes.outsideWindow} "it is \${hour}:\${minute} local, outside the quiet-hours window ${window.text}"`,
    '',
  ] : [];

  const script = [
    '#!/bin/zsh',
    `# Cernum discovery cadence guard (${DISCOVERY_CADENCE_SCHEMA}), ${job.kind}, generated by \`cernum discovery-schedule\`.`,
    `# ${DISCOVERY_SCHEDULE_NOT_INSTALLED}`,
    '#',
    `# Runs ${what} through \`cernum discovery-run\` once, and only when every check below passes.`,
    '# Each refusal is logged with its reason and exits with its own code without running anything. A check',
    '# that cannot be read refuses: not knowing the disk is fine is not the same as the disk being fine.',
    '',
    'emulate -L zsh',
    'setopt pipe_fail',
    '',
    `readonly CERNUM=${zshQuote(shared.cernum)}`,
    `readonly CAMPAIGN_ROOT=${zshQuote(shared.root)}`,
    `readonly LOCK_FILE=${zshQuote(shared.lockFile)}`,
    `readonly BACKOFF_FILE=${zshQuote(shared.statePath)}`,
    ...(job.quietHours ? [
      `readonly WINDOW_START_MINUTE=${window.start}   # ${hhmm(window.start)} local`,
      `readonly WINDOW_END_MINUTE=${window.end}   # ${hhmm(window.end)} local, exclusive`,
    ] : []),
    `readonly FLOOR_GIB=${floorGiB}`,
    `readonly MINIMUM_FLOOR_GIB=${DISCOVERY_SCHEDULE_MINIMUM_FLOOR_GIB}`,
    `readonly MEMORY_PRESSURE_REFUSE_AT=${job.memoryPressureRefuseAt}   # 1 normal, 2 warning, 4 critical`,
    `readonly BACKOFF_BASE_MINUTES=${shared.baseMinutes}`,
    `readonly BACKOFF_CAP_MINUTES=${shared.capMinutes}`,
    `readonly -a PROVIDERS=(${job.providers.map(zshQuote).join(' ')})`,
    `readonly -a RATE_LIMIT_MARKERS=(${DISCOVERY_CADENCE_RATE_LIMIT_MARKERS.map(zshQuote).join(' ')})`,
    '',
    `log() { print -r -- "$(date -u +%Y-%m-%dT%H:%M:%SZ) cernum discovery cadence guard (${job.kind}): $*"; }`,
    'refuse() { local code=$1; shift; log "REFUSED, discovery-run not started: $*"; exit $code; }',
    '',
    '# The floor and the pressure threshold. Never generated past their limits; a hand edit past them is refused here.',
    '[[ $FLOOR_GIB == <-> ]] && (( FLOOR_GIB >= MINIMUM_FLOOR_GIB )) \\',
    `  || refuse ${codes.cannotTell} "the free-space floor is \${FLOOR_GIB} GiB, below the minimum of \${MINIMUM_FLOOR_GIB} GiB"`,
    '[[ $MEMORY_PRESSURE_REFUSE_AT == <-> ]] && (( MEMORY_PRESSURE_REFUSE_AT >= 1 && MEMORY_PRESSURE_REFUSE_AT <= 4 )) \\',
    `  || refuse ${codes.cannotTell} "the memory-pressure threshold \${MEMORY_PRESSURE_REFUSE_AT} is not a level from 1 to 4"`,
    '[[ $BACKOFF_BASE_MINUTES == <-> && $BACKOFF_CAP_MINUTES == <-> ]] && (( BACKOFF_BASE_MINUTES >= 1 && BACKOFF_BASE_MINUTES <= BACKOFF_CAP_MINUTES )) \\',
    `  || refuse ${codes.cannotTell} "the backoff base \${BACKOFF_BASE_MINUTES} and cap \${BACKOFF_CAP_MINUTES} minutes are not a base no larger than its cap"`,
    '',
    ...quietHours,
    '# Rate-limit backoff, shared by both cadence jobs. A state file that cannot be read is the longest wait.',
    'now_epoch=$(date +%s)',
    `[[ $now_epoch == <-> ]] || refuse ${codes.cannotTell} "could not read the clock in seconds"`,
    'consecutive=0',
    'if [[ -e $BACKOFF_FILE ]]; then',
    '  backoff_text=$(<$BACKOFF_FILE)',
    `  backoff_pattern='^consecutive=([0-9]+) not_before=([0-9]+)$'`,
    '  if [[ $backoff_text =~ $backoff_pattern ]]; then',
    '    consecutive=$match[1]',
    '    not_before=$match[2]',
    '    (( now_epoch >= not_before )) \\',
    `      || refuse ${codes.rateLimitBackoff} "rate-limit backoff after \${consecutive} consecutive rate-limited run(s); \$(( (not_before - now_epoch + 59) / 60 )) minute(s) left"`,
    '  else',
    '    print -r -- "consecutive=0 not_before=$(( now_epoch + BACKOFF_CAP_MINUTES * 60 ))" >| $BACKOFF_FILE',
    `    refuse ${codes.rateLimitBackoff} "could not read the backoff state $BACKOFF_FILE; waiting the cap of \${BACKOFF_CAP_MINUTES} minute(s)"`,
    '  fi',
    'fi',
    '',
    '# Free space on the internal disk, /, in KiB from POSIX df.',
    'df_lines=("${(@f)$(df -Pk / 2>/dev/null)}")',
    'df_fields=(${=df_lines[-1]})',
    'available_kib=${df_fields[4]}',
    `[[ $available_kib == <-> ]] || refuse ${codes.cannotTell} "could not read the free space on / from df"`,
    'floor_kib=$(( FLOOR_GIB * 1024 * 1024 ))',
    '(( available_kib >= floor_kib )) \\',
    `  || refuse ${codes.diskBelowFloor} "\${available_kib} KiB free on /, under the floor of \${FLOOR_GIB} GiB (\${floor_kib} KiB)"`,
    '',
    '# Memory-pressure guard: macOS memory pressure, 1 normal, 2 warning, 4 critical.',
    'pressure=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)',
    `[[ $pressure == <-> ]] || refuse ${codes.cannotTell} "could not read macOS memory pressure (kern.memorystatus_vm_pressure_level)"`,
    '(( pressure < MEMORY_PRESSURE_REFUSE_AT )) \\',
    `  || refuse ${codes.memoryPressure} "macOS memory pressure is level \${pressure}, at or above this job's limit of \${MEMORY_PRESSURE_REFUSE_AT}"`,
    '',
    '# Another run. discovery-run takes this lock itself; a live holder means one is running now.',
    'if [[ -e $LOCK_FILE ]]; then',
    '  lock_text=$(<$LOCK_FILE)',
    `  pid_pattern='"pid":[[:space:]]*([0-9]+)'`,
    '  if [[ $lock_text =~ $pid_pattern ]]; then',
    '    lock_pid=$match[1]',
    `    ps -p $lock_pid >/dev/null 2>&1 && refuse ${codes.lockHeld} "another discovery run holds $LOCK_FILE (pid $lock_pid)"`,
    '    log "the lock file $LOCK_FILE names pid $lock_pid, which is not running; discovery-run decides whether to recover it"',
    '  else',
    `    refuse ${codes.lockHeld} "the lock file $LOCK_FILE exists and names no process this guard can read"`,
    '  fi',
    'fi',
    '',
    `[[ -x $CERNUM ]] || refuse ${codes.cannotTell} "$CERNUM is not an executable"`,
    '',
    'log "every check passed (${available_kib} KiB free, pressure level ${pressure}); starting discovery-run"',
    'run_output=$("$CERNUM" discovery-run --json --root "$CAMPAIGN_ROOT" "${PROVIDERS[@]}")',
    'run_status=$?',
    'print -r -- "$run_output"',
    'log "discovery-run exited ${run_status}"',
    '',
    '# Did a provider decline for a rate limit or a spent allowance? Only its not-answered details are read.',
    'run_lower=${(L)run_output}',
    'rate_limited=0',
    `not_answered_open='"providersnotanswered":[{'`,
    `not_answered_close='}]'`,
    'if [[ $run_lower == *$not_answered_open* ]]; then',
    '  not_answered=${run_lower#*$not_answered_open}',
    '  not_answered=${not_answered%%$not_answered_close*}',
    '  for marker in "${RATE_LIMIT_MARKERS[@]}"; do',
    '    if [[ $not_answered == *"$marker"* ]]; then rate_limited=1; break; fi',
    '  done',
    'fi',
    '',
    '# Exponential backoff with a cap: base, then doubled per consecutive rate-limited run, never past the cap.',
    'if (( rate_limited )); then',
    '  consecutive=$(( consecutive + 1 ))',
    '  delay=$BACKOFF_BASE_MINUTES',
    '  for (( step = 1; step < consecutive && delay < BACKOFF_CAP_MINUTES; step++ )); do delay=$(( delay * 2 )); done',
    '  (( delay > BACKOFF_CAP_MINUTES )) && delay=$BACKOFF_CAP_MINUTES',
    '  print -r -- "consecutive=${consecutive} not_before=$(( $(date +%s) + delay * 60 ))" >| $BACKOFF_FILE \\',
    '    || log "could not write the backoff state $BACKOFF_FILE"',
    '  log "a provider reported a rate limit; backing off ${delay} minute(s) after ${consecutive} consecutive rate-limited run(s)"',
    'elif (( run_status == 0 )) && [[ -e $BACKOFF_FILE ]]; then',
    '  rm -f -- $BACKOFF_FILE && log "no provider reported a rate limit; the backoff is cleared"',
    'fi',
    'exit $run_status',
    '',
  ].join('\n');

  return {
    ...job, guardPath, logPath, plistFileName: `${job.label}.plist`, plist, script,
  };
}

/**
 * Write the cadence's files, both plists and both guards, into the directory it was generated for.
 *
 * The same refusals as `writeDiscoverySchedule`, checked for every file before any is written: a
 * launchd job directory (through symbolic links too), or any file already there.
 */
export function writeDiscoveryCadence(cadence: DiscoveryCadence, home: string): { guardPath: string; plistPath: string }[] {
  const directory = path.dirname(cadence.backoff.statePath);
  refuseLaunchdDirectory(directory, home);
  const files = cadence.jobs.map((job) => ({ job, guardPath: job.guardPath, plistPath: path.join(directory, job.plistFileName) }));
  for (const file of files.flatMap((entry) => [entry.guardPath, entry.plistPath])) {
    if (fs.existsSync(file)) throw new DiscoveryScheduleError(`refusing to overwrite ${file}; nothing was written`);
  }
  fs.mkdirSync(directory, { recursive: true });
  for (const { job, guardPath, plistPath } of files) {
    fs.writeFileSync(guardPath, job.script, { mode: 0o755, flag: 'wx' });
    fs.writeFileSync(plistPath, job.plist, { mode: 0o644, flag: 'wx' });
  }
  return files.map(({ guardPath, plistPath }) => ({ guardPath, plistPath }));
}
