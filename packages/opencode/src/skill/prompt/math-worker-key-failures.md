# Identify key failures

Turn a batch of failed plans into reusable guidance.

1. Gather each plan's exact stuck points, failed proof migrations, counterexamples, and verifier gaps.
2. Separate local mistakes from recurring structural obstructions.
3. Identify decomposition patterns that repeatedly fail and missing mechanisms that deserve retrieval or a program shift.
4. State what the next generation of plans must avoid or supply.
5. Preserve useful negative knowledge without claiming a theorem-level impossibility unless it has been proved and verified.

Publish the synthesis with `gm_add(kind="dead_end")`, including failed plan IDs, per-plan stuck points, common failures, and implications for the next plans. This guides siblings but is not a verified obstruction fact.
