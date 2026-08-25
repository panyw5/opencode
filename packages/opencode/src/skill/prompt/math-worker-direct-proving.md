# Direct proving

Screen one decomposition plan by attempting the full chain before diagnosing failure.

1. Query relevant verified facts, examples, counterexamples, dead ends, and references.
2. Attempt each subgoal directly and record `solved`, `partial`, or `stuck`.
3. Adapt useful proof mechanisms rather than citing vaguely. If a source theorem has extra hypotheses, explain exactly where its proof needs them.
4. For a stuck subgoal, run a genuine counterexample search before assuming it is merely difficult.
5. After two materially different failed attempts, publish the precise obstacle/dead end instead of grinding.
6. Immediately submit every self-contained intermediate result that downstream steps will use. Never build on an unverified partial proof.
7. Assemble the full proof only from accepted `fact_id` dependencies.

Publish attempts with `gm_add(kind="proof_attempt")`; publish plan-local failures as `dead_end`. Use `fact_submit` for solved lemmas and the final theorem.
