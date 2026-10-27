# CERNUM
# MASTER PRODUCT VISION, ARCHITECTURE MANIFESTO AND COMPLETION DIRECTIVE
Version 1.0, October 26, 2026

## 1. WHY THIS DOCUMENT EXISTS

We have identified a fundamental problem with our development process.

Ordra has been implementing individual goals, campaigns, and passes without necessarily having the complete vision of what Cernum is supposed to become.

This document establishes that vision.

It is intended to become Cernum's durable, authoritative product-direction specification, subject to the owner's existing approval and governance rules.

This is not a request to complete one campaign.

This is a directive to understand the entire desired system, determine what already exists, identify everything missing, establish an evidence-backed development roadmap, and continue developing toward the completed product.

Do not mistake passing tests, exhausting a campaign budget, or closing a goal for completion of the overall Cernum product.

Cernum is complete only when its intended end-to-end capabilities have been implemented, integrated, verified, and demonstrated.

Preserve the history and scope of existing recorded goals. This manifesto governs the desired future product, but does not retroactively expand pass budgets, authorize protected actions, or override existing security requirements.

## 2. THE CENTRAL VISION

Cernum is the AI intelligence, evaluation, qualification, and routing system for the Ordra ecosystem.

Ordra is responsible for orchestrating work.

Cernum is responsible for determining which qualified AI execution configuration is best suited to perform that work.

The desired operational loop is:

1. Ordra receives or generates a task.
2. Ordra supplies Cernum with the task's requirements and execution constraints.
3. Cernum classifies the task.
4. Cernum identifies the models currently available and authorized.
5. Cernum evaluates their proven capabilities, reliability, availability, cost, speed, and task-specific suitability.
6. Cernum selects a qualified model.
7. Cernum selects an appropriate reasoning-effort level when supported.
8. Cernum recommends the authorized machine and execution configuration.
9. Ordra launches the actual worker using that configuration.
10. Ordra independently verifies the work.
11. Cernum receives the observed result.
12. Cernum learns which configurations perform best for similar tasks.
13. Future routing decisions improve based on measured evidence.

This cycle should operate automatically for routine authorized work.

The owner should not need to manually choose Opus, Sonnet, Haiku, Fable, Codex, or a local model for every development task.

The system should learn those decisions.

## 3. THE ULTIMATE OPTIMIZATION OBJECTIVE

Cernum must optimize for:

THE FASTEST RELIABLE VERIFIED TASK COMPLETION AT THE LOWEST PRACTICAL TOTAL RESOURCE COST.

This is not the same as choosing the fastest model.

It is not the same as choosing the cheapest model.

It is not the same as choosing the model with the highest generic benchmark score.

A fast model that fails repeatedly may be slower and more expensive overall than a stronger model that succeeds on its first attempt.

Cernum must account for the entire outcome:

- Initial worker execution
- Model reliability
- Incorrect outputs
- Failed tests
- Retry attempts
- Model fallback
- Additional reasoning
- Verification duration
- Integration failures
- Recovery work
- Total elapsed time
- Token consumption where observable
- Subscription usage limits
- Actual monetary cost where applicable
- Hardware resource consumption
- Final independently verified success

Primary qualification priorities:

1. Correctness and reliability.
2. Total resource and subscription efficiency.
3. End-to-end completion time.

Within comparable reliability levels, optimize for lower total cost and faster completion.

Never sacrifice mandatory correctness or safety requirements for speed.

A model configuration should be preferred because evidence shows it completes the relevant task type successfully and efficiently.

## 4. SUPPORTED MODEL ECOSYSTEM

Cernum must ultimately support all compatible and authorized model execution systems available to our development environment.

### Anthropic Claude

Include accessible Claude families and versions, such as:

- Opus
- Sonnet
- Haiku
- Fable, where genuinely available
- Newer officially supported models discovered later

Do not hardcode assumed model availability.

Verify exact model identifiers, authentication compatibility, and actual execution identity.

### OpenAI and Codex

Support authorized OpenAI coding models through compatible subscription-backed Codex execution paths.

Discover available models and verify the exact supported CLI integration.

Do not assume that a ChatGPT subscription provides arbitrary API access or unattended execution rights.

Keep model identity and execution evidence.

### Local models

Support compatible local models through Ollama and other explicitly authorized local runtimes.

Evaluate whether local models are suitable for:

- Classification
- Summarization
- Documentation
- Small coding tasks
- Information extraction
- Planning assistance
- Other independently verified low-risk tasks

A local model must not receive elevated authority merely because it is free to run.

### Future providers

Design an extensible provider-adapter architecture.

New models and providers should be introduced without rewriting the entire evaluation or routing system.

Every provider must meet the same evidence, security, authentication, and qualification standards.

### Subscription policy

Our current development preference is to use existing authorized Claude Code and Codex subscription access plus local execution.

Do not introduce paid Anthropic or OpenAI API usage, pay-as-you-go billing, or purchased credits without separate explicit owner approval.

Model cost accounting must distinguish actual charges, subscription allowance consumption, and local compute expenses.

## 5. AUTOMATIC MODEL DISCOVERY

Cernum must discover available models and changes automatically.

It should detect:

- Newly released models
- Newly accessible subscription models
- Retired models
- Changed identifiers
- Availability restrictions
- Execution-tool updates
- Supported reasoning-effort settings
- New capabilities
- Changed tool-use support
- Model deprecations
- Expiring qualification evidence

Discovery should be recurring, durable, and resilient to restarts.

Newly discovered models enter a candidate registry.

Discovery must not equal production eligibility.

Each candidate requires the applicable identity, execution, capability, and benchmark checks before Cernum can recommend it for governed work.

Models that lose their qualification or become inaccessible must be excluded automatically.

Store provenance and timestamps for discovery evidence.

Avoid repeatedly benchmarking unchanged candidates without a justified reason.

## 6. MODEL IDENTITY VERIFICATION

Exact model identity is essential.

Cernum must distinguish:

- The model requested
- The model accepted by the execution interface
- The model actually used, to the extent independently observable
- The execution provider
- The authenticated route
- The machine executing the request
- The version of the execution tool

If model identity cannot be reliably established, do not silently treat that model as qualified.

Use explicit uncertainty states.

Model aliases, provider fallback, and CLI behavior must not make Cernum believe that one model executed when another did.

Any identity mismatch must produce evidence and appropriate exclusion or quarantine.

## 7. MODEL QUALIFICATION

A discovered model must prove itself before receiving production work.

Preserve our current 90% qualification threshold unless the owner explicitly changes it through the approved policy process.

Preserve cqp1 as the active qualification policy until a separate activation decision.

Develop cqp2 as a selectable, testable alternative with the approved multi-session or multi-day evidence requirements.

Qualification should cover:

- Model identity
- Real execution
- Tool compatibility
- Instruction following
- Repository understanding
- Code editing
- Test generation
- Debugging
- Multi-step task execution
- Reliability
- Failure recovery
- Task-category performance
- Subscription or execution availability

Preserve raw benchmark results, test definitions, execution context, and verification evidence.

Never fabricate benchmark results or use assumed capabilities as qualification proof.

Unqualified models may be evaluated in controlled experiments, but may not silently enter authorized production routing.

## 8. THE BENCHMARKING ENGINE

Build a comprehensive, reproducible benchmarking system reflecting the work Ordra actually performs.

Benchmark categories should include:

- Simple code edits
- Complex code changes
- New feature implementation
- Application UI implementation
- Frontend development
- Backend development
- API integration
- Architecture and system design
- Code review
- Debugging
- Test creation
- Test repair
- Refactoring
- Documentation
- Repository maintenance
- Merge-sensitive tasks
- Long-context work
- Multi-step autonomous development
- Failure recovery
- Cross-project integration

Include real-world tasks and controlled benchmark fixtures.

Benchmark results must be comparable only when the methodology supports comparison.

Record task difficulty, codebase context, tools, execution restrictions, hardware, and test environment.

Protect benchmark fixtures from leakage and contamination.

Never optimize toward a leaderboard while undermining real task performance.

## 9. ADAPTIVE REASONING EFFORT

This is a required part of the current Cernum upgrade roadmap.

Cernum must eventually select both:

A. THE MODEL
B. THE REASONING-EFFORT LEVEL

Different tasks need different amounts of reasoning.

A trivial edit should not automatically receive maximum reasoning effort.

A complex architecture or difficult debugging problem may justify greater effort.

For each supported model, benchmark the reasoning-effort options exposed by its authorized execution interface.

Measure:

- Correctness
- First-attempt success
- Verification success
- Number of retries
- Execution time
- Total end-to-end time
- Token consumption where available
- Subscription consumption
- Real financial cost where applicable
- Final verified task quality

Treat a model at low effort and the same model at high effort as separate execution configurations when the difference is material.

Do not assume maximum effort is best.

Determine when additional reasoning produces a measurable improvement.

Develop adaptive escalation:

1. Begin with a qualified configuration appropriate to the task.
2. Detect inadequate reasoning, failed verification, or insufficient confidence.
3. Increase reasoning effort if supported and justified.
4. Switch to a stronger qualified model when appropriate.
5. Re-evaluate after failures.
6. Avoid wasteful repeated attempts with configurations known to fail the task category.

Do not claim that a reasoning-effort setting was actually applied unless the execution interface provides sufficient evidence.

When effort is not observable, record that limitation.

SEQUENCING REQUIREMENT:

Finish and stabilize reliable model routing and fallback first.

Then implement adaptive effort through governed development without destabilizing existing production execution.

Adaptive effort must become part of Cernum's active roadmap, not an indefinite future idea.

## 10. TASK-AWARE ROUTING

Cernum should understand the nature of the task before selecting an execution configuration.

Classification may consider:

- Task category
- Complexity
- Repository size
- Required tools
- Files likely to change
- Risk level
- Context length
- Verification difficulty
- Estimated reasoning needs
- Model-specific strengths
- Execution-machine requirements
- Data restrictions
- Urgency
- Available subscription capacity

Cernum must use measured results rather than simplistic assumptions such as always choosing Opus for complex work or always choosing Haiku for easy work.

Any model-role examples are hypotheses to benchmark, not permanent rules.

The recommendation should include:

- Selected model and exact identifier
- Selected reasoning effort
- Selected supported execution route
- Proposed machine or eligible host
- Task-classification evidence
- Qualification and freshness evidence
- Expected reliability
- Expected end-to-end time
- Expected resource consumption
- Fallback options
- Reasoning for the selection
- Confidence and important uncertainties

Support a structured, versioned recommendation contract that Ordra can consume reliably.

## 11. REAL ORDRA LAUNCHER INTEGRATION

This is one of the most important unfinished objectives.

Cernum must not stop at recommending a model in a report.

Its recommendations must eventually control actual authorized Ordra worker execution.

Required sequence:

1. Ordra requests a recommendation.
2. Cernum returns a qualified configuration.
3. Ordra checks policy and authorization.
4. Ordra translates the recommendation into supported launcher parameters.
5. Ordra dispatches the worker.
6. The worker executes with the intended model.
7. Ordra captures the actual execution identity.
8. Ordra verifies the resulting work.
9. Cernum receives the outcome.
10. Cernum updates its evidence.

Proof must include actual worker execution, not merely a recommended model name.

A worker that silently falls back to Opus is not a successful non-Opus canary.

Preserve the existing Opus production restriction until the relevant D3 and D10 requirements are completed and separately approved.

The final system should no longer require Opus for every routine task.

## 12. RELIABLE FALLBACK AND MODEL AVAILABILITY

Cernum must handle changing model availability gracefully.

Examples:

- A model hits its subscription limit.
- An individual model enters cooldown.
- Authentication expires.
- A model is removed or renamed.
- A provider becomes temporarily unavailable.
- A local model cannot fit in available RAM.
- A model fails a required tool call.
- A model's qualification expires.
- A launch requests the wrong model.
- A selected reasoning-effort setting is unsupported.

Fallback decisions must respect qualification and authorization rules.

Do not allow one Claude model's cooldown to incorrectly disable every Claude route.

Track model-specific and provider-specific failures separately.

Use a qualified alternate model when appropriate.

If no eligible route exists, report a real blocked state instead of silently launching an unqualified model.

Keep clear audit evidence of every fallback.

## 13. REAL OUTCOME LEARNING

Cernum must learn from actual Ordra development results.

The most valuable benchmark is whether a model successfully completed real work.

Collect eligible data from verified Ordra passes:

- Task classification
- Model and execution identity
- Reasoning effort
- Execution environment
- Duration
- Retry count
- Verification result
- Failure category
- Resources used
- Subscription usage
- Recovery actions
- Integration outcome

Use the evidence to improve future recommendations.

Separate benchmark evidence from production observations so neither is misrepresented.

Use appropriate statistical confidence and avoid overreacting to isolated results.

Develop controlled exploration of alternative qualified configurations when the expected benefit justifies it.

Do not conduct unauthorized or expensive experiments merely to collect data.

## 14. CONTINUOUS OPTIMIZATION

Cernum should become progressively better without requiring constant manual tuning.

Use an evidence-backed improvement cycle:

1. Observe current performance.
2. Identify an improvement opportunity.
3. Form a measurable hypothesis.
4. Propose a candidate change.
5. Test against a baseline.
6. Compare real outcomes.
7. Run regression checks.
8. Promote a verified improvement under applicable policy.
9. Monitor for regressions.
10. Roll back when necessary.

Potential optimization targets include:

- Model selection
- Reasoning effort
- Fallback policy
- Task classification
- Benchmark quality
- Context packing
- Prompt guidance
- Tool-selection recommendations
- Workflow efficiency
- Verification strategy
- Machine placement

Use the lessons we learned from Google's Harness² approach, but implement suitable native improvements within the Ordra/Cernum architecture rather than adopting a competing orchestration runtime.

Cernum supplies evidence and evaluation intelligence.

Ordra retains execution and governance authority.

## 15. MULTI-MACHINE OPERATION

The intended long-term architecture is:

MACBOOK PRO:
- Sole authoritative Ordra controller.
- Main Ordra Office interface.
- Governed development orchestration.
- Central decisions, records, and supervision.
- MacBook Pro workers under approved limits.

MAC MINI:
- Remote Ordra worker host.
- Cernum benchmarking and qualification workloads.
- Skippy, AMP, and TESTATA development where appropriate.
- Local AI execution.
- Up to the separately approved, resource-supported worker capacity.

The user's long-term target is five MacBook Pro workers and four Mac mini workers, but actual concurrency must depend on measured machine capacity and approved admission rules.

Cernum must learn performance by:

MODEL + TASK + REASONING EFFORT + EXECUTION ROUTE + MACHINE.

The same model may behave differently on different hosts or through different execution paths.

Cernum must understand host capabilities and execution eligibility.

Verified Cernum improvements built on the Mac mini should become available to the MacBook Pro through controlled source synchronization, compatibility checks, testing, and deployment.

Likewise, compatible Ordra improvements developed on the MacBook Pro should benefit the Mac mini.

Use version-controlled repositories and auditable, verified promotion.

Do not create dual authoritative controllers.

CURRENT OPERATING BOUNDARY:

Continue Cernum project development on the Mac mini.

Ordra core architecture, scheduler upgrades, and controller-wide policy development are consolidated in the MacBook Pro's authoritative Ordra development lane.

Do not duplicate those controller upgrades independently on the Mac mini.

When Cernum identifies a required Ordra core change, prepare a concrete integration contract or evidence-backed handoff to the MacBook Pro owner.

Preserve the temporary independent Mac mini project-development arrangement until the approved integration is ready.

## 16. AUTOMATIC BENCHMARK OPERATIONS

Eventually Cernum should operate recurring model-discovery and qualification cycles.

It should support:

- Regular discovery of new models
- Qualification freshness checks
- Scheduled benchmark campaigns
- Requalification after significant model changes
- Expiration warnings
- Relevant regression checks
- Historical performance comparison
- Automatic identification of improved candidates

For heavy benchmarking, support controlled exclusive windows when genuinely required.

Such windows should:

- Be approved and scheduled through Ordra.
- Respect the host's resource limits.
- Preserve essential services.
- Avoid losing existing work.
- Record start and completion evidence.
- Restore ordinary admission and dispatch settings afterward.
- Recover safely after interruption.

However, productive concurrency is the normal default.

Do not serialize independent projects merely because they are separate projects.

Reserve exclusivity for demonstrated resource or benchmark-integrity requirements.

## 17. VISIBILITY AND USER EXPERIENCE

Cernum should have a clear operator-facing view of what it knows and what it is doing.

The user should be able to inspect:

- All discovered models
- Their qualification status
- Available providers
- Accessible subscription routes
- Benchmark histories
- Task-category strengths
- Reasoning-effort comparisons
- Reliability metrics
- Availability and cooldowns
- Qualification expiration dates
- Model recommendations
- Actual Ordra worker selections
- Fallback events
- Evidence and verification results
- Routing changes and rollback history

Cernum's existing application and UI should be extended where necessary, not rewritten without justification.

Ordra Office should ultimately expose useful Cernum routing decisions within each worker's details.

The owner should understand why a particular model was selected.

Do not overwhelm the owner with ordinary technical decisions that the system can resolve under existing authorization.

## 18. FUTURE INTEGRATION WITH SKIPPY

Cernum should eventually provide qualified routing intelligence to Skippy.

Skippy is the personal communication and assistant interface.

Ordra is the execution and orchestration system.

Cernum is the model-selection intelligence.

Skippy may eventually use Cernum to select appropriate models for different requests, considering:

- Quality
- Speed
- Privacy
- Local execution suitability
- Availability
- Context requirements
- Cost and resource impact
- Reasoning effort

Do not allow future Skippy integration to distract from the immediate priority of completing reliable Ordra routing.

Only begin production Skippy routing integration when its dependencies are ready and approved.

## 19. AUTHORITY, SAFETY, AND SECURITY

Cernum does not have authority to override Ordra.

Maintain clear separation:

CERNUM:
Evaluates, qualifies, recommends, measures, learns.

ORDRA:
Authorizes, schedules, dispatches, verifies, records, recovers, and governs.

The owner retains required approval for:

- New paid execution routes
- Expanding tool permissions
- Security changes
- Protected production activations
- Budget increases where required
- Qualification policy promotion
- Production routing activation
- Changes in controller authority
- Unapproved external access
- Other protected governance decisions

Preserve:

- Repository ownership locks
- Existing approval records
- Verified Git history
- Failure evidence
- Existing qualification criteria
- Execution allowlists
- Request-count enforcement
- Safe fallback rules
- Rollback mechanisms
- Current machine resource limits
- Minimum 5 GiB internal free-space floor on the Mac mini

Use the supported Ordra worker process for code changes.

The supervisory Claude Code session should not replace Ordra workers with ungoverned manual coding.

## 20. CURRENT VERIFIED AND REPORTED PROGRESS

The following information is historical context as of October 26, 2026, not a substitute for querying the authoritative Ordra state.

Cernum Block 2:
- Goal G-3531 reported satisfied.
- Eleven development passes reportedly completed.
- Full suite reportedly passed at commit 4d8f67b.

Cernum Block 3:
- Eight-pass development scope approved.
- Includes newer qualification-policy preparation, recommendation logic, outcome feedback, and related infrastructure.
- B3-1 encountered a recovery/re-plan sequence.
- Current replacement pass and final status must be retrieved from Ordra.

Subscription runner:
- cernum-v1-run was reported active in later session records.
- Confirm the exact installation, checksum, activation, qualification, and CV-17 evidence.

D2 qualification:
- Q-1 originally recorded as P-6768.
- Recovery was proposed to retire and re-plan Q-1 with a scoped scripts/qualification worktree.
- The last decision proposed a budget increase from 13 to 14, or 15 including Q-R, with separate budget approval.
- Verify the actual recorded outcome and replacement pass ID.
- Preserve strict model identity checks and authorized request caps.

Opus qualification:
- Renewal deadline reported as November 13, 2026, at 15:53 UTC.
- Q-R renewal remains a separate protected decision unless the authoritative store proves otherwise.

Production routing:
- Real task-by-task qualified non-Opus execution and broad automatic routing remain goals requiring end-to-end proof.
- Do not assume they have been completed simply because a routing component or benchmark passed.

Current operating state must be audited before making a new plan.

## 21. DEVELOPMENT STRATEGY

Do not begin with a rewrite.

Do not create an entirely new Cernum system.

Do not discard completed work.

The preferred development approach is:

AUDIT → RECONCILE → GAP ANALYSIS → PLAN → IMPLEMENT → VERIFY → INTEGRATE → DEMONSTRATE → IMPROVE.

First, inspect the actual repositories, goals, campaigns, test evidence, and current runtime.

Determine which requested capabilities:

A. Already work end to end.
B. Are implemented but not integrated.
C. Exist only as proposals or code scaffolding.
D. Have partial tests but insufficient real-world evidence.
E. Are missing entirely.
F. Are currently blocked by infrastructure.
G. Require protected owner approval.

Do not infer completion from feature names, closed campaigns, or passing isolated tests.

Reuse existing code and verified work whenever practical.

Choose the smallest architecture changes that satisfy the complete vision.

## 22. REQUIRED ROADMAP

Create a full dependency-aware roadmap from the current verified state to the finished Cernum product.

At minimum, cover:

MILESTONE A: FOUNDATION
- Reconcile existing code and records.
- Confirm runner functionality.
- Confirm benchmark and identity evidence.
- Preserve verified Block 2 and Block 3 results.

MILESTONE B: RELIABLE QUALIFICATION
- Complete D2 identity checks.
- Complete authorized model benchmarks.
- Validate qualification records.
- Verify model expiration and availability handling.

MILESTONE C: ROUTING FOUNDATION
- Complete task-aware recommendations.
- Prove fallback behavior.
- Integrate the canonical Cernum-to-Ordra contract.
- Verify model identity through actual launches.

MILESTONE D: REAL NON-OPUS EXECUTION
- Execute the first controlled non-Opus worker.
- Verify requested-versus-actual model identity.
- Verify the task's result.
- Record real outcome evidence.

MILESTONE E: PRODUCTION ROUTING
- Complete the applicable D10 readiness checks.
- Review safety and regression evidence.
- Obtain separate production activation approval.
- Enable qualified automatic routing with rollback.

MILESTONE F: ADAPTIVE REASONING
- Add reasoning-effort detection and support.
- Benchmark model-effort combinations.
- Implement governed adaptive effort selection.
- Measure total task cost and verified completion efficiency.

MILESTONE G: AUTOMATIC DISCOVERY AND REQUALIFICATION
- Discover supported models repeatedly.
- Recognize new versions and capability changes.
- Refresh benchmark evidence.
- Prevent stale or unqualified selection.

MILESTONE H: CONTINUOUS LEARNING
- Learn from real Ordra outcomes.
- Improve task-specific recommendations.
- Run controlled optimization experiments.
- Promote verified improvements safely.

MILESTONE I: FLEET AND PRODUCT EXPERIENCE
- Prepare dual-Mac evidence and deployment compatibility.
- Extend Cernum UI and Ordra Office visibility.
- Provide useful operational diagnostics and recovery documentation.

MILESTONE J: FINAL ACCEPTANCE
- Run complete end-to-end acceptance scenarios.
- Demonstrate the working system.
- Close every material gap.
- Produce the final V1 readiness report.

These milestones are conceptual planning categories, not automatic authorization for new goals or campaigns.

Create actual Ordra campaigns based on observed gaps and verified dependencies.

## 23. CONTINUOUS DEVELOPMENT EXPECTATIONS

The owner wants Cernum to make sustained progress rather than require a new instruction for every pass.

Whenever existing authorization permits:

- Continue eligible development.
- Dispatch through Ordra workers.
- Run verification.
- Record evidence.
- Recover ordinary failures.
- Advance to the next pass.
- Use independent worktrees where supported.
- Develop across multiple lanes concurrently when resources allow.
- Coordinate legitimate shared-resource requirements.
- Avoid idle time caused by unnecessary artificial dependencies.

Do not let a single missing dependency stall unrelated Cernum work.

Do not treat a supervisory Claude Code session as the durable scheduler.

All continuing work should exist in authoritative Ordra records and persistent execution mechanisms.

Do not claim work is progressing if it merely exists in a chat prompt.

If additional pass budgets or authority are needed, present a coherent group of decisions rather than repeatedly asking for tiny administrative choices.

Preserve approvals and never silently exceed them.

## 24. ACCEPTANCE CRITERIA FOR CERNUM V1

Cernum V1 should not be declared finished until we can demonstrate:

1. It can discover supported accessible models.
2. It can verify model identity.
3. It can execute meaningful qualification benchmarks.
4. It can preserve reproducible results.
5. It can enforce qualification thresholds.
6. It can classify real Ordra tasks.
7. It can recommend qualified models based on relevant evidence.
8. It can communicate recommendations to Ordra through a stable contract.
9. Ordra can actually launch the recommended model.
10. The actual model identity is verified.
11. At least one non-Opus worker completes a real verified task.
12. A failed or unavailable model produces a safe, policy-compliant fallback.
13. Routing outcomes are recorded for later learning.
14. Unsupported, expired, or unqualified configurations are excluded.
15. Operator visibility and diagnostics are available.
16. Verification, rollback, and recovery procedures are documented.
17. Production activation passes the existing safety and owner-approval gates.

Adaptive reasoning effort, continuous discovery, and learning must be included in the current roadmap and implemented through governed upgrades. Track their progress explicitly, even where initial V1 activation can be staged.

A completed benchmark product without actual Ordra execution integration is not the completed Cernum vision.

## 25. FINAL PRODUCT VISION

The finished experience should look like this:

The owner describes a software product or feature to Ordra.

Ordra breaks it into tasks.

Cernum evaluates each task and recommends the best qualified model, reasoning effort, and execution route.

Ordra dispatches the work across available authorized machines.

Independent development tasks execute concurrently.

Ordra verifies results and handles failures.

Cernum learns from verified successes and failures.

As better models become available, Cernum discovers, tests, and qualifies them.

As evidence improves, routing improves.

The owner sees meaningful progress, genuine blockers, and only the decisions that require owner authority.

The ecosystem becomes progressively more capable, efficient, reliable, and autonomous.

The owner should not need to spend every day managing model selections and individual technical recovery decisions.

That is the complete Cernum vision.

## 26. YOUR IMMEDIATE ASSIGNMENT

Now turn this manifesto into an actionable Ordra development program.

FIRST:

Read the relevant current Cernum repository, existing product documentation, live Ordra goal/campaign/pass records, current verification evidence, and existing integration contracts.

SECOND:

Save this manifesto as a durable version-controlled Cernum vision document in the appropriate project repository.

Do not overwrite or weaken existing binding engineering requirements. Identify any conflicts with prior specifications and present them explicitly.

THIRD:

Produce a capability-by-capability gap analysis showing:

- Desired capability
- Current implementation
- Verified evidence
- Missing components
- Dependencies
- Required integration work
- Estimated traditional passes
- Completion test

FOURTH:

Produce a prioritized full-completion development roadmap.

Include both the immediate V1 critical path and the larger adaptive-reasoning and self-improvement upgrades.

Estimate traditional pass counts, dependencies, risk, disk usage, and likely resource bottlenecks.

Provide schedule estimates as ranges based on measured worker and verification throughput, not unsupported promises.

FIFTH:

Determine which goals, campaigns, and passes are already authorized and executable.

Continue those immediately through Ordra's authoritative scheduler.

SIXTH:

Prepare the next governed campaign proposals for missing capabilities, reusing completed work and avoiding duplicate infrastructure.

SEVENTH:

Present a concise executive report with:

1. Current verified percentage of the total Cernum V1 acceptance criteria, explaining the measurement.
2. What is actually finished.
3. What remains incomplete.
4. The shortest path to the first non-Opus Ordra worker.
5. The shortest path to reliable automatic routing.
6. The additional path to adaptive reasoning effort.
7. The full path to continuous self-improvement.
8. Estimated remaining traditional passes.
9. Estimated elapsed development range based on current evidence.
10. The next three authorized actions.
11. Any actual owner approvals needed.

EIGHTH:

Continue all already-authorized development through Ordra without stopping merely because the report is complete.

Track completion against this manifesto, not just against individual campaign ceilings.

DO NOT STOP AT ANOTHER PARTIAL V1.

The objective is a functioning, fully integrated, independently verified Cernum system that delivers the complete intended experience.

Treat this document as the destination.

Treat the existing Ordra records as the authority for what work is currently permitted.

Use the evidence to determine the path from where we are to where we want to be.

Build toward that destination continuously.
