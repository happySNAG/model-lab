// Cernum · machine and environment capture for the desktop application.
//
// The same honesty rule as the canonical lab: every field is measured from what the operating
// system genuinely reports, or explicitly unavailable with a reason. Nothing is estimated. Windows
// facts come from CIM (PowerShell), macOS facts from sysctl, Linux facts from /proc — each behind a
// timeout, each failure becoming an explicit absence.

import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EnvironmentRecord, HardwareTruth } from '../core/run';
import { Measurement, measured, unavailable } from '../core/candidate';
import { isoSeconds } from '../core/digest';
import { MachineSummary } from '../shared/ipc';

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], timeout = 8_000): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

interface WindowsFacts {
  model?: string; manufacturer?: string; cpuName?: string; cores?: number; logical?: number; gpu?: string; osCaption?: string; osVersion?: string;
}

async function windowsFacts(): Promise<{ facts: WindowsFacts; failure?: string }> {
  const script = [
    '$ErrorActionPreference="SilentlyContinue"',
    '$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1',
    '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1',
    '$gpu = Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
    '$os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1',
    '[pscustomobject]@{ model=$cs.Model; manufacturer=$cs.Manufacturer; cpuName=$cpu.Name; cores=$cpu.NumberOfCores; logical=$cpu.NumberOfLogicalProcessors; gpu=(@($gpu) -join " / "); osCaption=$os.Caption; osVersion=$os.Version } | ConvertTo-Json -Compress',
  ].join('; ');
  try {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 15_000);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { facts: { model: str(parsed.model), manufacturer: str(parsed.manufacturer), cpuName: str(parsed.cpuName), cores: num(parsed.cores),
                      logical: num(parsed.logical), gpu: str(parsed.gpu), osCaption: str(parsed.osCaption), osVersion: str(parsed.osVersion) } };
  } catch (error) {
    return { facts: {}, failure: error instanceof Error ? error.message : String(error) };
  }
}

async function sysctl(name: string): Promise<string | undefined> {
  try {
    const value = await run('sysctl', ['-n', name], 3_000);
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function m<T>(value: T | undefined, reason: string): Measurement<T> {
  return value === undefined ? unavailable(reason) : measured(value);
}

/**
 * macOS GPU identity as `system_profiler` reports it (the same system report the About This Mac
 * window reads). On Apple Silicon this is the chip's integrated GPU with its core count; on Intel
 * Macs it is the discrete or integrated controller. Measured only — never inferred from the CPU.
 */
export async function macGPU(): Promise<{ gpu?: string; failure?: string }> {
  try {
    const out = await run('system_profiler', ['SPDisplaysDataType', '-json'], 8_000);
    const parsed = JSON.parse(out) as { SPDisplaysDataType?: Record<string, unknown>[] };
    const names = (parsed.SPDisplaysDataType ?? []).map((entry) => {
      const model = typeof entry.sppci_model === 'string' ? entry.sppci_model.trim() : '';
      const cores = typeof entry.sppci_cores === 'string' && /^\d+$/.test(entry.sppci_cores) ? `${entry.sppci_cores}-core GPU` : '';
      return [model, cores].filter((s) => s.length > 0).join(' · ');
    }).filter((s) => s.length > 0);
    return { gpu: names.length > 0 ? names.join(' / ') : undefined };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/** The user-facing computer name macOS shows in Finder and Sharing (e.g. "Ada's MacBook Pro"), when set. */
async function macComputerName(): Promise<string | undefined> {
  try {
    const name = await run('scutil', ['--get', 'ComputerName'], 3_000);
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export async function captureEnvironment(inferenceRuntimeVersion: Measurement<string> =
  unavailable('no inference runtime is attached to this capture; live executions record the probed runtime version')): Promise<EnvironmentRecord> {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim();
  const platform = os.platform();
  const buildConfiguration = process.env.NODE_ENV === 'development' || process.env.ELECTRON_RENDERER_URL ? 'development' : 'release';
  let hardware: HardwareTruth;
  let hardwareModel: Measurement<string>;
  let osVersion: Measurement<string> = measured(`${os.type()} ${os.release()}`);
  // The machine identifier is the hostname everywhere; macOS additionally has a user-facing computer
  // name, which is what people recognise (e.g. "Ada's MacBook Pro" rather than "Adas-MacBook-Pro.local").
  let friendlyName: string | undefined;

  if (platform === 'win32') {
    const { facts, failure } = await windowsFacts();
    const notReported = (what: string) => failure ? `Windows CIM query failed (${failure}); ${what} not captured` : `Windows did not report ${what}`;
    hardwareModel = m(facts.model && facts.manufacturer ? `${facts.manufacturer} ${facts.model}` : facts.model, notReported('a system model'));
    if (facts.osCaption) osVersion = measured(`${facts.osCaption} (${facts.osVersion ?? os.release()})`);
    hardware = {
      architecture: measured(os.arch()),
      appleSilicon: measured(false),
      modelIdentifier: hardwareModel,
      chipBrand: m(facts.cpuName ?? cpuModel, notReported('a processor name')),
      totalCoreCount: measured(facts.logical ?? cpus.length),
      performanceCoreCount: unavailable('Windows reports physical and logical core counts, not performance/efficiency classes'),
      efficiencyCoreCount: unavailable('Windows reports physical and logical core counts, not performance/efficiency classes'),
      gpu: m(facts.gpu, notReported('a video controller')),
      unifiedMemoryArchitecture: unavailable('Windows does not report whether memory is unified; the lab never guesses'),
      thermalStateAtCapture: unavailable('no sanctioned Windows API reports a thermal state to this application'),
      buildConfiguration: measured(buildConfiguration),
    };
  } else if (platform === 'darwin') {
    const [model, brand, arm64, perf, eff, machine, gpuReport, productVersion, computerName] = await Promise.all([
      sysctl('hw.model'), sysctl('machdep.cpu.brand_string'), sysctl('hw.optional.arm64'), sysctl('hw.perflevel0.physicalcpu'), sysctl('hw.perflevel1.physicalcpu'), sysctl('hw.machine'),
      macGPU(), sysctl('kern.osproductversion'), macComputerName(),
    ]);
    hardwareModel = m(model, 'sysctl hw.model is not reported on this machine');
    const appleSilicon: Measurement<boolean> = arm64 === undefined ? unavailable('sysctl hw.optional.arm64 is not reported on this machine') : measured(arm64 === '1');
    // Intel Macs have no performance/efficiency split, so those sysctls are simply absent there.
    const noPerfLevels = 'measured' in appleSilicon && !appleSilicon.measured ? 'this Intel Mac has no performance/efficiency core classes' : undefined;
    hardware = {
      architecture: m(machine, 'sysctl hw.machine is not reported on this machine'),
      appleSilicon,
      modelIdentifier: hardwareModel,
      chipBrand: m(brand, 'sysctl machdep.cpu.brand_string is not reported on this machine'),
      totalCoreCount: measured(cpus.length),
      performanceCoreCount: perf === undefined ? unavailable(noPerfLevels ?? 'sysctl hw.perflevel0.physicalcpu is not reported on this machine') : measured(Number(perf)),
      efficiencyCoreCount: eff === undefined ? unavailable(noPerfLevels ?? 'sysctl hw.perflevel1.physicalcpu is not reported on this machine') : measured(Number(eff)),
      gpu: m(gpuReport.gpu, gpuReport.failure ? `system_profiler did not answer (${gpuReport.failure}); GPU not captured` : 'the macOS system report named no graphics processor'),
      unifiedMemoryArchitecture: 'measured' in appleSilicon ? measured(appleSilicon.measured) : unavailable('architecture unreadable; unified memory is never guessed'),
      thermalStateAtCapture: unavailable('the desktop application does not read the thermal state'),
      buildConfiguration: measured(buildConfiguration),
    };
    osVersion = measured(`macOS ${productVersion ?? os.release()}`);
    if (computerName) friendlyName = computerName;
  } else {
    hardwareModel = unavailable(`${platform} reports no system model to this application`);
    hardware = {
      architecture: measured(os.arch()),
      appleSilicon: measured(false),
      modelIdentifier: hardwareModel,
      chipBrand: m(cpuModel, 'the operating system reported no processor model'),
      totalCoreCount: measured(cpus.length),
      performanceCoreCount: unavailable(`${platform} does not report performance/efficiency core classes`),
      efficiencyCoreCount: unavailable(`${platform} does not report performance/efficiency core classes`),
      gpu: unavailable(`no sanctioned ${platform} API reports a GPU identity to this application`),
      unifiedMemoryArchitecture: unavailable(`${platform} does not report whether memory is unified; the lab never guesses`),
      thermalStateAtCapture: unavailable(`no sanctioned ${platform} API reports a thermal state to this application`),
      buildConfiguration: measured(buildConfiguration),
    };
  }

  return {
    machineIdentifier: m(friendlyName ?? os.hostname() ?? undefined, 'the operating system reported no hostname or computer name'),
    hardwareModel,
    cpuCoreCount: measured(cpus.length),
    physicalMemoryBytes: measured(os.totalmem()),
    osVersion,
    inferenceRuntimeVersion,
    hardware,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function summarize(environment: EnvironmentRecord): MachineSummary {
  const text = (mm: Measurement<string>, fallback: string) => ('measured' in mm ? mm.measured : fallback);
  const hw = environment.hardware;
  const cores = 'measured' in environment.cpuCoreCount ? `${environment.cpuCoreCount.measured} logical cores` : 'core count unavailable';
  return {
    environment,
    hostname: text(environment.machineIdentifier, os.platform() === 'darwin' ? 'this Mac' : 'this PC'),
    platformLabel: text(environment.osVersion, `${os.type()} ${os.release()}`),
    cpuLabel: hw ? `${text(hw.chipBrand, 'Processor not reported')} · ${cores}` : cores,
    memoryLabel: 'measured' in environment.physicalMemoryBytes ? formatBytes(environment.physicalMemoryBytes.measured) : 'memory not reported',
    gpuLabel: hw ? text(hw.gpu, 'GPU not reported') : 'GPU not reported',
    capturedAt: isoSeconds(new Date()),
  };
}
