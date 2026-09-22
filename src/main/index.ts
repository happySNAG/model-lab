// Model Lab · Electron main process. Owns the window, the application menu, the lab service,
// settings, and the IPC surface. macOS is the reference platform: a hidden-inset title bar with the
// sidebar carrying the traffic lights, a full menu bar, the app staying alive with no windows, and
// the About panel; Windows keeps a normal frame with the same menu behind Alt.

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { IPC, BenchmarkConfiguration, BuildInfo, CampaignCreateRequest, Diagnostics, ScreenID, Settings } from '../shared/ipc';
import { LabService } from './lab-service';
import { CampaignService } from './campaign-service';
import { SettingsStore, evidenceRootFor } from './settings';
import { detectOllama, ModelPuller, openDownloadPage, startOllama, OLLAMA_DOWNLOAD_URL } from './ollama-runtime';
import { menuTemplate } from './menu';
import { PRODUCT, environmentOverride } from '../shared/product';
import { migrateUserData, legacyUserDataDirectory } from './user-data-migration';
import { bundleDigest } from '../core/store';
import { inspectableJSON } from '../core/digest';
import { randomBytes } from 'node:crypto';

declare const __BUILD_COMMIT__: string;
declare const __BUILD_TIME__: string;
declare const __APP_VERSION__: string;

const PRODUCT_NAME = PRODUCT.name;
const isDev = !!process.env.ELECTRON_RENDERER_URL;
const isMac = process.platform === 'darwin';
const userDataOverride = environmentOverride('USER_DATA');
if (userDataOverride) app.setPath('userData', userDataOverride);
app.setName(PRODUCT_NAME);

let mainWindow: BrowserWindow | undefined;
let service: LabService;
let settingsStore: SettingsStore;
let quitting = false;
const puller = new ModelPuller();
const logPath = () => path.join(app.getPath('userData'), `${PRODUCT.slug}.log`);

function log(line: string): void {
  try { fs.appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`); } catch { /* logging must never break the app */ }
}

function buildInfo(): BuildInfo {
  return {
    productName: PRODUCT_NAME,
    version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : app.getVersion(),
    commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
    builtAt: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'unknown',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    userDataPath: app.getPath('userData'),
    evidenceRoot: service?.evidenceRoot ?? '',
    logPath: logPath(),
  };
}

/** The user guide ships inside the application (extraResources) so Help works offline; in dev it is the repo file. */
function readmePath(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'README.md');
  return app.isPackaged && fs.existsSync(packaged) ? packaged : path.resolve(__dirname, '../../README.md');
}

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#161719' : '#f4f4f2';
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840, minWidth: 980, minHeight: 640,
    title: PRODUCT_NAME,
    backgroundColor: windowBackground(),
    show: false,
    // macOS: the window chrome is the sidebar; the traffic lights sit inside it. Windows: a normal frame.
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    autoHideMenuBar: !isMac,
    icon: process.platform === 'win32' ? path.join(__dirname, '../../build/icon.ico') : undefined,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: 'deny' }; });
  if (isDev) await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function send(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, payload);
}

async function focusedOrNewWindow(): Promise<BrowserWindow> {
  if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
  if (mainWindow!.isMinimized()) mainWindow!.restore();
  mainWindow!.focus();
  return mainWindow!;
}

async function navigate(screen: ScreenID): Promise<void> {
  await focusedOrNewWindow();
  send(IPC.eventNavigate, screen);
}

async function diagnostics(): Promise<Diagnostics> {
  return {
    build: buildInfo(), settings: settingsStore.get(), machine: await service.getMachine(),
    ollama: await detectOllama(settingsStore.get().ollamaEndpoint), integrity: await service.resultStore.integrity(),
    runCount: (await service.resultStore.runIDs()).length, sessionCount: service.sessionCount(), evidenceRoot: service.evidenceRoot,
    catalog: await service.catalogSummary(),
  };
}

async function exportEvidence(): Promise<{ path?: string; digest?: string; cancelled: boolean }> {
  const window = await focusedOrNewWindow();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = await dialog.showSaveDialog(window, { title: 'Export evidence bundle', defaultPath: path.join(app.getPath('documents'), `model-lab-evidence-${stamp}.json`), filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { cancelled: true };
  if (fs.existsSync(result.filePath)) throw new Error('that file already exists — evidence exports are never overwritten; choose a new name');
  const bundle = await service.resultStore.exportAll();
  fs.writeFileSync(result.filePath, inspectableJSON(bundle), 'utf8');
  return { path: result.filePath, digest: bundleDigest(bundle), cancelled: false };
}

function attachService(next: LabService): void {
  service = next;
  service.on('progress', (progress) => send(IPC.eventProgress, progress));
  service.on('log', (line: string) => log(line));
}

/**
 * The benchmark-engine service. It shares no state with `LabService`; it reads campaigns from disk
 * every time it is asked, which is what lets a campaign the `cernum` terminal command is running
 * right now be observed here without this process owning it.
 */
const campaigns = new CampaignService(() => settingsStore.get().ollamaEndpoint);
campaigns.on('campaignProgress', (event) => send(IPC.eventCampaign, event));

function installMenu(): void {
  const template = menuTemplate({ platform: process.platform, isDev, productName: PRODUCT_NAME }, {
    navigate: (screen) => { void navigate(screen); },
    newBenchmark: () => { void navigate('benchmark'); },
    exportEvidence: () => { exportEvidence().catch((error) => dialog.showErrorBox('Export failed', error instanceof Error ? error.message : String(error))); },
    openEvidenceFolder: () => { void shell.openPath(service.evidenceRoot); },
    openDataFolder: () => { void shell.openPath(app.getPath('userData')); },
    revealLog: () => { if (!fs.existsSync(logPath())) log('log file created'); shell.showItemInFolder(logPath()); },
    openOllamaDownload: () => { void shell.openExternal(OLLAMA_DOWNLOAD_URL); },
    openReadme: () => { void shell.openPath(readmePath()); },
    copyDiagnostics: () => { diagnostics().then((d) => clipboard.writeText(inspectableJSON(d))).catch((error) => log(`diagnostics copy failed: ${String(error)}`)); },
    checkOllama: () => { detectOllama(settingsStore.get().ollamaEndpoint).then((s) => send(IPC.eventOllama, s)).catch(() => undefined); },
    about: () => app.showAboutPanel(),
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function bootstrap(): Promise<void> {
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });

  // THE RENAME MUST NOT LOOK LIKE A DELETION.
  //
  // Electron derives `userData` from the application's name, so renaming the product to Cernum
  // repoints this directory. Without this call the application starts with no campaigns and no
  // evidence store, while every byte is still on disk under the old name -- and nothing says so.
  //
  // It runs BEFORE the settings store and the service are constructed, because both read from this
  // directory and either one would otherwise create a fresh empty file that the migration would then
  // have to refuse to overwrite. It COPIES: the old directory keeps every byte it had, nothing is
  // overwritten, and nothing is deleted. See `user-data-migration.ts`.
  const migration = migrateUserData(legacyUserDataDirectory(app.getPath('appData')), userData);
  log(`data directory: ${migration.reason}`);
  if (migration.copied.length > 0) {
    log(`the previous data directory was left intact at ${migration.legacyDirectory}; `
      + 'every item carried across was copied, not moved. Delete it yourself if you want the space back.');
  }
  if (migration.conflicts.length > 0 || migration.failures.length > 0) {
    log(`data directory migration needs a person: conflicts=[${migration.conflicts.join(', ')}] `
      + `failures=[${migration.failures.map((f) => `${f.entry}: ${f.detail}`).join('; ')}]`);
  }

  settingsStore = new SettingsStore(path.join(userData, 'settings.json'));
  const initial = new LabService({ userData, evidenceRoot: evidenceRootFor(userData, settingsStore.get()), getSettings: () => settingsStore.get() });
  await initial.open();
  attachService(initial);
  const info = buildInfo();
  log(`${PRODUCT_NAME} ${info.version} (${info.commit}) started on ${process.platform}/${process.arch}; data at ${userData}; evidence at ${service.evidenceRoot}`);

  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: info.version,
    version: `${info.commit} · ${info.builtAt}`,
    copyright: 'Cernum contributors. Local benchmarking; nothing leaves this computer.',
    credits: `Evidence store: ${service.evidenceRoot}`,
  });
  installMenu();
  nativeTheme.on('updated', () => { for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(windowBackground()); });

  ipcMain.handle(IPC.buildInfo, () => buildInfo());
  ipcMain.handle(IPC.getSettings, () => settingsStore.get());
  ipcMain.handle(IPC.saveSettings, async (_e, next: Settings) => {
    const previousRoot = service.evidenceRoot;
    const saved = settingsStore.save(next);
    const nextRoot = evidenceRootFor(app.getPath('userData'), saved);
    if (nextRoot !== previousRoot) {
      if (service.isRunning) throw new Error('the evidence folder cannot change while a benchmark is running');
      const replacement = new LabService({ userData: app.getPath('userData'), evidenceRoot: nextRoot, getSettings: () => settingsStore.get() });
      await replacement.open();
      service.removeAllListeners();
      attachService(replacement);
      log(`evidence root changed to ${nextRoot}`);
    }
    send(IPC.eventOllama, await detectOllama(saved.ollamaEndpoint));
    return saved;
  });
  ipcMain.handle(IPC.getMachine, (_e, refresh?: boolean) => service.getMachine(refresh));
  ipcMain.handle(IPC.ollamaStatus, async () => { const s = await detectOllama(settingsStore.get().ollamaEndpoint); send(IPC.eventOllama, s); return s; });
  ipcMain.handle(IPC.startOllama, async () => { const s = await startOllama(settingsStore.get().ollamaEndpoint, log); send(IPC.eventOllama, s); return s; });
  ipcMain.handle(IPC.openOllamaDownload, () => openDownloadPage());
  ipcMain.handle(IPC.listModels, () => service.listModels());
  ipcMain.handle(IPC.pullModel, (_e, model: string) => puller.pull(settingsStore.get().ollamaEndpoint, model, (p) => send(IPC.eventPull, p)));
  ipcMain.handle(IPC.cancelPull, () => puller.cancel());
  ipcMain.handle(IPC.listSuites, () => service.listSuites());
  ipcMain.handle(IPC.preflight, (_e, configuration: BenchmarkConfiguration) => service.preflight(configuration));
  ipcMain.handle(IPC.startBenchmark, (_e, configuration: BenchmarkConfiguration) => service.startBenchmark(configuration));
  ipcMain.handle(IPC.cancelBenchmark, () => service.cancelBenchmark());
  ipcMain.handle(IPC.activeProgress, () => service.activeProgress());
  ipcMain.handle(IPC.listSessions, () => service.listSessions());
  ipcMain.handle(IPC.sessionResults, (_e, sessionID: string) => service.sessionResults(sessionID));
  ipcMain.handle(IPC.attemptDetail, (_e, attemptID: string) => service.attemptDetail(attemptID));
  ipcMain.handle(IPC.recordRecommendation, (_e, sessionID: string, candidateID: string) => service.recordRecommendation(sessionID, candidateID));
  ipcMain.handle(IPC.history, () => service.history());
  ipcMain.handle(IPC.compareSessions, (_e, a: string, b: string) => service.compareSessions(a, b));
  ipcMain.handle(IPC.diagnostics, () => diagnostics());
  ipcMain.handle(IPC.exportEvidence, () => exportEvidence());
  ipcMain.handle(IPC.openPath, async (_e, target: string) => { await shell.openPath(target); });
  ipcMain.handle(IPC.revealPath, (_e, target: string) => { if (target === logPath() && !fs.existsSync(target)) log('log file created'); shell.showItemInFolder(target); });
  ipcMain.handle(IPC.copyDiagnostics, async () => { clipboard.writeText(inspectableJSON(await diagnostics())); });

  ipcMain.handle(IPC.listCampaigns, () => campaigns.list());
  ipcMain.handle(IPC.campaignDetail, (_e, name: string) => campaigns.detail(name));
  ipcMain.handle(IPC.campaignSuites, () => campaigns.availableSuites());
  ipcMain.handle(IPC.createCampaign, (_e, request: CampaignCreateRequest) => campaigns.create(request));
  ipcMain.handle(IPC.startCampaign, (_e, name: string) => campaigns.start(name));
  ipcMain.handle(IPC.pauseCampaign, () => { campaigns.pause(); });
  ipcMain.handle(IPC.verifyCampaign, (_e, name: string) => campaigns.verify(name));
  ipcMain.handle(IPC.finalizeCampaign, (_e, name: string) => {
    // The blinding secret is generated per finalize and never written beside the packet. Losing it
    // means a new packet must be built, which is the correct failure: an unblindable packet is safe.
    campaigns.finalize(name, randomBytes(24).toString('hex'));
    return campaigns.detail(name);
  });
  ipcMain.handle(IPC.campaignRoot, () => campaigns.root());
  ipcMain.handle(IPC.campaignDisclosure, (_e, name: string) => campaigns.disclosure(name));
  ipcMain.handle(IPC.leasedEndpoints, () => campaigns.leasedEndpoints());
  // Reaches nothing. A PATH lookup and a credential check, which is why the Providers screen may
  // call it on every refresh and why opening the application sends zero provider requests.
  ipcMain.handle(IPC.providerStatuses, () => campaigns.providerStatuses());
  ipcMain.handle(IPC.requestedCohort, () => campaigns.requestedCohort());
  // THIS ONE INVOKES SOMETHING, and only ever because a person pressed a button that says so.
  ipcMain.handle(IPC.discoverProvider, (_e, provider: string) => campaigns.discoverProvider(provider));
  ipcMain.handle(IPC.previewCampaignCost, (_e, request: CampaignCreateRequest) => campaigns.previewCost(request));
  ipcMain.handle(IPC.campaignCost, (_e, name: string) => campaigns.campaignCost(name));
  ipcMain.handle(IPC.authorizeCampaign, (_e, name: string, ceilingMicroUSD: number) => campaigns.authorize(name, ceilingMicroUSD));
  ipcMain.handle(IPC.terminalCommand, () => campaigns.terminalCommand());
  ipcMain.handle(IPC.installTerminalCommand, () => campaigns.installTerminalCommand());
  ipcMain.handle(IPC.uninstallTerminalCommand, () => campaigns.uninstallTerminalCommand());
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { void focusedOrNewWindow(); });
  app.whenReady().then(async () => {
    try {
      await bootstrap();
      await createWindow();
    } catch (error) {
      log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      dialog.showErrorBox(`${PRODUCT_NAME} could not start`, error instanceof Error ? error.message : String(error));
      app.quit();
    }
    // macOS: clicking the Dock icon with no window open reopens one (the app stays alive without windows).
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
  });
  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
  // Quitting during a benchmark: cancel it so the run summary is written honestly ("cancelled"),
  // wait briefly for the in-flight attempt to be recorded, then quit. Never blocks longer than 8 s.
  app.on('before-quit', (event) => {
    if (quitting || !service?.isRunning) return;
    event.preventDefault();
    quitting = true;
    log('quit requested during a benchmark; cancelling so the evidence closes honestly');
    service.cancelBenchmark();
    const finish = () => app.quit();
    service.once('idle', finish);
    setTimeout(finish, 8_000).unref();
  });
  process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? error.message}`));
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`));
}
