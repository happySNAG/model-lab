// Benchmark engine · the public surface.
//
// The Electron main process (`src/main/campaign-service.ts`) and the terminal command
// (`src/cli/cernum.ts`) both import from HERE and nowhere deeper. Keeping the boundary to one
// module is what makes "the same campaign, observed from either" a structural fact rather than a
// convention two callers are trusted to follow.

export * from './canonical';
export * from './ledger';
export * from './manifest';
export * from './guards';
export * from './residency';
export * from './verification';
export * from './attempt-telemetry';
export * from './isolation';
export * from './blinded';
export * from './ranking';
export * from './retention';
export * from './catalogue';
export * from './campaign';
export * from './synthetic';
export * from './live-host';
