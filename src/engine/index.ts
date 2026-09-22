// Benchmark engine · the public surface.
//
// The Electron main process (`src/main/campaign-service.ts`) and the terminal command
// (`src/cli/cernum.ts`) both import from HERE and nowhere deeper. Keeping the boundary to one
// module is what makes "the same campaign, observed from either" a structural fact rather than a
// convention two callers are trusted to follow.

export * from './canonical';
export * from './provider';
export * from './redaction';
export * from './credentials';
export * from './cli-process';
export * from './discovery';
export * from './opencode-adapter';
export * from './discovery-store';
export * from './reconciliation';
export * from './identity-admission';
export * from './cost-eligibility';
export * from './identity-smoke';
export * from './smoke-binding';
export * from './spending';
export * from './frontier-metrics';
export * from './frontier-adapter';
export * from './machine';
export * from './scoring';
export * from './ledger';
export * from './lock';
export * from './execution';
export * from './runtime-lease';
export * from './manifest';
export * from './guards';
export * from './residency';
export * from './verification';
export * from './attempt-telemetry';
export * from './isolation';
export * from './workspace-scope';
export * from './workspace-path-reconciliation';
export * from './workspace-tree';
export * from './workspace-case';
export * from './workspace-pack';
export * from './workspace-catalog';
export * from './workspace-catalog-tier-two';
export * from './workspace-catalog-tier-three';
export * from './workspace-catalog-discriminator';
export * from './workspace-difficulty';
export * from './workspace-difficulty-catalog';
export * from './workspace-discriminator';
export * from './workspace-discriminator-catalog';
export * from './workspace-hidden-script';
export * from './workspace-transcript';
export * from './workspace-agent';
export * from './workspace-execution';
export * from './workspace-scoring';
export * from './workspace-host';
export * from './workspace-binding';
export * from './workspace-campaign';
export * from './workspace-aggregate';
export * from './workspace-routing-evidence';
export * from './workspace-empirical-evidence';
export * from './workspace-throttle';
export * from './workspace-matrix';
export * from './workspace-matrix-admission';
export * from './workspace-cell-selection';
export * from './workspace-continuation';
export * from './workspace-effort-evidence';
export * from './workspace-matrix-telemetry';
export * from './provider-session-status';
export * from './workspace-claude-driver';
export * from './workspace-codex-driver';
export * from './workspace-opencode-driver';
export * from './workspace-ollama-driver';
export * from './execution-sandbox';
export { publishedPriceFor, snapshotFor, OPENCODE_ZEN_PUBLISHED_PRICES, OPENCODE_ZEN_PRICING_CAPTURED_AT, OPENCODE_ZEN_PRICING_SOURCE } from './opencode-pricing';
export type { PublishedCataloguePrice } from './opencode-pricing';
export * from './blinded';
export * from './adjudication';
export * from './adjudication-markdown';
export * from './adjudication-build';
export * from './attempt-disposition';
export * from './prepared-manifest';
export * from './rulings';
export * from './ranking';
export * from './json-views';
export * from './otlp-observer';
export * from './retention';
export * from './catalogue';
export * from './campaign';
export * from './campaign-builder';
export * from './synthetic';
export * from './live-host';
export * from './frontier-host';
export * from './host-factory';

// The development runner. Named rather than `export *`, so the terminal's development commands reach
// exactly what they call and the engine's public surface grows by nothing else.
export {
  DevelopmentPlanError, buildDevelopmentPlan, describeDevelopmentPlan,
} from './development-plan';
export type { DevelopmentCampaignPlan, DevelopmentCandidateRequest } from './development-plan';
export {
  DevelopmentCampaignError, contractVersionRefusal, createDevelopmentCampaign, openDevelopmentCampaign,
  promptVersionRefusal, runDevelopmentCampaign, unrunnableAttempts,
} from './development-campaign';
export type { DevelopmentProgressEvent } from './development-campaign';
export {
  buildDevelopmentCampaignReport, describeDevelopmentCampaignReport, readDevelopmentCampaignState,
} from './development-report';
export type { DevelopmentCampaignReport } from './development-report';
export {
  DEVELOPMENT_REINTERPRETATIONS_DIRECTORY, describeDevelopmentReinterpretation, listDevelopmentReinterpretations,
  reinterpretDevelopmentCampaign,
} from './development-reinterpretation';
export type { DevelopmentReinterpretation } from './development-reinterpretation';
export {
  DEVELOPMENT_EDIT_EVIDENCE_DIRECTORY, MAX_EDIT_EVIDENCE_CHANGED_FILES, MAX_EDIT_EVIDENCE_RETAINED_BYTES,
  buildEditEvidence, readVerifiedEditEvidence,
} from './development-edit-evidence';
export type { DevelopmentEditEvidence, EditEvidenceReference } from './development-edit-evidence';
export { readBenchmarkCommit, readWorkingTreeDirty } from './development-provenance';
export {
  DEVELOPMENT_EXECUTABLE_PROVIDERS, DevelopmentEligibilityError, SYNTHETIC_DEVELOPMENT_PROVIDER,
  SyntheticDevelopmentAdapter, developmentExecutionRefusals, parseSyntheticDevelopmentScript,
} from './development-synthetic';
// Free + local route enablement: structured descriptions, refresh and staleness, machines, the
// qualification read model, the spend posture, and the Ordra-facing candidate contract.
export * from './model-description';
export * from './discovery-refresh';
export * from './machine-availability';
export * from './route-spend-posture';
export * from './route-qualification';
export * from './routing-contract';
