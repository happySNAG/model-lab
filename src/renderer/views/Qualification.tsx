import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { Shell } from '../App';
import { Card, Empty, Pill, here } from '../components';
import { QualificationView as QualificationViewModel, qualificationViewOf } from '../routing-status-view';

// READ-ONLY. Each route's qualification as the cse1 status export states it: safe to route or not, the
// newest verdict, and any expiry warning. This screen has no action: it reads the evidence on disk and
// changes nothing, contacts nothing and routes nothing.

export function QualificationScreen({ view }: { view: QualificationViewModel }) {
  return (
    <>
      {view.corrupt && (
        <div className="note bad">
          {view.corrupt.message}
          <ul className="small">{view.corrupt.files.map((file) => <li key={file.filePath}><code>{file.filePath}</code>: {file.reason}</li>)}</ul>
        </div>
      )}
      <Card>
        {view.state === 'unreadable' ? (
          <Empty title="The routing evidence could not be read"><p>{view.message}</p></Empty>
        ) : view.state === 'empty' ? (
          <Empty title="No routes yet"><p>{view.message}</p></Empty>
        ) : (
          <div className="table-wrap"><table className="table" data-testid="qualification-table">
            <thead><tr><th>Route</th><th>Safe to route</th><th>Latest verdict</th><th>Expiry</th><th>Availability</th></tr></thead>
            <tbody>{view.rows.map((row) => (
              <tr key={row.routeKey}>
                <td>
                  <strong>{row.routeKey}</strong>
                  {row.routableCapabilities.length > 0 && <div className="sub">Routable for {row.routableCapabilities.join(', ')}</div>}
                  {row.blockers.length > 0 && <div className="sub">{row.blockers.join('; ')}</div>}
                </td>
                <td><Pill tone={row.safeToRoute ? 'ok' : 'neutral'}>{row.safeLabel}</Pill></td>
                <td className="small">
                  {row.latestVerdictLabel}
                  {row.lastSuccessfulQualificationAt && <div className="sub">Last qualified {row.lastSuccessfulQualificationAt}</div>}
                </td>
                <td className="small">
                  {row.expiry ? <Pill tone={row.expiry.state === 'expired' ? 'bad' : 'warn'}>{row.expiryLabel}</Pill> : <span className="muted">{row.expiryLabel}</span>}
                  {row.expiry && <div className="sub">{row.expiry.reason}</div>}
                </td>
                <td className="muted small">{row.availability}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {view.disclosure && <p className="faint small">{view.disclosure}</p>}
    </>
  );
}

export function QualificationView({ shell: _shell }: { shell: Shell }) {
  const [view, setView] = useState<QualificationViewModel>();

  useEffect(() => {
    void api.getRoutingStatus().then((result) => setView(qualificationViewOf(result)))
      .catch((error) => setView(qualificationViewOf({ ok: false, root: 'the campaign root', reason: error instanceof Error ? error.message : String(error) })));
  }, []);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Qualification</h1>
          <p>Every route {here} knows of, whether it is safe to route, its newest qualification verdict and any expiry warning. Read from the evidence on disk; this screen changes nothing.</p>
        </div>
        {view && view.state === 'rows' && <Pill tone="neutral">{view.safeCount} of {view.rows.length} safe · {view.expiryWarningCount} expiry warning{view.expiryWarningCount === 1 ? '' : 's'}</Pill>}
      </div>
      {view === undefined ? <Card><p className="muted">Reading the routing evidence…</p></Card> : <QualificationScreen view={view} />}
    </div>
  );
}
