# Ordra runtime defects found on the Mac mini interim controller

This file reports two defects in **Ordra** (the orchestrator) to the MacBook Pro Ordra supervisor.

- **They are Ordra defects, not Cernum implementation defects.** No Cernum source, test or configuration caused or contains them.
- Both were observed on the Mac mini's frozen interim runtime (build `b27eb5a`) on 2026-10-17/18.

---

## Defect 1: a campaign repinned to a new goal version cannot plan a launchable pass

**Observed**
- A goal was versioned (v1 → v2) and its campaign repinned to v2 with `repin-campaign`.
- Every pass planned after that either:
  - failed planning with `criterion_not_in_campaign` when it cited the v2 criteria; or
  - planned against v1 and then failed work-order assembly with `unknown_criterion`.
- So no pass in the repinned campaign could ever launch.

**Cause (read from source)**
- `plan-pass` checks the cited criteria against the campaign's **derived** (v1) `criteria_addressed` (`planning.py`, around line 875).
- Work-order assembly checks them against the **pinned** (v2) goal (`workorder.py`, around line 1476).
- The two never agree after a repin.

**Workaround used:** cancel the repinned campaign, keeping its history, and derive a continuation campaign directly under v2. That cost extra owner approvals and budget raises.

**Suggested fix:**
- Make `plan-pass` read the campaign's pinned version after a repin, or have repinning re-derive `criteria_addressed`.
- Add a test that repins and then plans and assembles one pass.

## Defect 2: a malformed verification command passes planning, then blocks every lane without raising a decision

**Observed**
- A pass was planned with the verification command `grep -q '^## Decision requested' <file>`. It contains shell quotes.
- `plan-pass` accepted it. Only at verification time did Ordra refuse it, under its rule that verification commands must be structured (VF-9, `command_not_structured`).
- The attempt was then **withheld**: the worker had finished and verification could never run.
- On a controller with one action per cycle, every cycle spent that action on the refused verification and stopped with `action_limit`. **No other lane's eligible pass launched for about 1 h 50 min**, and **no escalation or decision was raised**, so nothing told a human.

**Recovery used**
1. `abandon-local-attempt`, which exists for exactly this shape, with the owner's words and an attestation that the worker had stopped.
2. `retire-pass`, immediately after.

**Suggested fix**
1. Run the same structural check the verifier uses (`verification.structure_refusals`) inside `plan-pass`, and refuse there.
2. When a withheld attempt's verification is refused, raise an escalation instead of retrying silently every cycle.
3. Do not let a permanently refused verification consume the cycle's only action.

**Structured equivalent:** `grep -q ^##[[:space:]]Decision[[:space:]]requested <file>`. It has no shell metacharacters and is tested as an argument vector.
