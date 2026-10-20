// Where the sealed model-lab evidence lives on this machine.
//
// CERNUM_EVIDENCE_ROOT wins when it is set. Otherwise the first of the two known homes that
// exists is used, LaCie first: the tree was sealed on the LaCie volume and later copied, byte
// for byte, to the NemoClaw Data volume. When neither exists the LaCie path is returned, so a
// test that needs the evidence hard-stops on a missing file exactly as it always has.
import { existsSync } from 'node:fs';

const LACIE_EVIDENCE_ROOT = '/Volumes/LaCie/MacMini-NemoClaw-Workspace/model-lab-results';
const NEMOCLAW_DATA_EVIDENCE_ROOT = '/Volumes/NemoClaw Data/MacMini-NemoClaw-Workspace/model-lab-results';

export function evidenceRoot(): string {
  const configured = process.env.CERNUM_EVIDENCE_ROOT;
  if (configured !== undefined) return configured;
  for (const candidate of [LACIE_EVIDENCE_ROOT, NEMOCLAW_DATA_EVIDENCE_ROOT]) {
    if (existsSync(candidate)) return candidate;
  }
  return LACIE_EVIDENCE_ROOT;
}
