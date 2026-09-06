import React from 'react';
import type { Measurement } from '../core/candidate';
import { api } from './api';

/** Platform words, fixed for the process. Copy says "this Mac" on macOS and "this PC" elsewhere — a truthful noun, never a guess. */
export const isMac = api.platform === 'darwin';
export const machineNoun = isMac ? 'Mac' : 'PC';
export const here = `this ${machineNoun}`;
export const Here = `This ${machineNoun}`;

export function Pill({ tone, children, pulse }: { tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'accent'; children: React.ReactNode; pulse?: boolean }) {
  return <span className={`pill ${tone}`}><span className={`dot${pulse ? ' pulse' : ''}`} aria-hidden />{children}</span>;
}

export function Card({ title, actions, children, className, flat }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; flat?: boolean }) {
  return (
    <section className={`card${flat ? ' flat' : ''}${className ? ` ${className}` : ''}`}>
      {title !== undefined && <div className="card-title"><h2>{title}</h2>{actions}</div>}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children}</div>;
}

/** A numbered step heading for guided screens ("1 · Models"). */
export function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return <span className="step"><span className="step-n" aria-hidden>{n}</span>{children}</span>;
}

export function Progress({ value, max, thin }: { value: number; max: number; thin?: boolean }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return <div className={`progress${thin ? ' thin' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>;
}

export function Modal({ title, children, onClose, actions, wide }: { title: string; children: React.ReactNode; onClose: () => void; actions: React.ReactNode; wide?: boolean }) {
  // Escape closes; focus lands inside the dialog so keyboard users are not left behind it.
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

export function measurementText<T>(m: Measurement<T> | undefined, format: (v: T) => string, missing = 'not reported'): string {
  if (!m) return missing;
  return 'measured' in m ? format(m.measured) : missing;
}

export function pct(m: Measurement<number> | undefined): string {
  return measurementText(m, (v) => `${Math.round(v / 10)}%`, 'n/a');
}

export function ms(m: Measurement<number> | undefined): string {
  return measurementText(m, (v) => (v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`), 'n/a');
}

export function tps(m: Measurement<number> | undefined): string {
  return measurementText(m, (v) => `${(v / 1000).toFixed(1)} tok/s`, 'n/a');
}

export function bytes(n?: number): string {
  if (n === undefined) return 'size not reported';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function duration(msValue: number): string {
  const s = Math.floor(msValue / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' {
  switch (status) {
    case 'completed': case 'pass': case 'running': case 'satisfied': return 'ok';
    case 'partial': case 'timedOut': case 'cancelled': case 'incomplete': case 'requiresHumanReview': case 'indeterminate': return 'warn';
    case 'failed': case 'fail': case 'malformedOutput': case 'identityMismatch': case 'candidateUnavailable': case 'unsupportedCapability': case 'violated': case 'disqualified': return 'bad';
    default: return 'neutral';
  }
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    completed: 'Answered', failed: 'Failed', timedOut: 'Timed out', cancelled: 'Cancelled', unsupportedCapability: 'Unsupported', candidateUnavailable: 'Unavailable',
    malformedOutput: 'Malformed', identityMismatch: 'Identity mismatch', pass: 'Pass', partial: 'Partial', fail: 'Fail', indeterminate: 'Indeterminate',
    requiresHumanReview: 'Needs human review', notApplicable: 'No answer to judge', running: 'Running', incomplete: 'Incomplete',
    recommended: 'Recommended', notRecommended: 'Not recommended', insufficientEvidence: 'Insufficient evidence', disqualified: 'Disqualified',
  };
  return labels[status] ?? status;
}

export function sessionStateLabel(state: string): string {
  const labels: Record<string, string> = { running: 'Running', completed: 'Completed', cancelled: 'Cancelled', incomplete: 'Incomplete', failed: 'Failed' };
  return labels[state] ?? state;
}

export const DIMENSION_LABELS: Record<string, string> = {
  conversation: 'Conversation', memoryHonesty: 'Memory honesty', contextIntegration: 'Context integration', calendarReasoning: 'Calendar reasoning',
  emotionalUnderstanding: 'Emotional understanding', privacyAndGovernance: 'Privacy & governance', hallucinationResistance: 'Hallucination resistance',
  toolUse: 'Tool use', planning: 'Planning', longContextRetrieval: 'Long-context retrieval', safetyBoundaries: 'Safety boundaries', structuredOutputReliability: 'Structured output',
};
export function dimensionLabel(d: string): string {
  return DIMENSION_LABELS[d] ?? d;
}

export function caseLabel(caseID: string): string {
  const parts = caseID.split(':');
  return parts[parts.length - 1].replace(/-/g, ' ');
}
