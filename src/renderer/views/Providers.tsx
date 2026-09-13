import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type { ProviderStatusRow, FrontierModelRow } from '../../shared/ipc';
import { Card, Modal, Pill, when } from '../components';

// Who can answer a benchmark, how they are reached, and what has actually been established about
// each one.
//
// THE CENTRAL HONESTY OF THIS SCREEN is that opening it contacts nothing. It is a PATH lookup and a
// credential check, and it says so on every row. That is why most rows read `unknown`: whether a
// subscription is signed in, and which models an account may call, cannot be learned without running
// something, and running something is a thing a person asks for — never a side effect of looking.
//
// The second honesty is that a model NAME is not a capability. The testing ladder is shown because a
// person needs to know what the plan is, and every entry on it is marked `unproven` until discovery
// or an identity smoke test says otherwise. Nothing unproven can be put in a campaign.

function reachabilityTone(reachability: string): 'ok' | 'warn' | 'bad' | 'neutral' | 'accent' {
  if (reachability === 'ready') return 'ok';
  if (reachability === 'notInstalled' || reachability === 'noCredential') return 'warn';
  if (reachability === 'unreachable' || reachability === 'notAuthenticated') return 'bad';
  return 'neutral';
}

function reachabilityLabel(reachability: string): string {
  switch (reachability) {
    case 'ready': return 'ready';
    case 'notInstalled': return 'not installed';
    case 'notAuthenticated': return 'not signed in';
    case 'noCredential': return 'no key';
    case 'unreachable': return 'unreachable';
    default: return 'not checked';
  }
}

function executionLabel(executionClass: string): string {
  if (executionClass === 'localRuntime') return 'local';
  if (executionClass === 'subscriptionCLI') return 'subscription';
  return 'metered API';
}

/** The three cost stories, in the words that are true rather than the words that are short. */
function billingSentence(executionClass: string): string {
  if (executionClass === 'localRuntime') {
    return 'Runs on this machine. No monetary cost, and prompts never leave. Wall-clock time is still recorded.';
  }
  if (executionClass === 'subscriptionCLI') {
    return 'Runs through a subscription you already pay for. The marginal API charge is $0 — which is not the same as '
      + 'free: it consumes a finite allowance, and prompts leave this machine.';
  }
  return 'Billed per token against your own API key. No request is sent without a recorded authorization and a hard '
    + 'spending ceiling, and prompts leave this machine.';
}

function availabilityTone(availability: string): 'ok' | 'warn' | 'bad' | 'neutral' | 'accent' {
  if (availability === 'proven') return 'ok';
  if (availability === 'refused') return 'bad';
  return 'neutral';
}

function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const unwrapped = /^Error invoking remote method '[^']*':\s*([\s\S]+)$/.exec(raw);
  const withoutChannel = unwrapped ? unwrapped[1] : raw;
  return withoutChannel.replace(/^[A-Za-z]*Error:\s*/, '');
}

export function ProvidersView({ shell }: { shell: Shell }) {
  const [rows, setRows] = useState<ProviderStatusRow[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [confirming, setConfirming] = useState<ProviderStatusRow>();

  const refresh = useCallback(async () => {
    try { setRows(await api.providerStatuses()); }
    catch (e) { setError(readableError(e)); }
  }, []);

  // Safe to poll: this reaches nothing. A screen that had to contact five providers to render would
  // be a screen nobody could leave open.
  useEffect(() => { void refresh(); }, [refresh]);

  const discover = async (provider: ProviderStatusRow) => {
    setBusy(provider.provider);
    setError(undefined);
    try {
      await api.discoverProvider(provider.provider);
      await refresh();
      shell.toast(`Asked ${provider.label} what this account can call.`);
    } catch (e) { setError(readableError(e)); }
    finally { setBusy(undefined); setConfirming(undefined); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Providers</h1>
          <p>
            Who can answer a benchmark, and how they are reached. A model that runs on this machine, one that runs
            through a subscription you already pay for, and one that is billed per token are three different things —
            their answers can be compared, their speed and their cost cannot.
          </p>
        </div>
      </div>

      {error && <div className="note bad">{error}</div>}

      <div className="note">
        <strong>Opening this screen contacted nothing.</strong> Everything below is a lookup on this machine: whether a
        command is installed, and whether a key is configured. Whether a subscription is signed in, and which models your
        account may call, can only be learned by running something — so nothing here has, and nothing will until you ask.
      </div>

      {rows === undefined ? <Card><p className="muted">Loading…</p></Card> : rows.map((row) => (
        <Card key={row.provider} title={<>
          {row.label}{' '}
          <Pill tone={reachabilityTone(row.reachability)}>{reachabilityLabel(row.reachability)}</Pill>{' '}
          <Pill tone="neutral">{executionLabel(row.executionClass)}</Pill>
        </>} actions={row.provider !== 'ollama' && (
          <button className="btn" disabled={busy !== undefined} data-testid={`discover-${row.provider}`}
                  onClick={() => setConfirming(row)}>
            {busy === row.provider ? 'Asking…' : 'Ask what this account can call'}
          </button>
        )}>
          <p className="muted small">{billingSentence(row.executionClass)}</p>
          <p>{row.detail}</p>

          <dl className="kv">
            {row.executablePath && <><dt>Command</dt><dd className="mono small">{row.executablePath}</dd></>}
            {row.version && <><dt>Version</dt><dd className="mono small">{row.version}</dd></>}
            {row.credential && <>
              <dt>Key</dt><dd className="small">{row.credential.masked}</dd>
              <dt>Read from</dt><dd className="mono small">{row.credential.environmentVariable} · Keychain {row.credential.keychainService}</dd>
            </>}
            <dt>This reading</dt>
            <dd className="small">{row.probe === 'offline' ? 'contacted nothing' : 'this provider was invoked'} · {when(row.checkedAt)}</dd>
          </dl>

          {row.credential && !row.credential.present && (
            <div className="note warn">
              <p>{row.credential.remedy}</p>
              <p className="small">
                The key is never written to disk by Model Lab, never stored in a campaign, a manifest, a log or a
                report, and is never shown here at any length.
              </p>
            </div>
          )}

          {row.executionClass === 'subscriptionCLI' && (
            <p className="muted small">
              Model Lab runs the official command you installed and signed into yourself. It never reads its stored
              session or token files, never reuses a browser session, and never reaches the service any other way.
            </p>
          )}

          {row.models.length > 0 && <ModelTable models={row.models} />}
          {row.models.length === 0 && row.provider !== 'ollama' && (
            <p className="muted small">
              No model has been proven callable for this provider yet, so none of them can be put in a campaign.
            </p>
          )}
        </Card>
      ))}

      {confirming && (
        <Modal title={`Ask ${confirming.label}?`} onClose={() => setConfirming(undefined)}
               actions={<>
                 <button className="btn" onClick={() => setConfirming(undefined)}>Cancel</button>
                 <button className="btn primary" data-testid="confirm-discover" disabled={busy !== undefined}
                         onClick={() => void discover(confirming)}>Ask now</button>
               </>}>
          {confirming.executionClass === 'subscriptionCLI' ? (
            <>
              <p>
                This runs <code>{confirming.executablePath ?? confirming.provider}</code> twice: once to read its
                version, once to list the models your signed-in account may call.
              </p>
              <p className="muted small">
                Neither asks a model anything, so no tokens are generated and nothing is charged. It does use your
                own authenticated session — the one you set up yourself — and if that session has expired, the command
                will say so and nothing further happens.
              </p>
            </>
          ) : (
            <>
              <p>
                This sends one request to {confirming.label} with your API key, asking which models it will let that key
                call.
              </p>
              <p className="muted small">
                Listing models is not a billed inference request, but it is a real request made with your key. It is why
                this is a button and not something that happens when you open the screen.
              </p>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function ModelTable({ models }: { models: FrontierModelRow[] }) {
  return (
    <div className="table-wrap"><table className="table" data-testid="frontier-model-table">
      <thead><tr><th>Model</th><th>Selectable</th><th>Identity</th><th>What established this</th></tr></thead>
      <tbody>{models.map((model) => (
        <tr key={`${model.provider}:${model.modelID}`}>
          <td>
            <strong>{model.displayName}</strong>
            <div className="mono small muted">{model.modelID}</div>
            {model.desiredEfforts.length > 0 && (
              <div className="muted small">intended efforts: {model.desiredEfforts.join(', ')}</div>
            )}
          </td>
          <td><Pill tone={availabilityTone(model.availability)}>{model.availability}</Pill></td>
          <td className="small">
            {model.verifiedModelID
              ? <span className="mono">{model.verifiedModelID}</span>
              : <span className="muted">unverifiable — nothing named it</span>}
          </td>
          <td className="small">{model.evidence}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}
