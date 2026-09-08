// Benchmark engine · unload the benchmark model and PROVE nothing is resident before the next
// candidate loads. A port of the proven `residency_v2.py`.
//
// WHY THIS IS AN ABORT CONDITION RATHER THAN A WARNING. Two models resident at once means swap,
// and swap means the next candidate's latency measures the disk rather than the model. Worse, it
// is invisible in the result: every attempt still returns text. A residual model does not corrupt
// a score, it corrupts the COMPARISON, which is the only thing a benchmark produces.
//
// WHAT "PROVE" MEANS. Not "we issued an unload". The runner issues the unload, waits, and then
// READS THE RESIDENT SET BACK. If anything is still resident after the grace period, the campaign
// aborts with the resident set recorded. An unload that reports success and leaves a model
// resident is precisely the failure this guard exists to catch, so its own success message is not
// evidence.
//
// LIVE PROBES ARE GATED. The live controller refuses to run unless explicitly enabled, and it is
// never enabled in a readiness pass: the synthetic campaign drives `ScriptedResidency` instead.
// That gate is why this module is exhaustively testable without a request reaching any server.

import { CanonicalValue } from './canonical';

export class ResidencyError extends Error {
  constructor(message: string, readonly detail: CanonicalValue) {
    super(message);
    this.name = 'ResidencyError';
  }
}

export interface ResidencyProof {
  model: string;
  verifiedEmpty: boolean;
  rounds: number;
  trace: { round: number; resident: string[] }[];
}

export interface ResidencyController {
  resident(): Promise<string[]>;
  unload(model: string): Promise<void>;
}

export interface UnloadOptions {
  attempts?: number;
  delayMilliseconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const realSleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Ask, wait, read back. Returns a proof; throws `ResidencyError` if anything remains.
 *
 * The retry loop exists because an unload is asynchronous — the server returns before the weights
 * are actually released. Retrying a READ is not the same as retrying an unload: the unload is
 * requested once per round, and what is retried is the proof.
 */
export async function unloadAndVerify(controller: ResidencyController, model: string, options: UnloadOptions = {}): Promise<ResidencyProof> {
  const attempts = options.attempts ?? 6;
  const delay = options.delayMilliseconds ?? 5_000;
  const sleep = options.sleep ?? realSleep;
  const trace: { round: number; resident: string[] }[] = [];
  for (let round = 0; round < attempts; round++) {
    await controller.unload(model);
    if (round > 0 || delay > 0) await sleep(delay);
    const resident = [...(await controller.resident())];
    trace.push({ round: round + 1, resident });
    if (resident.length === 0) return { model, verifiedEmpty: true, rounds: round + 1, trace };
  }
  const detail = {
    model, verifiedEmpty: false, rounds: attempts, trace: trace as unknown as CanonicalValue,
    why: `the benchmark lane still reports a resident model after ${attempts} unload rounds; continuing would measure the next candidate against a machine that is already holding weights`,
  };
  throw new ResidencyError(`${model} is still resident after ${attempts} unload rounds`, detail as CanonicalValue);
}

/**
 * Deterministic controller for tests and the synthetic campaign.
 *
 * `script` maps a model name to the number of unload rounds it takes to clear, or `'never'` for a
 * model that refuses to release — which is how the residency-failure abort is exercised without
 * needing a real stuck server.
 */
export class ScriptedResidency implements ResidencyController {
  private residentSet = new Set<string>();
  private roundsSoFar = new Map<string, number>();

  constructor(private readonly script: Record<string, number | 'never'> = {}) {}

  load(model: string): void {
    this.residentSet.add(model);
    this.roundsSoFar.set(model, 0);
  }

  async resident(): Promise<string[]> {
    return [...this.residentSet].sort();
  }

  async unload(model: string): Promise<void> {
    const behaviour = this.script[model] ?? 1;
    if (behaviour === 'never') return;
    const rounds = (this.roundsSoFar.get(model) ?? 0) + 1;
    this.roundsSoFar.set(model, rounds);
    if (rounds >= behaviour) this.residentSet.delete(model);
  }
}

export class LiveResidencyDisabled extends Error {
  constructor() {
    super('the live residency controller is disabled; it is never enabled in a readiness pass, and the synthetic campaign uses ScriptedResidency instead');
    this.name = 'LiveResidencyDisabled';
  }
}

/** Talks to the benchmark lane and nothing else, and only when explicitly enabled. */
export class LiveResidency implements ResidencyController {
  constructor(
    private readonly listRunning: () => Promise<string[]>,
    private readonly requestUnload: (model: string) => Promise<void>,
    private readonly enabled: boolean,
  ) {}

  private guard(): void {
    if (!this.enabled) throw new LiveResidencyDisabled();
  }

  async resident(): Promise<string[]> {
    this.guard();
    return this.listRunning();
  }

  async unload(model: string): Promise<void> {
    this.guard();
    await this.requestUnload(model);
  }
}
