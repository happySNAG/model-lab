// Benchmark engine · render the adjudication packet as pages a person will actually read.
//
// The JSON packet is the machine artefact and the record; this is the one a reviewer sits down with.
// Three things it must get right, and one it must not do:
//
//   ONE DECISION, ONE PAGE.  Everything a verdict needs is on the page — prompt, context, the whole
//                            response, the rule in full, the trigger, the choices. A reviewer who
//                            has to scroll back to a header to remember the rule is a reviewer who
//                            will stop doing it by decision forty.
//   THE RESPONSE IS FENCED.  Model output contains markdown, including headings and fences of its
//                            own. Every quoted block is wrapped in a fence longer than any fence
//                            inside it, so an answer can never break out and restyle the page it is
//                            being judged on.
//   NO NUMBERS THAT ORDER.   No latency, no tokens, no cost, no rank, no campaign position. The
//                            decision counter is a position in a SHUFFLED list and carries nothing.
//   AND NO STEER.            No verdict is suggested, no choice is emphasised, no row is flagged as
//                            "likely a false positive". The four proven false positives from Pass 8
//                            are in here somewhere and are presented exactly like the other 128.

import { AdjudicationDecision, AdjudicationPacket, GovernanceDecision, RubricDecision } from './adjudication';

/**
 * A fence long enough to survive the content.
 *
 * A response containing ```` ```json ```` would otherwise terminate a three-backtick block early and
 * spill the rest of the answer into the page as formatted markdown — which is not a cosmetic problem
 * when the thing being judged is the exact text of the answer.
 */
function fence(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function quoted(content: string, info = ''): string {
  const bar = fence(content);
  return `${bar}${info}\n${content}\n${bar}`;
}

/** A single-line value shown inline, with the empty case named rather than left blank. */
function inlineCode(value: string): string {
  if (value.length === 0) return '_(empty)_';
  return `\`${value.replace(/`/g, 'ˋ')}\``;
}

function governancePage(decision: GovernanceDecision, position: number, total: number): string {
  const lines: string[] = [];
  lines.push(`## Decision ${position} of ${total} — \`${decision.decisionID}\``);
  lines.push('');
  lines.push(`**Kind** governance · **Case** \`${decision.caseID}\``);
  if (decision.identicalRowCount > 1) {
    lines.push('');
    lines.push(`> **This one verdict covers ${decision.identicalRowCount} rows.** They are byte-identical: same case, `
      + 'same prompt, same supplied context, same rule, same response. Answer it once.');
    lines.push('>');
    lines.push(`> Rows: ${decision.coversRowIDs.map((id) => `\`${id}\``).join(', ')}`);
  } else {
    lines.push('');
    lines.push(`Row: \`${decision.coversRowIDs[0] ?? ''}\``);
  }

  lines.push('');
  lines.push('### The prompt the model was given');
  lines.push('');
  lines.push(quoted(decision.prompt));
  if (decision.suppliedContext) {
    lines.push('');
    lines.push('### The context the case supplied with it');
    lines.push('');
    lines.push(quoted(decision.suppliedContext));
  }

  lines.push('');
  lines.push('### The response, in full');
  lines.push('');
  lines.push(quoted(decision.responseText));

  lines.push('');
  lines.push('### The rule');
  lines.push('');
  lines.push(`**\`${decision.ruleID}\`** — ${decision.ruleStatement}`);
  lines.push('');
  lines.push(decision.trigger.kind === 'containsProhibited'
    ? `**What fired:** the response CONTAINS a prohibited form of \`${decision.trigger.conceptLabel}\`.`
    : `**What fired:** the response OMITS every required form of \`${decision.trigger.conceptLabel}\`.`);
  lines.push('');
  lines.push(decision.trigger.explanation);
  lines.push('');
  lines.push(decision.trigger.kind === 'containsProhibited'
    ? 'Prohibited forms, as the rule lists them:'
    : 'Required forms — the response had to contain at least one of these, and contained none:');
  lines.push('');
  for (const form of decision.trigger.conceptForms) lines.push(`- ${inlineCode(form)}`);

  lines.push('');
  lines.push('### What the matcher saw');
  lines.push('');
  if (decision.trigger.kind === 'containsProhibited') {
    lines.push(`**Exact substring that triggered it:** ${inlineCode(decision.trigger.matchedSubstring ?? '')}`);
    lines.push('');
    lines.push('**The surrounding text** — read this for a negation or a quotation:');
    lines.push('');
    lines.push(quoted(decision.trigger.surroundingText ?? ''));
  } else {
    lines.push('**There is no triggering substring.** The matcher fired on an ABSENCE: none of the required '
      + 'forms above appears anywhere in the response. Below, for each required form, is the longest run of that '
      + 'form\'s own words that the response does contain, with the text around it — which is where a synonym or a '
      + 'differently-worded commitment becomes visible.');
    lines.push('');
    for (const miss of decision.trigger.nearMisses ?? []) {
      if (miss.tokensMatched === 0) {
        lines.push(`- ${inlineCode(miss.form)} — nothing in the response matched any part of it.`);
        continue;
      }
      lines.push(`- ${inlineCode(miss.form)} — closest run present: ${inlineCode(miss.longestPresentRun)} `
        + `(${miss.tokensMatched} of ${miss.tokensInForm} words), in this passage:`);
      lines.push('');
      lines.push(quoted(miss.context));
      lines.push('');
    }
  }

  lines.push('');
  lines.push('### Your verdict');
  lines.push('');
  lines.push('Choose exactly one:');
  lines.push('');
  for (const choice of decision.choices) {
    lines.push(`- [ ] \`${choice}\` — ${decision.choiceMeanings[choice]}`);
  }
  lines.push('');
  lines.push('**Rationale:**');
  lines.push('');
  lines.push('```');
  lines.push('');
  lines.push('```');
  return lines.join('\n');
}

function rubricPage(decision: RubricDecision, position: number, total: number): string {
  const lines: string[] = [];
  lines.push(`## Decision ${position} of ${total} — \`${decision.decisionID}\``);
  lines.push('');
  lines.push(`**Kind** rubric · **Case** \`${decision.caseID}\``);
  if (decision.identicalRowCount > 1) {
    lines.push('');
    lines.push(`> **This one rating covers ${decision.identicalRowCount} rows**, byte-identical in case, prompt, `
      + 'context, rubric and response.');
    lines.push('>');
    lines.push(`> Rows: ${decision.coversRowIDs.map((id) => `\`${id}\``).join(', ')}`);
  } else {
    lines.push('');
    lines.push(`Row: \`${decision.coversRowIDs[0] ?? ''}\``);
  }

  lines.push('');
  lines.push('### The prompt the model was given');
  lines.push('');
  lines.push(quoted(decision.prompt));
  if (decision.suppliedContext) {
    lines.push('');
    lines.push('### The context the case supplied with it');
    lines.push('');
    lines.push(quoted(decision.suppliedContext));
  }

  lines.push('');
  lines.push('### The response, in full');
  lines.push('');
  lines.push(quoted(decision.responseText));

  lines.push('');
  lines.push('### The rubric (frozen)');
  lines.push('');
  lines.push(`**${decision.rubricTitle}** — \`${decision.rubricID}@${decision.rubricVersion}\``);
  lines.push('');
  lines.push(decision.rubricGuidance);
  lines.push('');
  lines.push('Rate each item, then give an overall rating.');
  lines.push('');
  for (const item of decision.rubricItems) {
    lines.push(`- **${item}**: \`____________\``);
  }

  lines.push('');
  lines.push('### Your rating');
  lines.push('');
  lines.push(`Permitted ratings: ${decision.permittedRatings.map((r) => `\`${r}\``).join(' · ')}`);
  lines.push('');
  lines.push('**Overall:** `____________`');
  lines.push('');
  lines.push('**Rationale:**');
  lines.push('');
  lines.push('```');
  lines.push('');
  lines.push('```');
  return lines.join('\n');
}

function page(decision: AdjudicationDecision, position: number, total: number): string {
  return decision.kind === 'governance'
    ? governancePage(decision, position, total)
    : rubricPage(decision, position, total);
}

/**
 * One Markdown document per batch, numbered, never more than `packet.batchSize` decisions in each.
 *
 * The header repeats the instructions on every batch rather than assuming batch 1 is at hand: these
 * are meant to be readable, and reviewable, one file at a time.
 */
export function renderAdjudicationBatches(packet: AdjudicationPacket): { fileName: string; markdown: string }[] {
  const byID = new Map(packet.decisions.map((decision) => [decision.decisionID, decision]));
  const width = String(packet.batches.length).length;
  return packet.batches.map((batch) => {
    const lines: string[] = [];
    const number = String(batch.batchNumber).padStart(width, '0');
    lines.push(`# Cernum blinded review — batch ${batch.batchNumber} of ${packet.batches.length}`);
    lines.push('');
    lines.push(`**${batch.decisionIDs.length} decisions in this batch.** `
      + `Across all batches: ${packet.decisionCount} decisions covering ${packet.rawRowCount} rows.`);
    lines.push('');
    lines.push('## How to use this packet');
    lines.push('');
    for (const instruction of packet.instructions) lines.push(`- ${instruction}`);
    lines.push('');
    lines.push('---');
    for (const [index, id] of batch.decisionIDs.entries()) {
      const decision = byID.get(id);
      if (!decision) continue;
      lines.push('');
      lines.push(page(decision, index + 1, batch.decisionIDs.length));
      lines.push('');
      lines.push('---');
    }
    lines.push('');
    lines.push(`_End of batch ${batch.batchNumber}._`);
    return { fileName: `CERNUM-PASS-09-REVIEW-BATCH-${number}.md`, markdown: lines.join('\n') + '\n' };
  });
}
