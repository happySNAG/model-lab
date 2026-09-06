// Model Lab · benchmark sessions. A session groups the runs of one benchmark (one run per suite,
// all selected models in each run) with the machine and runtime context they ran under. Sessions are
// application metadata; the evidence itself lives only in the append-only evidence store.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionRecord } from '../shared/ipc';

export class SessionIndex {
  private sessions: SessionRecord[] = [];
  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions?: SessionRecord[] };
      this.sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
    } catch { this.sessions = []; }
    // A session that was 'running' when the application last closed is incomplete — stated, never hidden.
    let changed = false;
    for (const session of this.sessions) {
      if (session.state === 'running') { session.state = 'incomplete'; session.failureDetail = 'the application closed while this benchmark was running'; changed = true; }
    }
    if (changed) this.persist();
  }
  all(): SessionRecord[] {
    return this.sessions.map((s) => ({ ...s }));
  }
  get(sessionID: string): SessionRecord | undefined {
    const found = this.sessions.find((s) => s.sessionID === sessionID);
    return found ? { ...found } : undefined;
  }
  upsert(session: SessionRecord): void {
    const at = this.sessions.findIndex((s) => s.sessionID === session.sessionID);
    if (at >= 0) this.sessions[at] = { ...session };
    else this.sessions.push({ ...session });
    this.persist();
  }
  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ sessions: this.sessions }, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
  }
}
