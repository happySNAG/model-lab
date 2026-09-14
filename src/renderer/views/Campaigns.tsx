import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import type {
  CampaignDetail, CampaignRow, CampaignStartDisclosure, CampaignVerification, CostPreviewRow,
  FrontierCandidateSelection, FrontierMetricsRow, ModelRow, ProviderStatusRow, TerminalCommandRow,
} from '../../shared/ipc';
import { Card, Empty, Modal, Pill, when } from '../components';

// A campaign is a long benchmark with a frozen manifest and a durable ledger. It can be driven from
// here or from the `cernum` terminal command; both write the same directory, so this screen shows a
// terminal-driven campaign exactly as it shows one started here. The screen never claims to own a
// campaign it is not running — that is what the "running in this window" distinction is for.

function stateTone(state: string): 'ok' | 'warn' | 'bad' | 'neutral' | 'accent' {
  if (state === 'complete') return 'ok';
  if (state === 'running') return 'accent';
  if (state === 'aborted' || state === 'unreadable') return 'bad';
  if (state === 'paused') return 'warn';
  return 'neutral';
}

/**
 * The message a person should read, without the plumbing it arrived in.
 *
 * Electron wraps anything the main process throws as
 * `Error invoking remote method 'lab:campaign:start': RuntimeLeaseError: <the actual sentence>`.
 * The engine writes these refusals carefully — naming the campaign, the process and what to do — and
 * burying that behind an IPC channel name wastes the part that helps.
 */
function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const unwrapped = /^Error invoking remote method '[^']*':\s*([\s\S]+)$/.exec(raw);
  const withoutChannel = unwrapped ? unwrapped[1] : raw;
  const named = /^[A-Za-z]*Error:\s*([\s\S]+)$/.exec(withoutChannel);
  return named ? named[1] : withoutChannel;
}

function ratePercent(milli?: number): string {
  return milli === undefined ? 'no rate' : `${(milli / 10).toFixed(1)}%`;
}

/** Integer microUSD as money. Sub-cent figures keep their digits; rendering them as $0.00 hides them. */
function money(microUSD?: number): string {
  if (microUSD === undefined) return 'not known';
  const dollars = microUSD / 1_000_000;
  if (microUSD !== 0 && Math.abs(dollars) < 0.01) return `$${dollars.toFixed(6)}`;
  return `$${dollars.toFixed(2)}`;
}

/** A count, or the recorded reason there is none. Never a blank cell, which reads as zero. */
function countOrAbsence(value: number | undefined, field: string, absences: { field: string; reason: string }[]): React.ReactNode {
  if (value !== undefined) return value.toLocaleString();
  const absence = absences.find((entry) => entry.field === field);
  return <span className="muted small" title={absence?.reason}>not known</span>;
}

function executionLabel(executionClass: string): string {
  if (executionClass === 'localRuntime') return 'local';
  if (executionClass === 'subscriptionCLI') return 'subscription';
  return 'metered API';
}

export function CampaignsView({ shell }: { shell: Shell }) {
  const [rows, setRows] = useState<CampaignRow[]>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<CampaignDetail>();
  const [verification, setVerification] = useState<CampaignVerification>();
  const [root, setRoot] = useState<string>('');
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  // What the person is shown before a campaign starts. Set when Start is pressed, cleared when they
  // decide. It is asked once per start, never per attempt.
  const [disclosure, setDisclosure] = useState<CampaignStartDisclosure>();
  // The spending approval, which is a separate decision from starting. A person may create and price
  // a campaign today and authorise it tomorrow, and the authorisation is what the run reads.
  const [authorizing, setAuthorizing] = useState<(CostPreviewRow & { authorized: boolean; hardCeilingMicroUSD?: number })>();
  const [ceilingText, setCeilingText] = useState('5.00');

  const refresh = useCallback(async () => {
    try {
      setRows(await api.listCampaigns());
      setRoot(await api.campaignRoot());
    } catch (e) { setError(readableError(e)); }
  }, []);

  // Refreshing the detail must NOT discard a verification the person just asked for: this view
  // re-reads every three seconds, and clearing it here made the result vanish before it was read.
  // A verification belongs to the campaign it was run against, so the selection is what clears it.
  const loadDetail = useCallback(async (name: string) => {
    try { setDetail(await api.campaignDetail(name)); }
    catch (e) { setError(readableError(e)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setVerification(undefined); if (selected) void loadDetail(selected); }, [selected, loadDetail]);

  // A campaign the terminal is running has no object in this process, so the screen polls rather
  // than waiting for an event that will never arrive.
  useEffect(() => {
    const timer = setInterval(() => { void refresh(); if (selected) void loadDetail(selected); }, 3000);
    return () => clearInterval(timer);
  }, [refresh, loadDetail, selected]);

  useEffect(() => api.onCampaignProgress(() => { void refresh(); if (selected) void loadDetail(selected); }), [refresh, loadDetail, selected]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(undefined);
    try { await work(); } catch (e) { setError(readableError(e)); }
    finally { setBusy(false); void refresh(); if (selected) void loadDetail(selected); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Campaigns</h1>
          <p>
            A campaign freezes exactly what will be run — every prompt, every scoring rule, every model — and records each
            attempt as it lands, so it survives an interruption and can be resumed without losing or repeating a single one.
          </p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>New campaign</button>
      </div>

      {error && <div className="note bad">{error}</div>}

      <Card>
        {rows === undefined ? <p className="muted">Loading…</p> : rows.length === 0 ? (
          <Empty title="No campaigns yet">
            <p>Campaigns are for long comparisons you expect to interrupt. For a quick one-off, use Benchmark instead.</p>
            <button className="btn primary" onClick={() => setCreating(true)}>New campaign</button>
            <p className="muted">You can also start one from a terminal: <code>npm run cernum -- create my-run --models gemma3:4b</code></p>
          </Empty>
        ) : (
          <div className="table-wrap"><table className="table" data-testid="campaign-table">
            <thead><tr><th>Campaign</th><th>State</th><th className="num">Recorded</th><th>Created</th><th>Manifest</th></tr></thead>
            <tbody>{rows.map((row) => (
              <tr key={row.name} className="clickable" tabIndex={0}
                  onClick={() => setSelected(row.name)}
                  onKeyDown={(event) => { if (event.key === 'Enter') setSelected(row.name); }}>
                <td>
                  <strong>{row.label}</strong>
                  <div className="muted small">{row.name}</div>
                  {row.execution && !row.execution.canonical && (
                    <div className="muted small"><Pill tone="warn">observe-only</Pill> noncanonical</div>
                  )}
                  {row.mixedExecution && (
                    <div className="muted small"><Pill tone="warn">mixed execution</Pill> speed and cost not comparable</div>
                  )}
                  {row.hasMeteredBinding && (
                    <div className="muted small"><Pill tone="accent">metered</Pill> billed per token</div>
                  )}
                  {row.problem && <div className="note bad small">{row.problem}</div>}
                </td>
                <td>
                  <Pill tone={stateTone(row.state)} pulse={row.state === 'running' || row.owner?.state === 'live'}>{row.state}</Pill>
                  {row.running && <span className="muted small"> in this window</span>}
                  {!row.running && row.owner?.state === 'live' && (
                    <div className="muted small">running in a {row.owner.processType} · pid {row.owner.pid}</div>
                  )}
                  {row.owner && row.owner.state !== 'live' && row.owner.state !== 'selfHeld' && (
                    <div className="note warn small">left locked by {row.owner.processType} pid {row.owner.pid} ({row.owner.state})</div>
                  )}
                  {!row.balances && row.state !== 'created' && <div className="muted small">ledger does not balance</div>}
                </td>
                <td className="num">{row.terminalCount}/{row.slotCount}{row.blockedCount > 0 ? ` · ${row.blockedCount} blocked` : ''}</td>
                <td>{when(row.createdAt)}</td>
                <td className="mono small">{row.manifestID.replace('manifest:', '')}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {root && <p className="muted small">Campaigns live in <code>{root}</code>. The terminal command writes here too, so a run started there appears above while it is running.</p>}
      </Card>

      <TerminalCommand onError={setError} />


      {selected && detail && (
        <Modal title={detail.status.label} wide onClose={() => { setSelected(undefined); setDetail(undefined); }}
               actions={<>
                 <button className="btn" disabled={busy} onClick={() => void act(async () => setVerification(await api.verifyCampaign(selected)))}>Verify manifest</button>
                 {detail.spending && !detail.spending.authorized && (
                   <button className="btn" disabled={busy} data-testid="authorize-campaign"
                           onClick={() => void act(async () => setAuthorizing(await api.campaignCost(selected)))}>
                     Authorize spending
                   </button>
                 )}
                 {detail.status.state === 'complete'
                   ? <button className="btn" disabled={busy} onClick={() => void act(async () => setDetail(await api.finalizeCampaign(selected)))}>Finalize</button>
                   : rows?.find((row) => row.name === selected)?.running
                     ? <button className="btn" disabled={busy} onClick={() => void act(() => api.pauseCampaign())}>Pause</button>
                     : <button className="btn primary" disabled={busy}
                               onClick={() => void act(async () => setDisclosure(await api.campaignDisclosure(selected)))}>
                         {detail.status.terminalCount > 0 ? 'Resume' : 'Start'}
                       </button>}
                 <button className="btn" onClick={() => { setSelected(undefined); setDetail(undefined); }}>Close</button>
               </>}>
          <p className="mono small">{detail.manifest.seal}</p>
          <p className="muted small">{detail.execution.summary}</p>
          {!detail.execution.canonical && (
            <div className="note warn">
              <strong>Observe-only — noncanonical.</strong> These results are not comparable with a campaign that
              managed residency, and not comparable between candidates within this one.
              <ul>{detail.execution.noncanonicalBecause.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
            </div>
          )}
          <p className="muted small">
            Frozen {when(detail.manifest.frozenAt)} over {detail.manifest.promptCount} prompt(s) and {detail.manifest.candidateCount} model(s).
            {detail.manifest.retestOf && <> Derived from <span className="mono">{detail.manifest.retestOf}</span> for different hardware — quality is comparable with it, latency is not.</>}
          </p>

          <p>
            <strong>{detail.status.terminalCount} of {detail.status.slotCount}</strong> attempts recorded, {detail.status.remaining} remaining.
            {detail.status.candidatesComplete.length > 0 && <> Finished: {detail.status.candidatesComplete.join(', ')}.</>}
          </p>

          {detail.status.standingAbort && (
            <div className="note bad">
              <strong>Stopped at {detail.status.standingAbort.stage}.</strong> {detail.status.standingAbort.reason}
              <p>{detail.status.standingAbort.blockedSlotCount} attempt(s) were blocked. They were never made and carry no result — resolve what stopped it, then resume, and they run normally.</p>
            </div>
          )}

          {detail.anomalies.length > 0 && (
            <div className="note warn">
              <strong>The ledger noticed something.</strong>
              <ul>{detail.anomalies.map((anomaly, index) => <li key={index}>{anomaly.kind}{anomaly.why ? ` — ${anomaly.why}` : ''}</li>)}</ul>
            </div>
          )}

          {detail.report && !detail.report.canonical && (
            <div className="note warn">
              <strong>These rankings are noncanonical.</strong> They were produced by an observe-only campaign and must
              not be set beside canonical results.
            </div>
          )}

          {verification && (
            <div className={`note ${verification.intact ? 'ok' : 'bad'}`}>
              {verification.intact ? 'Intact — every binding still matches what was frozen.' : (
                <>
                  <strong>{verification.drifts.length} thing(s) moved since this was frozen{verification.hardwareOnly ? ' — hardware only' : ''}.</strong>
                  <ul>{verification.drifts.map((drift) => <li key={drift.field}><strong>{drift.field}</strong> — {drift.meaning}</li>)}</ul>
                </>
              )}
            </div>
          )}

          {detail.report && (
            <>
              <h3>Rankings</h3>
              {detail.report.provisional && (
                <div className="note warn">
                  <strong>Provisional.</strong>
                  <ul>{detail.report.provisionalBecause.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
                </div>
              )}
              <div className="table-wrap"><table className="table">
                <thead><tr><th className="num">#</th><th>Model</th><th className="num">Pass rate</th><th className="num">Scored</th><th>Suited to</th></tr></thead>
                <tbody>{detail.report.rankings.map((ranking) => (
                  <tr key={ranking.candidate}>
                    <td className="num">{ranking.rank}</td>
                    <td>{ranking.candidate}{ranking.disqualified && <> <Pill tone="bad">disqualified</Pill></>}</td>
                    <td className="num">{ratePercent(ranking.passRateMilli)}</td>
                    <td className="num">{ranking.scoredCount}</td>
                    <td>{ranking.roles.length > 0 ? ranking.roles.join(', ') : <span className="muted">no role cleared</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>

              <h3>{detail.report.retentionHeading}</h3>
              <ul>{detail.report.retention.map((recommendation) => <li key={recommendation.candidate}>{recommendation.statement}</li>)}</ul>

              {detail.report.awaitingHumanReview > 0 && (
                <div className="note">
                  <strong>{detail.report.awaitingHumanReview} answer(s) need a person to judge them.</strong>
                  <p>
                    They are excluded from every rate above until you do. A blinded packet has been written with the model
                    names removed and the answers shuffled, so you can judge them without knowing who wrote what
                    {detail.report.packetClean === false && <> — but the leak audit did not come back clean, so read it before sharing it</>}.
                  </p>
                  {detail.report.packetPath && <button className="btn" onClick={() => void api.revealPath(detail.report!.packetPath!)}>Show the packet</button>}
                </div>
              )}
            </>
          )}

          {detail.bindings.length > 0 && (
            <>
              <h3>Who answers each candidate</h3>
              <div className="table-wrap"><table className="table" data-testid="binding-table">
                <thead><tr><th>Candidate</th><th>Reached as</th><th>Identity</th><th>Settings</th><th>Cost basis</th></tr></thead>
                <tbody>{detail.bindings.map((binding) => (
                  <tr key={binding.candidate}>
                    <td>
                      <strong>{binding.candidate}</strong>
                      <div className="mono small muted">{binding.requestedModelID}</div>
                    </td>
                    <td>
                      {binding.providerLabel}
                      <div className="muted small">{executionLabel(binding.executionClass)}</div>
                    </td>
                    <td className="small">
                      {binding.identityState === 'verified'
                        ? <><Pill tone="ok">verified</Pill> <span className="mono">{binding.verifiedModelID}</span></>
                        : <Pill tone="warn">unverifiable</Pill>}
                      <div className="muted small">{binding.identityEvidence}</div>
                    </td>
                    <td className="small">
                      effort {binding.effort} · thinking {binding.thinkingMode}
                      <div className="muted small">
                        {binding.maxInputTokens.toLocaleString()} in / {binding.maxOutputTokens.toLocaleString()} out ·
                        {' '}{Math.round(binding.timeoutMilliseconds / 1000)}s timeout · {binding.maxRetries} retries
                      </div>
                    </td>
                    <td className="small">
                      {binding.billingBasis === 'local' ? 'no monetary cost'
                        : binding.billingBasis === 'subscriptionIncluded' ? 'subscription-included · $0 marginal'
                          : 'billed per token'}
                      {binding.pricing && (
                        <div className="muted small">
                          prices captured {when(binding.pricing.capturedAt)} from {binding.pricing.source}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}</tbody>
              </table></div>
            </>
          )}

          {detail.mixedExecutionBecause.length > 0 && (
            <div className="note warn">
              <strong>Mixed execution.</strong> Task outcomes below are comparable; speed and cost are not.
              <ul>{detail.mixedExecutionBecause.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
            </div>
          )}

          {detail.spending && (
            <div className={`note ${detail.spending.authorized ? '' : 'warn'}`}>
              <strong>Spending.</strong>{' '}
              {detail.spending.authorized
                ? <>Authorised with a hard ceiling of {money(detail.spending.hardCeilingMicroUSD)}.</>
                : <>NOT authorised. No metered request will be sent until it is.</>}
              {' '}{money(detail.spending.recordedMicroUSD)} recorded across {detail.spending.meteredAttempts} metered attempt(s).
              {detail.spending.stoppedAtCeiling && (
                <p>
                  This run stopped at its ceiling. The attempts already recorded are kept; the remaining slots were
                  blocked and carry no result.
                </p>
              )}
            </div>
          )}

          {detail.frontierMetrics.length > 0 && <MetricsTable rows={detail.frontierMetrics} />}

          <h3>Latest attempts</h3>
          {detail.recentAttempts.length === 0 ? <p className="muted">Nothing recorded yet.</p> : (
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Attempt</th><th>Outcome</th><th className="num">Latency</th><th>Notes</th></tr></thead>
              <tbody>{detail.recentAttempts.map((attempt) => (
                <tr key={attempt.slotKey}>
                  <td className="mono small">{attempt.slotKey}</td>
                  <td>{attempt.status}</td>
                  <td className="num">{attempt.latencyMilliseconds === undefined ? 'not reported' : `${attempt.latencyMilliseconds} ms`}</td>
                  <td className="small">
                    {attempt.identityState !== 'verified' && <div className="muted">identity {attempt.identityState}</div>}
                    {attempt.suppliedContextState !== 'intact' && attempt.suppliedContextState !== 'notSupplied' && <div className="muted">context {attempt.suppliedContextState}</div>}
                    {attempt.detail}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}

          <p className="muted small">Same campaign in a terminal: <code>{detail.terminalHint}</code></p>
        </Modal>
      )}

      {/* Rendered last so it sits above the detail modal it was opened from: a person
          confirming this should not be able to reach the buttons underneath it. */}
      {disclosure && selected && (
        <Modal title={disclosure.canonical ? 'Before this campaign starts' : 'This campaign is observe-only'}
               onClose={() => setDisclosure(undefined)}
               actions={<>
                 <button className="btn" onClick={() => setDisclosure(undefined)}>Cancel</button>
                 <button className="btn primary" disabled={busy} data-testid="confirm-start"
                         onClick={() => { const name = selected; setDisclosure(undefined); void act(() => api.startCampaign(name)); }}>
                   {disclosure.canonical ? 'Understood — start' : 'Start observe-only'}
                 </button>
               </>}>
          <p className="mono small">{disclosure.endpoint}</p>
          <ul>{disclosure.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </Modal>
      )}

      {authorizing && selected && (
        <Modal title="Authorize paid execution" wide onClose={() => setAuthorizing(undefined)}
               actions={<>
                 <button className="btn" onClick={() => setAuthorizing(undefined)}>Cancel</button>
                 <button className="btn primary" disabled={busy || !/^\$?\d+(\.\d{1,6})?$/.test(ceilingText.trim()) || Number(ceilingText.replace('$', '')) <= 0}
                         data-testid="confirm-authorize"
                         onClick={() => {
                           const name = selected;
                           const ceiling = Math.round(Number(ceilingText.trim().replace('$', '')) * 1_000_000);
                           setAuthorizing(undefined);
                           void act(async () => setDetail(await api.authorizeCampaign(name, ceiling)));
                         }}>
                   Authorize with this ceiling
                 </button>
               </>}>
          {!authorizing.estimable ? (
            <div className="note bad">
              <strong>This campaign cannot be priced, so it will not be offered for approval.</strong>
              <ul>{authorizing.notEstimableBecause.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
            </div>
          ) : (
            <>
              <p>
                <strong>Estimated {money(authorizing.totalMinimumMicroUSD)} – {money(authorizing.totalMaximumMicroUSD)}</strong>
                {' '}across {authorizing.meteredCandidateCount} metered candidate(s).
              </p>
              <ul>{authorizing.disclosure.map((line, index) => <li key={index}>{line}</li>)}</ul>
              <ul>{authorizing.privacyDisclosure.map((line, index) => <li key={index}>{line}</li>)}</ul>
              <label className="field">
                <span>Hard spending ceiling (dollars)</span>
                <input value={ceilingText} onChange={(event) => setCeilingText(event.target.value)} data-testid="ceiling-input" />
                <span className="muted small">
                  The run stops before the request that would take it past this. Attempts already recorded are kept; the
                  remaining slots are blocked and carry no result. A ceiling below the estimated maximum is a legitimate
                  choice — it is what a ceiling is for.
                </span>
              </label>
            </>
          )}
        </Modal>
      )}

      {creating && <CreateCampaign onClose={() => setCreating(false)} onCreated={(rows_) => { setRows(rows_); setCreating(false); }} onError={setError} />}
    </div>
  );
}

/**
 * Tokens, speed and cost, with how each figure was obtained printed beside it.
 *
 * The `measurement quality` column is not decoration. A cost derived from a provider's own usage
 * block and a cost derived from a local character estimate are different kinds of number, and a
 * table that showed them in the same font without saying so would invite somebody to reconcile the
 * second against a bill.
 *
 * An absent figure shows as "not known" carrying its reason, never as a blank cell — a blank cell
 * reads as zero, and a zero cost is a claim.
 */
function MetricsTable({ rows }: { rows: FrontierMetricsRow[] }) {
  const mixed = new Set(rows.map((row) => row.executionClass)).size > 1;
  return (
    <>
      <h3>Tokens, speed and cost</h3>
      {mixed && (
        <p className="note warn small">
          These candidates were reached through different execution classes. Their task outcomes are comparable; their
          speed and cost are properties of the access method as much as of the model.
        </p>
      )}
      <div className="table-wrap"><table className="table" data-testid="metrics-table">
        <thead><tr>
          <th>Candidate</th><th>Reached as</th><th className="num">Success</th><th className="num">In</th>
          <th className="num">Out</th><th className="num">Reasoning</th><th className="num">First token</th>
          <th className="num">Cost</th><th className="num">Cost / success</th><th className="num">Retries</th>
          <th className="num">Wasted</th><th>Quality</th>
        </tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.candidate}>
            <td><strong>{row.candidate}</strong><div className="muted small">{row.provider}</div></td>
            <td className="small">
              {executionLabel(row.executionClass)}
              <div className="muted small">
                {row.billingBasis === 'local' ? 'no monetary cost'
                  : row.billingBasis === 'subscriptionIncluded' ? '$0 marginal, allowance consumed'
                    : 'billed per token'}
              </div>
            </td>
            <td className="num">
              {ratePercent(row.successfulTaskRateMilli)}
              <div className="muted small">{row.successfulTaskCount}/{row.attemptCount}</div>
            </td>
            <td className="num">{countOrAbsence(row.inputTokens, 'input tokens', row.absences)}</td>
            <td className="num">{countOrAbsence(row.visibleOutputTokens, 'visible output tokens', row.absences)}</td>
            <td className="num">{countOrAbsence(row.reasoningTokens, 'reasoning tokens', row.absences)}</td>
            <td className="num">
              {row.medianTimeToFirstVisibleTokenMilliseconds === undefined
                ? <span className="muted small">not observed</span>
                : `${row.medianTimeToFirstVisibleTokenMilliseconds} ms`}
            </td>
            <td className="num">{money(row.costPerRunMicroUSD)}</td>
            <td className="num">
              {row.costPerSuccessfulTaskMicroUSD === undefined
                ? <span className="muted small" title={row.absences.find((a) => a.field === 'cost per successful task')?.reason}>no successes</span>
                : money(row.costPerSuccessfulTaskMicroUSD)}
            </td>
            <td className="num">{row.retryCount}{row.timeoutCount > 0 ? ` · ${row.timeoutCount} timed out` : ''}</td>
            <td className="num">{countOrAbsence(row.wastedTokens, 'wasted tokens', row.absences)}</td>
            <td className="small">{row.measurementQuality}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="muted small">
        <strong>measured</strong> — this application watched it happen. <strong>providerReported</strong> — the provider
        told us. <strong>estimated</strong> — derived by a stated method from something that was counted.
        <strong> unavailable</strong> — not known, and not guessed at. Cost per successful task counts the money spent on
        failed and retried attempts too: a model that fails half the time costs more per useful answer, not less.
      </p>
    </>
  );
}

/**
 * The installed terminal command.
 *
 * Installing is a user-controlled action and is described before it happens, exactly: one file,
 * one directory the person already owns, no PATH change, no shell profile, nothing privileged and
 * nothing at login. The uninstall removes that one file and refuses anything it did not write.
 */
function TerminalCommand({ onError }: { onError: (message: string) => void }) {
  const [status, setStatus] = useState<TerminalCommandRow>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.terminalCommand()); }
    catch (e) { onError(readableError(e)); }
  }, [onError]);
  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<TerminalCommandRow>) => {
    setBusy(true);
    try { setStatus(await work()); }
    catch (e) { onError(readableError(e)); void load(); }
    finally { setBusy(false); }
  };

  if (!status) return null;

  return (
    <Card title="The terminal command">
      {!status.supported ? (
        <>
          <p className="muted">
            This is a development checkout, so the command runs from the repository:{' '}
            <code>npm run {status.command} -- help</code>.
          </p>
          <p className="muted small">An installed copy of the application carries the command with it and needs no checkout.</p>
        </>
      ) : (
        <>
          <p>
            <code>{status.command}</code> drives the same campaigns as this screen, through the same engine, from a terminal.
            {status.installed && status.installedIsOurs
              ? <> It is installed at <code>{status.installPath}</code>.</>
              : <> Installing it writes one file, <code>{status.installPath}</code>, and changes nothing else — no PATH, no shell profile, no system directory, nothing at login.</>}
          </p>
          {status.installed && status.installedIsOurs && !status.installedPointsHere && (
            <div className="note warn">The installed command points at a different copy of the application. Install again to point it here.</div>
          )}
          {status.installed && !status.installedIsOurs && (
            <div className="note bad">A file already exists at <code>{status.installPath}</code> that this application did not write. It will not be replaced or removed.</div>
          )}
          {status.installed && status.installedIsOurs && !status.directoryOnPath && (
            <div className="note warn">
              <p><code>{status.installDirectory}</code> is not on your PATH, so the name alone will not resolve yet.</p>
              <pre className="mono small">{status.pathHint}</pre>
              <p className="small">Until you add it, run it by its full path: <code>{status.installPath}</code></p>
            </div>
          )}
          <p className="row">
            <button className="btn primary" disabled={busy} onClick={() => void act(() => api.installTerminalCommand())}>
              {status.installed && status.installedIsOurs ? 'Reinstall command' : 'Install command'}
            </button>
            <button className="btn" disabled={busy || !status.installed || !status.installedIsOurs}
                    onClick={() => void act(() => api.uninstallTerminalCommand())}>
              Remove command
            </button>
          </p>
          <p className="muted small">{status.message.split('\n')[0]}</p>
        </>
      )}
    </Card>
  );
}

function CreateCampaign({ onClose, onCreated, onError }: { onClose: () => void; onCreated: (rows: CampaignRow[]) => void; onError: (message: string) => void }) {
  const [models, setModels] = useState<ModelRow[]>();
  const [suites, setSuites] = useState<{ id: string; title: string; caseCount: number }[]>();
  const [name, setName] = useState('');
  const [chosenModels, setChosenModels] = useState<string[]>([]);
  const [chosenSuites, setChosenSuites] = useState<string[]>([]);
  const [repeats, setRepeats] = useState(1);
  const [observeOnly, setObserveOnly] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [providers, setProviders] = useState<ProviderStatusRow[]>();
  const [frontier, setFrontier] = useState<FrontierCandidateSelection[]>([]);
  const [cost, setCost] = useState<CostPreviewRow>();
  const [costProblem, setCostProblem] = useState<string>();

  useEffect(() => {
    void api.getSettings().then((settings) => setEndpoint(settings.ollamaEndpoint));
    void api.listModels().then((rows) => setModels(rows.filter((row) => row.kind === 'ollama')));
    void api.campaignSuites().then((rows) => { setSuites(rows); setChosenSuites(rows.map((row) => row.id)); });
    // Offline: this reaches no provider. It is what makes the frontier list safe to show in a dialog.
    void api.providerStatuses().then(setProviders);
  }, []);

  const toggle = (list: string[], value: string, set: (next: string[]) => void) =>
    set(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

  const safeName = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const ready = safeName.length > 0 && (chosenModels.length > 0 || frontier.length > 0) && chosenSuites.length > 0;

  const request = () => ({
    name: safeName, label: name.trim() || safeName, modelNames: chosenModels,
    suiteIDs: chosenSuites, repeatsPerCase: repeats, runtimeVersion: 'ollama-unreported',
    observeOnly, thinkingMode: (thinking ? 'enabled' : 'disabled') as 'enabled' | 'disabled',
    frontier,
  });

  // Priced by the SAME builder that would freeze it, so this previews the campaign that would
  // actually be created rather than an approximation of one.
  const preview = async () => {
    setCost(undefined); setCostProblem(undefined);
    try { setCost(await api.previewCampaignCost(request())); }
    catch (error) { setCostProblem(readableError(error)); }
  };

  const create = async () => {
    setBusy(true);
    try {
      onCreated(await api.createCampaign(request()));
    } catch (error) { onError(readableError(error)); }
    finally { setBusy(false); }
  };

  const attempts = (suites ?? []).filter((suite) => chosenSuites.includes(suite.id)).reduce((sum, suite) => sum + suite.caseCount, 0) * repeats * chosenModels.length;

  return (
    <Modal title="New campaign" wide onClose={onClose}
           actions={<>
             <button className="btn" onClick={onClose}>Cancel</button>
             <button className="btn primary" disabled={!ready || busy} onClick={() => void create()}>Freeze and create</button>
           </>}>
      <p>Creating a campaign freezes what will be run. Nothing is asked of a model until you start it.</p>

      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="September cohort" />
        {safeName && <span className="muted small">Directory: {safeName}</span>}
      </label>

      <h3>Models</h3>
      {models === undefined ? <p className="muted">Loading…</p> : models.length === 0 ? <p className="muted">No models are installed.</p> : (
        <div className="check-list">{models.map((model) => (
          <label key={model.key} className="check">
            <input type="checkbox" checked={chosenModels.includes(model.name)} onChange={() => toggle(chosenModels, model.name, setChosenModels)} />
            <span>{model.name} <span className="muted small">{model.parameterSize} {model.quantization}</span></span>
          </label>
        ))}</div>
      )}

      <FrontierPicker providers={providers} selected={frontier} onChange={setFrontier} />

      <h3>Suites</h3>
      {suites === undefined ? <p className="muted">Loading…</p> : (
        <div className="check-list">{suites.map((suite) => (
          <label key={suite.id} className="check">
            <input type="checkbox" checked={chosenSuites.includes(suite.id)} onChange={() => toggle(chosenSuites, suite.id, setChosenSuites)} />
            <span>{suite.title} <span className="muted small">{suite.caseCount} case(s)</span></span>
          </label>
        ))}</div>
      )}

      <label className="field">
        <span>Passes per case</span>
        <input type="number" min={1} max={10} value={repeats} onChange={(event) => setRepeats(Math.max(1, Number(event.target.value) || 1))} />
        <span className="muted small">More passes measure how consistent a model is, at proportional cost.</span>
      </label>

      <h3>How it runs</h3>
      <p className="muted small">
        Both choices are frozen into the manifest when you create the campaign, and neither can be changed afterwards.
      </p>

      <label className="check">
        <input type="checkbox" checked={!observeOnly} onChange={() => setObserveOnly(!observeOnly)} data-testid="canonical-toggle" />
        <span>
          <strong>Canonical — let Cernum manage models on the benchmark endpoint</strong>
          <div className="muted small">
            Cernum will load and unload models on <code>{endpoint || 'the selected endpoint'}</code> while this campaign
            runs: before each candidate after the first, it asks that endpoint to release the previous candidate's weights
            and verifies the release before continuing. That is what makes the candidates comparable — without it, the
            second model's latency measures the disk rather than the model. This applies to that one endpoint only; no
            other runtime or process on this machine is touched, and no model is pulled, created or deleted. You are asked
            once, when you start it, and not again between attempts.
          </div>
        </span>
      </label>

      {observeOnly && (
        <div className="note warn">
          <strong>Observe-only: these results will be noncanonical.</strong> Cernum will touch nothing on the endpoint,
          so every candidate after the first may be measured against a machine already holding another model's weights.
          Latency and throughput from this campaign will not be comparable with a canonical run, nor between candidates
          within it, and it will be labelled that way everywhere it appears. Quality outcomes are unaffected.
        </div>
      )}

      <label className="check">
        <input type="checkbox" checked={thinking} onChange={() => setThinking(!thinking)} data-testid="thinking-toggle" />
        <span>
          <strong>Ask the models to think first</strong>
          <div className="muted small">
            Frozen with the campaign. A model the runtime says cannot think is refused here rather than quietly run with
            thinking off — answers produced under a different configuration would be answers to a different experiment.
          </div>
        </span>
      </label>

      <p className={attempts > 0 ? 'note' : 'muted'}>{attempts > 0 ? `${attempts} attempt(s) will be planned.` : 'Choose at least one model and one suite.'}</p>

      {frontier.length > 0 && (
        <>
          <h3>What this will cost, and where the prompts go</h3>
          <p className="row">
            <button className="btn" type="button" data-testid="preview-cost" disabled={!ready} onClick={() => void preview()}>
              Show projected usage and cost
            </button>
          </p>
          {costProblem && <div className="note bad">{costProblem}</div>}
          {cost && (
            <div className={cost.estimable ? 'note' : 'note bad'} data-testid="cost-preview">
              {!cost.estimable ? (
                <>
                  <strong>This cannot be priced, so it will not be offered for approval.</strong>
                  <ul>{cost.notEstimableBecause.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
                </>
              ) : (
                <>
                  <p>
                    <strong>
                      {cost.meteredCandidateCount === 0
                        ? 'Nothing here is billed per token.'
                        : `Estimated ${money(cost.totalMinimumMicroUSD)} – ${money(cost.totalMaximumMicroUSD)}.`}
                    </strong>
                  </p>
                  <ul>{cost.disclosure.map((line, index) => <li key={index}>{line}</li>)}</ul>
                </>
              )}
              <p className="small">
                <strong>Before you start it:</strong>
              </p>
              <ul>{cost.privacyDisclosure.map((line, index) => <li key={index}>{line}</li>)}</ul>
              {cost.meteredCandidateCount > 0 && (
                <p className="small">
                  Creating the campaign freezes it but authorises nothing. No metered request is sent until you record an
                  explicit authorization with a hard spending ceiling.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Choosing models somebody else runs.
 *
 * Only `proven` models appear as selectable. Unproven ones are shown, greyed, WITH the reason — a
 * person needs to know the model they were expecting exists in the plan and has not been confirmed,
 * rather than wondering why it is missing. Selecting one is not possible, and the shared builder
 * would refuse it even if it were.
 */
function FrontierPicker({ providers, selected, onChange }: {
  providers?: ProviderStatusRow[];
  selected: FrontierCandidateSelection[];
  onChange: (next: FrontierCandidateSelection[]) => void;
}) {
  if (providers === undefined) return <><h3>Models somebody else runs</h3><p className="muted">Loading…</p></>;
  const frontierProviders = providers.filter((provider) => provider.executionClass !== 'localRuntime');
  const anyProven = frontierProviders.some((provider) => provider.models.some((model) => model.availability === 'proven'));

  const isSelected = (provider: string, modelID: string, effort: string) =>
    selected.some((entry) => entry.provider === provider && entry.modelID === modelID && entry.effort === effort);

  const toggle = (provider: string, modelID: string, effort: FrontierCandidateSelection['effort']) => {
    if (isSelected(provider, modelID, effort)) {
      onChange(selected.filter((entry) => !(entry.provider === provider && entry.modelID === modelID && entry.effort === effort)));
      return;
    }
    onChange([...selected, { provider, modelID, effort }]);
  };

  return (
    <>
      <h3>Models somebody else runs</h3>
      {!anyProven ? (
        <p className="muted">
          No frontier model has been proven callable by your account yet, so none can be selected. A model name on its
          own is a plan, not a capability. Open the Providers screen and ask a provider what it can call — and note
          that a subscription CLI cannot answer that question: <code>claude</code> has no model-listing command, so the
          only way to prove one of its models is an identity smoke test (<code>cernum smoke claudeCLI</code>), which
          sends one minimal request per candidate and consumes plan allowance. <code>codex</code> does publish a
          catalogue, but it names no model in its replies, so its candidates stay <strong>unverifiable</strong> rather
          than proven — which is a different thing from unavailable, and is why they are not selectable either.
        </p>
      ) : (
        <>
          <p className="muted small">
            Each choice is frozen with its provider, its effort level and its billing basis. The same model at two
            effort levels is two candidates, because it is two experiments.
          </p>
          {frontierProviders.map((provider) => (
            <div key={provider.provider}>
              <p className="small"><strong>{provider.label}</strong>{' '}
                <Pill tone="neutral">{provider.executionClass === 'subscriptionCLI' ? 'subscription-included · $0 marginal' : 'billed per token'}</Pill>
              </p>
              <div className="check-list" data-testid={`frontier-${provider.provider}`}>
                {provider.models.map((model) => {
                  const efforts = model.desiredEfforts.length > 0 ? model.desiredEfforts : ['none'];
                  if (model.availability !== 'proven') {
                    return (
                      <label key={model.modelID} className="check" title={model.evidence}>
                        <input type="checkbox" disabled checked={false} readOnly />
                        <span className="muted">
                          {model.displayName} <Pill tone={model.availability === 'refused' ? 'bad' : 'neutral'}>{model.availability}</Pill>
                          <div className="muted small">{model.evidence}</div>
                        </span>
                      </label>
                    );
                  }
                  return efforts.map((effort) => (
                    <label key={`${model.modelID}@${effort}`} className="check">
                      <input type="checkbox"
                             checked={isSelected(provider.provider, model.modelID, effort)}
                             onChange={() => toggle(provider.provider, model.modelID, effort as FrontierCandidateSelection['effort'])} />
                      <span>
                        {model.displayName}{effort !== 'none' ? ` · effort ${effort}` : ''}
                        <div className="muted small mono">{model.verifiedModelID || model.modelID}</div>
                      </span>
                    </label>
                  ));
                })}
              </div>
            </div>
          ))}
          {selected.some((entry) => entry.provider === 'anthropicAPI' || entry.provider === 'openaiAPI') && (
            <div className="note warn">
              A metered candidate needs the provider's published prices, with their source and when you captured them.
              Model Lab never fetches prices — an estimate that changed between the preview and the run is not an estimate
              anybody can approve — so a metered campaign is created from the terminal with
              <code> cernum create … --pricing prices.json</code> until a price editor exists here.
            </div>
          )}
        </>
      )}
    </>
  );
}
