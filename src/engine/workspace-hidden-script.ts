// Benchmark engine · how a HIDDEN check is written, and why it is never a file in the tree.
//
// `WorkspaceVerification.hiddenCommands` are the checks the agent is never TOLD about — they are
// absent from the instruction and from the visible command list. A hidden check written as a file
// under `test/` would still be sitting in the tree the model was handed, so the fastest way to see
// it is `ls test/`, and "hidden" would mean nothing. `node -e` puts the script in the ARGUMENT
// VECTOR of a command this engine runs after the agent has stopped, so it is in the frozen case, in
// the record and in the transcript, and never in the workspace.
//
// Each one is written as an array of lines so it can be read where it is declared, and requires the
// package by its published path exactly as a consumer would — `node -e` resolves `./src/…` against
// the working directory, which the runner sets to the workspace root.
//
// THEY ARE NOT SECRET AFTER THE FACT. A hidden check that fails is quoted back verbatim in the retry
// briefing the next attempt receives, which is exactly what makes a recovery case measure recovery
// rather than resampling. Hidden means undisclosed in advance, not withheld from the record.
//
// AND THEY ARE NOT TRAPS. Every hidden check in this catalogue asks for a consequence the repository
// ALREADY STATES — in a README, in a document under `docs/`, or in a doc comment on the function
// being asked about — so a model that reads before it edits can pass first time and a model that
// patches until green cannot. A hidden check testing something nobody could have known is a check
// that measures luck. Each script below quotes the document it is enforcing in its own assertion
// messages, which is also what makes the retry briefing useful rather than cryptic.

export const hiddenScript = (lines: string[]): string => lines.join('\n');
