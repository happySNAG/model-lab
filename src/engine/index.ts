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
export * from './workspace-transcript';
export * from './workspace-agent';
export * from './workspace-execution';
export * from './workspace-scoring';
export * from './workspace-host';
export * from './workspace-binding';
export * from './workspace-campaign';
export * from './workspace-aggregate';
export * from './workspace-throttle';
export * from './workspace-matrix';
export * from './provider-session-status';
export * from './workspace-claude-driver';
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
