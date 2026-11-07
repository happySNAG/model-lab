// Cernum · the view-model behind the Qualification and Routing screens. PURE: it takes the cse1
// status-export document (or the reason it could not be read) and returns rows and sentences. It reads
// nothing, writes nothing, ranks nothing and decides nothing: every verdict, expiry, chain and finding is
// the engine's, carried across unchanged. It imports no React and no bridge, so it is tested in node.

import type { StatusExport, StatusExpiryWarning } from '../engine/status-export';
import type { RoutingStatusResult } from '../shared/ipc';

/** Why a screen has no table, in words. Absent when there are rows to show. */
export type ScreenState = 'rows' | 'empty' | 'unreadable';

export interface CorruptNotice {
  /** One sentence for the top of the screen. */
  message: string;
  files: { filePath: string; reason: string }[];
}

// ---------------------------------------------------------------- Qualification

export interface QualificationRow {
  routeKey: string;
  provider: string;
  modelID: string;
  safeToRoute: boolean;
  /** "Safe to route" or "Not safe to route". */
  safeLabel: string;
  /** The newest cqh1 verdict, when the route has any history. */
  latestVerdict?: 'safeToRoute' | 'notRoutable';
  latestVerdictAt?: string;
  latestVerdictLabel: string;
  lastSuccessfulQualificationAt?: string;
  routableCapabilities: string[];
  availability: string;
  /** The expiry warning on this route, exactly as the document carries it. */
  expiry?: { state: StatusExpiryWarning['state']; expiresAt: string; reason: string };
  expiryLabel: string;
  blockers: string[];
}

export interface QualificationView {
  state: ScreenState;
  /** Set whenever state is not 'rows'. */
  message?: string;
  rows: QualificationRow[];
  safeCount: number;
  expiryWarningCount: number;
  corrupt?: CorruptNotice;
  generatedAt?: string;
  machineKey?: string;
  disclosure?: string;
}

// ---------------------------------------------------------------- Routing

export interface RouteMark {
  routeKey: string;
  regressed: boolean;
  stale: boolean;
  /** "Regressed", "Stale" or "Regressed · stale". */
  label: string;
  /** Each finding's own sentence. */
  findings: string[];
}

export interface RoutingEntryRow {
  position: number;
  routeKey: string;
  inChain: boolean;
  standingLabel: string;
  fallsThroughBecause: string[];
  regressed: boolean;
  stale: boolean;
  markLabel?: string;
}

export interface RoutingTierRow {
  tier: string;
  chain: string[];
  entries: RoutingEntryRow[];
  excludedCount: number;
  /** Set when the tier has no entries at all. */
  emptyMessage?: string;
}

export interface RoutingTaskRow {
  taskType: string;
  capability: string;
  /** In the document's order: tier1, tier2, tier3. */
  tiers: RoutingTierRow[];
}

export interface RoutingView {
  state: ScreenState;
  message?: string;
  tasks: RoutingTaskRow[];
  /** Every route the regression report found regressed or stale, by route key. */
  marked: RouteMark[];
  regressedCount: number;
  staleCount: number;
  corrupt?: CorruptNotice;
  disclosure?: string;
  generatedAt?: string;
  machineKey?: string;
}

// ---------------------------------------------------------------- shared helpers

function corruptNotice(document: StatusExport): CorruptNotice | undefined {
  if (document.corrupt.length === 0) return undefined;
  const count = document.corrupt.length;
  return {
    message: `${count} observation file${count === 1 ? '' : 's'} did not verify and ${count === 1 ? 'was' : 'were'} not read, `
      + 'so what follows may be missing evidence. Nothing was changed; the files are listed by path.',
    files: document.corrupt.map(({ filePath, reason }) => ({ filePath, reason })),
  };
}

function notCse1(document: unknown): string | undefined {
  const candidate = document as Partial<StatusExport> | null | undefined;
  if (candidate === null || typeof candidate !== 'object') return 'The status document is missing, so nothing can be shown.';
  if (candidate.schema !== 'cse1') return `The status document is not a cse1 document (it says '${String(candidate.schema)}'), so nothing is shown from it.`;
  if (!candidate.qualifiedRoutes || !Array.isArray(candidate.qualifiedRoutes.routes)
      || !candidate.fallbackChains || !Array.isArray(candidate.fallbackChains.tasks)) {
    return 'The status document is incomplete: it has no route list or no fallback chains, so nothing is shown from it.';
  }
  return undefined;
}

function unreadableMessage(root: string, reason: string): string {
  return `The routing evidence under ${root} could not be read: ${reason}. Nothing was changed.`;
}

/** Every route the regression report marks, with whether it regressed, went stale, or both. */
export function routeMarks(document: StatusExport): Map<string, RouteMark> {
  const marks = new Map<string, RouteMark>();
  for (const route of document.regressions.routes) {
    const stale = route.findings.some((finding) => finding.kind === 'staleQualification');
    const regressed = route.findings.some((finding) => finding.kind !== 'staleQualification');
    if (!stale && !regressed) continue;
    marks.set(route.routeKey, {
      routeKey: route.routeKey, regressed, stale,
      label: regressed && stale ? 'Regressed · stale' : regressed ? 'Regressed' : 'Stale',
      findings: route.findings.map((finding) => finding.summary),
    });
  }
  return marks;
}

// ---------------------------------------------------------------- Qualification

const EMPTY_QUALIFICATION = 'No routes are known on this machine yet. The observation store and the sealed runs under '
  + 'this campaign root record no route, so nothing has been qualified and nothing is safe to route.';

export function qualificationView(document: StatusExport): QualificationView {
  const problem = notCse1(document);
  if (problem !== undefined) {
    return { state: 'unreadable', message: problem, rows: [], safeCount: 0, expiryWarningCount: 0 };
  }
  const warnings = new Map((document.expiryWarnings ?? []).map((warning) => [warning.routeKey, warning]));
  const latestOf = new Map(document.recentQualificationResults.routes.map((route) =>
    [route.routeKey, route.entries[route.entries.length - 1]]));
  const rows = document.qualifiedRoutes.routes.map((route): QualificationRow => {
    const latest = latestOf.get(route.routeKey);
    const warning = warnings.get(route.routeKey);
    return {
      routeKey: route.routeKey, provider: route.provider, modelID: route.modelID,
      safeToRoute: route.safeToRoute, safeLabel: route.safeToRoute ? 'Safe to route' : 'Not safe to route',
      ...(latest === undefined ? {} : { latestVerdict: latest.verdict, latestVerdictAt: latest.recordedAt }),
      latestVerdictLabel: latest === undefined ? 'No qualification history yet'
        : `${latest.verdict === 'safeToRoute' ? 'Safe to route' : 'Not routable'} (${latest.recordedAt})`,
      ...(route.lastSuccessfulQualificationAt === undefined ? {} : { lastSuccessfulQualificationAt: route.lastSuccessfulQualificationAt }),
      routableCapabilities: route.routableCapabilities,
      availability: route.availability.state,
      ...(warning === undefined ? {} : { expiry: { state: warning.state, expiresAt: warning.expiresAt, reason: warning.reason } }),
      expiryLabel: warning === undefined ? 'No expiry warning'
        : warning.state === 'expired' ? `Expired ${warning.expiresAt}` : `Expires ${warning.expiresAt}`,
      blockers: route.blockers.map((blocker) => blocker.reason || blocker.kind),
    };
  });
  const corrupt = corruptNotice(document);
  return {
    state: rows.length === 0 ? 'empty' : 'rows',
    ...(rows.length === 0 ? { message: EMPTY_QUALIFICATION } : {}),
    rows,
    safeCount: rows.filter((row) => row.safeToRoute).length,
    expiryWarningCount: (document.expiryWarnings ?? []).length,
    ...(corrupt === undefined ? {} : { corrupt }),
    generatedAt: document.generatedAt, machineKey: document.machineKey, disclosure: document.disclosure,
  };
}

// ---------------------------------------------------------------- Routing

const EMPTY_ROUTING = 'No route is in any fallback chain yet. No route on this machine holds the qualification a task '
  + 'type asks for, so every chain below is empty. Nothing is routed from here.';

export function routingView(document: StatusExport): RoutingView {
  const problem = notCse1(document);
  if (problem !== undefined) {
    return { state: 'unreadable', message: problem, tasks: [], marked: [], regressedCount: 0, staleCount: 0 };
  }
  const marks = routeMarks(document);
  const tasks = document.fallbackChains.tasks.map((task): RoutingTaskRow => ({
    taskType: task.taskType, capability: task.capability,
    tiers: task.tiers.map((tier): RoutingTierRow => {
      const entries = tier.entries.map((entry): RoutingEntryRow => {
        const mark = marks.get(entry.routeKey);
        return {
          position: entry.position, routeKey: entry.routeKey, inChain: entry.standing === 'inChain',
          standingLabel: entry.standing === 'inChain' ? 'In chain' : 'Falls through',
          fallsThroughBecause: entry.fallsThroughBecause,
          regressed: mark?.regressed ?? false, stale: mark?.stale ?? false,
          ...(mark === undefined ? {} : { markLabel: mark.label }),
        };
      });
      return {
        tier: tier.tier, chain: tier.chain, entries, excludedCount: tier.excluded.length,
        ...(entries.length === 0 ? { emptyMessage: `No qualified route for ${task.taskType} at ${tier.tier}.` } : {}),
      };
    }),
  }));
  const anyEntry = tasks.some((task) => task.tiers.some((tier) => tier.entries.length > 0));
  const marked = [...marks.values()].sort((a, b) => (a.routeKey < b.routeKey ? -1 : a.routeKey > b.routeKey ? 1 : 0));
  const corrupt = corruptNotice(document);
  return {
    state: anyEntry ? 'rows' : 'empty',
    ...(anyEntry ? {} : { message: tasks.length === 0 ? 'The status document lists no task types, so there is no fallback chain to show.' : EMPTY_ROUTING }),
    tasks, marked,
    regressedCount: marked.filter((mark) => mark.regressed).length,
    staleCount: marked.filter((mark) => mark.stale).length,
    ...(corrupt === undefined ? {} : { corrupt }),
    disclosure: document.fallbackChains.disclosure, generatedAt: document.generatedAt, machineKey: document.machineKey,
  };
}

// ---------------------------------------------------------------- from the bridge's answer

export function qualificationViewOf(result: RoutingStatusResult): QualificationView {
  if (!result.ok) return { state: 'unreadable', message: unreadableMessage(result.root, result.reason), rows: [], safeCount: 0, expiryWarningCount: 0 };
  return qualificationView(result.document);
}

export function routingViewOf(result: RoutingStatusResult): RoutingView {
  if (!result.ok) {
    return { state: 'unreadable', message: unreadableMessage(result.root, result.reason), tasks: [], marked: [], regressedCount: 0, staleCount: 0 };
  }
  return routingView(result.document);
}
