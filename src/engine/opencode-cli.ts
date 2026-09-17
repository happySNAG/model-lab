// Cernum · the OpenCode CLI, as it actually behaves.
//
// EVERY FACT IN THIS MODULE WAS OBSERVED, not read from documentation and not assumed. The surface
// below was probed against `opencode-ai@1.18.31` on macOS 15.7.7 before a line of it was written,
// because this engine has made the opposite mistake once already: Pass 4B asked `claude` for a
// `models` subcommand it does not have, inferred authentication from prose, and returned `unknown`
// on every run for weeks. See the correction note in `discovery.ts`.
//
// -- THE OBSERVED SURFACE ----------------------------------------------------------------------
//
//   opencode --version            -> a bare semantic version on one line: `1.18.31`. No prefix, no
//                                   product name. `claude` and `codex` both prefix theirs; this one
//                                   does not, so it gets its own parser rather than a shared one.
//
//   opencode models               -> one `provider/model` per line, 70 of them, newline separated,
//                                   no header and no decoration. THERE IS NO `--json`; asking for
//                                   one prints the help text and exits 0, which is why the parser
//                                   below refuses any line that is not exactly `a/b`.
//
//   opencode providers list       -> a decorated box listing credential NAMES and a count, e.g.
//                                   `*  OpenCode Zen [api]` and `1 credentials`. Also no `--json`.
//                                   It names the service and the KIND of credential; it does not say
//                                   whether that credential still works.
//
//   opencode run --format json    -> raw JSON events. This is the execution path, and it is the only
//                                   one of the four that spends anything.
//
//   opencode run --variant <e>    -> "provider-specific reasoning effort, e.g. high, max, minimal".
//                                   OpenCode's name for what this engine calls an effort level.
//
// -- WHY OPENCODE IS CLASSED AS A METERED API AND NOT AS A SUBSCRIPTION CLI --------------------
//
// It is a subscription CLI in shape -- a tool you install and authenticate yourself -- but not in
// BILLING, and billing is what the execution class exists to describe. The credential observed on
// this machine is `OpenCode Zen [api]`: an API key against a metered service, charged per token.
//
// Classing it `subscriptionCLI` would give every OpenCode row `subscriptionIncluded` and a zero
// marginal charge, which is the precise failure `codexCLI` already refuses by hand -- it rejects an
// API-key Codex session rather than report a real charge as free. Doing the same thing for a whole
// provider would be worse, not better.
//
// So OpenCode rows are `meteredAPI`, and Cernum ships this support labelled UNTESTED METERED API
// rather than alongside the two subscription CLIs it has actually run campaigns through.

import { ProviderID } from './provider';

/** The executable, as OpenCode installs it. */
export const OPENCODE_EXECUTABLE = 'opencode';

export const OPENCODE_PROVIDER: ProviderID = 'opencodeCLI';

/**
 * The canonical identifier for Union Alpha, fixed by the project.
 *
 * OpenCode addresses models as `provider/model`, so this is not a Cernum convention laid over
 * OpenCode's -- it is OpenCode's own addressing, used unchanged.
 */
export const UNION_ALPHA_MODEL_ID = 'opencode/union-alpha';

/** The arguments that read state without spending anything. None of these reaches a model. */
export const OPENCODE_VERSION_ARGUMENTS = ['--version'];
export const OPENCODE_MODELS_ARGUMENTS = ['models'];
export const OPENCODE_CREDENTIALS_ARGUMENTS = ['providers', 'list'];

/**
 * OpenCode prints a bare version and nothing else.
 *
 * Returns the trimmed first line when it looks like a version, and `undefined` when it does not --
 * never the raw line, so a help screen or an error can never be recorded as a version string.
 */
export function parseOpenCodeVersion(stdout: string): string | undefined {
  const first = stdout.trim().split('\n')[0]?.trim() ?? '';
  return /^\d+\.\d+\.\d+/.test(first) ? first : undefined;
}

/**
 * Parse `opencode models`.
 *
 * Accepts ONLY lines that are exactly `provider/model` with no whitespace. `opencode models --json`
 * prints the help screen and exits 0, and a looser parser would happily read `Positionals:` or
 * `provider  path to start opencode in` as model identifiers.
 */
export function parseOpenCodeModels(stdout: string): string[] {
  const seen = new Set<string>();
  for (const raw of stdout.split('\n')) {
    const line = stripDecoration(raw).trim();
    if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(line)) continue;
    seen.add(line);
  }
  return [...seen].sort();
}

export interface OpenCodeCredential {
  /** The service as OpenCode names it, e.g. `OpenCode Zen`. Never a key, never an account. */
  service: string;
  /** The credential KIND OpenCode reports in brackets, e.g. `api`. */
  kind: string;
}

/** OpenCode colours its output. Strip SGR sequences before matching anything. */
function stripDecoration(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[[0-9;]{1,4}m/g, '');
}

/**
 * Parse `opencode providers list`.
 *
 * THE KIND IS DELIMITED BY A COLOUR ESCAPE, NOT BY PUNCTUATION. The bytes, captured with `cat -v`:
 *
 *     <U+250C>  Credentials <ESC>[90m~/.local/share/opencode/auth.json
 *     <U+25D7>  OpenCode Zen <ESC>[90mapi
 *     <U+2514>  1 credentials
 *
 * So `api` is not bracketed -- it is dimmed. An earlier version of this parser looked for
 * `[kind]` and silently matched nothing, which cost the one fact that matters most here: the
 * credential KIND is the evidence for classing OpenCode as a metered API rather than a
 * subscription. It is parsed at the escape boundary, and the box-drawing header and footer are
 * excluded by glyph so `Credentials` never reads as a service name.
 *
 * Nothing retained here is an account identifier -- no email, no key, no organisation -- and
 * nothing here claims the credential still works. It reports only what OpenCode has configured.
 */
export function parseOpenCodeCredentials(stdout: string): { credentials: OpenCodeCredential[]; reportedCount?: number } {
  const credentials: OpenCodeCredential[] = [];
  let reportedCount: number | undefined;
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const plain = stripDecoration(line).trim();

    const total = /^[\u2500-\u257F\s]*?(\d+)\s+credentials?\s*$/.exec(plain);
    if (total) { reportedCount = Number(total[1]); continue; }

    // An entry begins with a Geometric Shapes bullet. Box-drawing glyphs (U+2500-U+257F) are the
    // frame -- the header and footer -- and are never entries.
    const bulleted = /^[\u25A0-\u25FF\u2022*]\s+(.*)$/.exec(line.trim());
    if (!bulleted) continue;
    const body = bulleted[1];

    // Preferred: the colour escape that separates service from kind.
    const escaped = /^(.*?)\s*\x1b\[[0-9;]*m\s*(\S+)\s*$/.exec(body);
    if (escaped) {
      credentials.push({ service: escaped[1].trim(), kind: escaped[2].trim() });
      continue;
    }
    // Fallback: a bracketed kind, for a build that renders without colour.
    const bracketed = /^(.*?)\s*\[([^\]]+)\]\s*$/.exec(stripDecoration(body));
    if (bracketed) {
      credentials.push({ service: bracketed[1].trim(), kind: bracketed[2].trim() });
      continue;
    }
    // A bullet with no separable kind still counts as a configured credential, kind unknown.
    const only = stripDecoration(body).trim();
    if (only.length > 0) credentials.push({ service: only, kind: 'unknown' });
  }
  return { credentials, reportedCount };
}

/** True when OpenCode reports at least one configured credential. Not a claim that it is valid. */
export function opencodeHasCredential(parsed: ReturnType<typeof parseOpenCodeCredentials>): boolean {
  return parsed.credentials.length > 0 || (parsed.reportedCount ?? 0) > 0;
}

/**
 * What a reader must be told about an OpenCode credential, in the words that are true.
 *
 * OpenCode is bring-your-own-credential: the same binary reaches a metered API service, and could
 * reach something else entirely if the user logged a different provider in. This engine reports what
 * OpenCode told it and refuses to translate `api` into `subscription`.
 */
export function opencodeCredentialDisclosure(parsed: ReturnType<typeof parseOpenCodeCredentials>): string {
  if (!opencodeHasCredential(parsed)) {
    return 'OpenCode reports no configured credential. Sign in yourself with `opencode providers login`; '
      + 'Cernum never installs a CLI, never logs one in, and never reads its stored session.';
  }
  const kinds = [...new Set(parsed.credentials.map((c) => c.kind))].sort();
  const services = [...new Set(parsed.credentials.map((c) => c.service))].sort();
  return `OpenCode reports ${parsed.reportedCount ?? parsed.credentials.length} configured credential(s)`
    + (services.length ? ` for ${services.join(', ')}` : '')
    + (kinds.length ? ` (kind: ${kinds.join(', ')})` : '')
    + '. That a credential is configured is not a claim that it is valid, funded, or that any model will answer.';
}

/**
 * The cost position for an OpenCode row, stated rather than computed.
 *
 * Cernum has no pricing table for OpenCode Zen and no provider-reported charge to read, so there is
 * no honest way to put a number on an OpenCode request. `unavailable` is the answer, and it is the
 * answer on every artefact, rather than a zero that would read as free.
 */
export const OPENCODE_COST_PROVENANCE = 'unavailable' as const;
export const OPENCODE_COST_EXPLANATION =
  'OpenCode Zen is a metered API. Cernum holds no pricing for it and OpenCode reports no per-request '
  + 'charge to this interface, so the cost of an OpenCode attempt is UNAVAILABLE -- not zero, not free, '
  + 'and not estimated. Token counts are recorded where OpenCode reports them.';

/**
 * WHAT `opencode models` IS, ESTABLISHED BY LOOKING AT WHERE THE ANSWER COMES FROM.
 *
 * v0.2.1 recorded every model this listing returned as `proven` — the state that means "this account
 * can invoke it" and the only state a campaign may select. That was wrong, and the evidence is on
 * disk: OpenCode answers `models` out of `~/.cache/opencode/models.json`, a cached catalogue that on
 * this machine held **7,850 models across 221 providers** — a description of the world, not of the
 * account. `opencode models opencode` narrows it to one provider, and printed 70 of the 103 entries
 * the catalogue carries there, so some filtering happens; none of it is a per-model entitlement
 * check, and not one byte of it is a reply from a model.
 *
 * This is the SAME failure this engine already refuses for Codex, written down in `discovery.ts`:
 * `codex debug models` renders a catalogue of what the client knows about, the service refuses
 * models that appear in it, and so a listing proves nothing about this account. OpenCode was given
 * the opposite treatment by accident.
 *
 * So an OpenCode model is DISCOVERED and UNPROVEN. Holding a credential is not proof either: a
 * configured key says a service was signed into, never that a particular model will answer. Proof
 * requires a request that was authorized, was sent, came back, and was written down.
 */
export const OPENCODE_LISTING_IS_A_CATALOGUE =
  '`opencode models` is read from OpenCode\'s locally cached model catalogue, not from a per-model '
  + 'entitlement check and not from any reply by a model. That OpenCode can name a model is not evidence '
  + 'that this credential may call it, so every OpenCode model is recorded as DISCOVERED and UNPROVEN.';

/**
 * HOW AN OPENCODE MODEL BECOMES PROVEN, AND EXACTLY HOW FAR ONE REQUEST CAN CARRY IT.
 *
 * WHAT THIS REPLACES, AND WHY. v0.2.2 shipped `OPENCODE_NO_PROOF_PATH`, which said Cernum "cannot
 * prove an OpenCode model today: it has no OpenCode execution adapter". That was true when it was
 * written and stopped being true in v0.2.3, when `OpenCodeAdapter` landed and `cernum smoke
 * opencodeCLI` began driving it. The sentence stayed. Worse, it is a DISCOVERY string: it was
 * written into `discovered.json` beside every OpenCode model on every run, so the store filled up
 * with a claim the same build could disprove, and a person reading `unproven` was told not to go
 * looking for a command that had existed for a release. See `supersedeStaleOpenCodeEvidence` in
 * `discovery-store.ts` for what happens to the rows that already carry it: they are corrected in
 * place and the original text is KEPT, because a record that was wrong is still a record.
 *
 * THE THREE STATES, AND THE DISTANCE BETWEEN THEM.
 *
 *   DISCOVERED       `opencode models` named it. This is a cached catalogue and it is not evidence
 *                    about this credential. Never selectable.
 *   EXECUTION PROVEN a request was AUTHORIZED, sent, and came back. That establishes that this
 *                    credential reached this service and something answered it. It is a fact about
 *                    execution, and on its own it is not a fact about identity.
 *   IDENTITY PROVEN  the assistant message carried `providerID` and `modelID`, and they matched what
 *                    was asked for. OpenCode does return these, which is why an OpenCode smoke can
 *                    reach a state a Codex smoke cannot — and it is read from the reply, never
 *                    copied from the request. A reply naming a different model is a substitution and
 *                    is recorded as refused. A reply naming nothing stays unproven.
 *
 * So an authorized successful request proves execution, and proves identity ONLY to the degree the
 * returned identity evidence supports. Nothing about holding a credential, and nothing about the
 * length of a listing, moves a model between these states.
 */
export const OPENCODE_PROOF_PATH =
  'An OpenCode model becomes selectable only through an AUTHORIZED request that was sent and came back: '
  + '`cernum smoke opencodeCLI --models <id> --pricing <file> --authorize-metered <dollars>`, or with no prices, '
  + '`--authorize-unpriced-metered` for exactly one request. OpenCode is billed per token against your own '
  + 'credential, so that request costs money and is refused without the authorization. A successful request proves '
  + 'EXECUTION; it proves IDENTITY only as far as the returned `providerID`/`modelID` support, and a reply that names '
  + 'no model leaves the candidate unproven.';

/**
 * The v0.2.2 sentence, kept verbatim so contaminated rows can be RECOGNISED rather than guessed at.
 *
 * It is matched on a distinctive fragment rather than on the whole string, because the discovery
 * evidence interpolates it into a longer sentence and a later edit to the surrounding prose must not
 * make the stale rows unfindable.
 */
export const OPENCODE_SUPERSEDED_NO_PROOF_PATH_FRAGMENT = 'no OpenCode execution adapter';

export const OPENCODE_SUPERSEDED_NO_PROOF_PATH =
  'Cernum cannot prove an OpenCode model today: it has no OpenCode execution adapter, so there is no '
  + 'authorized request it could make and record. Until one exists, no OpenCode model is selectable for '
  + 'a campaign. `cernum smoke` drives the subscription CLIs only and will refuse opencodeCLI by name.';

/** Named so nobody mistakes "Cernum can address this model" for "Cernum has benchmarked it". */
export const OPENCODE_SUPPORT_MATURITY =
  'UNTESTED METERED API. Cernum can discover OpenCode, read its version, list its models and see whether '
  + 'a credential is configured -- all without spending anything -- and, under an explicit metered authorization, '
  + 'send it a single identity request. No scored Cernum campaign has been run through OpenCode, no live OpenCode '
  + 'request has been made by this engine, and no OpenCode result is published anywhere in this repository.';
