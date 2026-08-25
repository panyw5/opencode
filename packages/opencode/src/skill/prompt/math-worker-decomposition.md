# Propose subgoal decomposition plans

Use this after examples, counterexamples, retrieval, and failed attempts have constrained the target.

1. Gather verified facts separately from unverified findings.
2. Propose multiple materially different plans, not cosmetic reorderings.
3. For each plan state the main mechanism, ordered subgoals, plausible splice points, required verified facts, and which failures it avoids.
4. Make every subgoal sharply delimited enough for an independent worker round or `direct-proving` screen.
5. Do not mark a plan solved until every downstream building block has a `fact_id` and the dependency chain closes.

Publish each plan with `gm_add(kind="plan", verifiable=false)`, including its goal, ordered subgoals, motivation, information used, status, and branch identifier. Plans coordinate work but are never proof dependencies.
