// Unit · the desktop application's own state: settings persistence and validation, session-index
// recovery after an unclean exit, machine-summary honesty, and the application menu's shape.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, SettingsStore, evidenceRootFor } from '../../src/main/settings';
import { SessionIndex } from '../../src/main/sessions';
import { captureEnvironment, formatBytes, summarize } from '../../src/main/environment';
import { accelerators, menuTemplate, MenuActions } from '../../src/main/menu';
import { syntheticEnvironment } from '@core/run';
import type { SessionRecord } from '../../src/shared/ipc';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-lab-unit-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('settings store', () => {
  it('starts from defaults, persists a save, and reloads it', () => {
    const file = path.join(dir, 'settings.json');
    const store = new SettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const saved = store.save({ ollamaEndpoint: 'http://localhost:11434/', thinkingMode: 'enabled', evidenceRootOverride: '  ' });
    expect(saved).toEqual({ ollamaEndpoint: 'http://localhost:11434', thinkingMode: 'enabled', evidenceRootOverride: '' });
    expect(new SettingsStore(file).get()).toEqual(saved);
  });
  it('refuses a non-loopback endpoint and keeps the previous settings', () => {
    const store = new SettingsStore(path.join(dir, 'settings.json'));
    expect(() => store.save({ ...DEFAULT_SETTINGS, ollamaEndpoint: 'http://192.168.1.20:11434' })).toThrow(/not loopback/);
    expect(() => store.save({ ...DEFAULT_SETTINGS, ollamaEndpoint: 'https://127.0.0.1:11434' })).toThrow(/not http/);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
  });
  it('treats an unreadable or malformed file as first launch, and coerces unknown thinking modes', () => {
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{ not json');
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS);
    fs.writeFileSync(file, JSON.stringify({ thinkingMode: 'sometimes' }));
    expect(new SettingsStore(file).get().thinkingMode).toBe('disabled');
  });
  it('places the evidence store under user data unless an absolute override is given', () => {
    expect(evidenceRootFor('/ud', DEFAULT_SETTINGS)).toBe(path.join('/ud', 'evidence'));
    expect(evidenceRootFor('/ud', { ...DEFAULT_SETTINGS, evidenceRootOverride: 'relative/dir' })).toBe(path.join('/ud', 'evidence'));
    expect(evidenceRootFor('/ud', { ...DEFAULT_SETTINGS, evidenceRootOverride: '/Volumes/Lab/evidence' })).toBe('/Volumes/Lab/evidence');
  });
});

describe('session index', () => {
  const session = (over: Partial<SessionRecord>): SessionRecord => ({
    sessionID: 's1', label: 'x', createdAt: '2026-01-01T00:00:00Z', state: 'completed', suiteIDs: [], runIDs: [], candidates: [], modelKeys: [],
    thinkingMode: 'disabled', endpoint: 'http://127.0.0.1:11434', machine: { environment: syntheticEnvironment, hostname: 'h', platformLabel: 'p', cpuLabel: 'c', memoryLabel: 'm', gpuLabel: 'g', capturedAt: 't' },
    ...over,
  });
  it('marks a session that was running at the last exit as incomplete, and says why', () => {
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, JSON.stringify({ sessions: [session({ state: 'running' }), session({ sessionID: 's2' })] }));
    const index = new SessionIndex(file);
    expect(index.get('s1')?.state).toBe('incomplete');
    expect(index.get('s1')?.failureDetail).toMatch(/closed while this benchmark was running/);
    expect(index.get('s2')?.state).toBe('completed');
    // …and persisted, so the next launch does not re-derive it.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sessions[0].state).toBe('incomplete');
  });
  it('upserts by session id and hands out copies', () => {
    const index = new SessionIndex(path.join(dir, 'sessions.json'));
    index.upsert(session({}));
    const copy = index.get('s1')!;
    copy.label = 'mutated';
    expect(index.get('s1')?.label).toBe('x');
    index.upsert(session({ label: 'renamed' }));
    expect(index.all().length).toBe(1);
    expect(index.all()[0].label).toBe('renamed');
  });
  it('survives a missing or corrupt file', () => {
    expect(new SessionIndex(path.join(dir, 'missing.json')).all()).toEqual([]);
    fs.writeFileSync(path.join(dir, 'bad.json'), 'nope');
    expect(new SessionIndex(path.join(dir, 'bad.json')).all()).toEqual([]);
  });
});

describe('machine summary', () => {
  it('formats bytes for people', () => {
    expect(formatBytes(16 * 1024 ** 3)).toBe('16.0 GB');
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.00 TB');
  });
  it('says "not reported" for anything unmeasured instead of inventing it', () => {
    const summary = summarize({ ...syntheticEnvironment, hardware: undefined, machineIdentifier: { unavailableReason: 'x' }, physicalMemoryBytes: { unavailableReason: 'x' } });
    expect(summary.hostname).toMatch(/^this (Mac|PC)$/);
    expect(summary.memoryLabel).toBe('memory not reported');
    expect(summary.gpuLabel).toBe('GPU not reported');
  });
  it('captures this machine with every field either measured or explained', async () => {
    const environment = await captureEnvironment();
    const fields = [environment.machineIdentifier, environment.hardwareModel, environment.cpuCoreCount, environment.physicalMemoryBytes, environment.osVersion, environment.inferenceRuntimeVersion,
      ...Object.values(environment.hardware ?? {})] as ({ measured: unknown } | { unavailableReason: string })[];
    for (const field of fields) expect('measured' in field || ('unavailableReason' in field && field.unavailableReason.length > 0)).toBe(true);
    expect('measured' in environment.cpuCoreCount).toBe(true);
    expect('measured' in environment.physicalMemoryBytes).toBe(true);
    if (process.platform === 'darwin') {
      expect('measured' in environment.osVersion && environment.osVersion.measured.startsWith('macOS')).toBe(true);
      // `hw.optional.arm64` does not exist on an Intel Mac, so the capture correctly reports the
      // field as unavailable WITH A REASON there. Demanding `measured` on every darwin host asserted
      // Apple Silicon rather than macOS, and failed on an Intel Mac against correct code. What this
      // test is actually about — its own title — is that the field is never silently absent.
      const appleSilicon = environment.hardware?.appleSilicon;
      expect(appleSilicon).toBeDefined();
      expect('measured' in appleSilicon! || appleSilicon!.unavailableReason.length > 0).toBe(true);
      if (process.arch === 'arm64') expect('measured' in appleSilicon! && appleSilicon!.measured).toBe(true);
    }
  }, 30_000);
});

describe('application menu', () => {
  const actions: MenuActions = {
    navigate: () => undefined, newBenchmark: () => undefined, exportEvidence: () => undefined, openEvidenceFolder: () => undefined, openDataFolder: () => undefined,
    revealLog: () => undefined, openOllamaDownload: () => undefined, openReadme: () => undefined, copyDiagnostics: () => undefined, checkOllama: () => undefined, about: () => undefined,
  };
  const labels = (items: { label?: string; role?: string }[]) => items.map((i) => i.label ?? i.role);
  it('on macOS leads with the application menu (About, Settings…, Quit) and ends with Window and Help', () => {
    const template = menuTemplate({ platform: 'darwin', isDev: false, productName: 'Model Lab' }, actions);
    expect(labels(template)).toEqual(['Model Lab', 'File', 'Edit', 'View', 'Ollama', 'window', 'help']);
    const appMenu = template[0].submenu as { label?: string; role?: string; accelerator?: string }[];
    expect(appMenu[0].label).toBe('About Model Lab');
    expect(appMenu.find((i) => i.label === 'Settings…')?.accelerator).toBe('Command+,');
    expect(appMenu[appMenu.length - 1].role).toBe('quit');
    expect((template[1].submenu as { role?: string }[]).some((i) => i.role === 'close')).toBe(true);
  });
  it('on Windows puts Exit under File and About under Help, with no application menu', () => {
    const template = menuTemplate({ platform: 'win32', isDev: false, productName: 'Model Lab' }, actions);
    expect(labels(template)[0]).toBe('File');
    const file = template[0].submenu as { label?: string; role?: string }[];
    expect(file[file.length - 1]).toMatchObject({ role: 'quit', label: 'Exit' });
    const help = template[template.length - 1].submenu as { label?: string }[];
    expect(help[help.length - 1].label).toBe('About Model Lab');
  });
  it('gives every screen a Cmd/Ctrl+digit shortcut and never duplicates an accelerator', () => {
    const template = menuTemplate({ platform: 'darwin', isDev: false, productName: 'Model Lab' }, actions);
    const all = accelerators(template);
    for (let i = 1; i <= 7; i++) expect(all).toContain(`CmdOrCtrl+${i}`);
    expect(new Set(all).size).toBe(all.length);
  });
  it('exposes reload and developer tools only in development', () => {
    const view = (isDev: boolean) => (menuTemplate({ platform: 'darwin', isDev, productName: 'Model Lab' }, actions)[3].submenu as { role?: string }[]).map((i) => i.role);
    expect(view(false)).not.toContain('toggleDevTools');
    expect(view(true)).toContain('toggleDevTools');
  });
});
