// Cernum core · Cernum Pass 10, Gate D — the ONE scoring-policy version bump.
//
// Gate D freezes the complete hybrid governance policy as a single version. It is declared here, in a
// module of its own with no imports, so that `evaluators.ts` can read it without importing the
// catalog (which imports the evaluators) and so that the bump is a single literal a reader can find.
//
// WHAT THE VERSION COVERS. Every governed policy in the catalog, together: the mechanical rules
// carried by the candidate matcher AND `gov.memory.no-resurrect-deleted`, which is held out of the
// mechanical layer and referred to a human rubric judge. Adopting the mechanical rules alone is
// forbidden — it would create another incomplete scoring version, which is the failure the whole
// Cernum sequence exists to stop.
//
// WHAT IT DOES NOT DO. It does not rescore, rerank, or touch a single stored row. Version 1 policies
// stay registered, unmodified, and are still what every historical attempt resolves to, so every
// existing result stays reproducible byte for byte. Nothing is routed to this version until a
// campaign asks for it.

/** The hybrid governance policy version. Bumped exactly once, from '1'. */
export const HYBRID_GOVERNANCE_POLICY_VERSION = '2';

/** The version every historical row was scored under, and still resolves to. */
export const CANONICAL_GOVERNANCE_POLICY_VERSION = '1';
