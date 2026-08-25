# Obtain immediate conclusions

Before speculative proof search:

1. Normalize notation and restate the target in equivalent forms.
2. Derive cheap consequences from definitions, algebra, and logic.
3. Separate necessary conditions from candidate sufficient conditions.
4. For each conclusion, state its derivation and whether it is fragile.
5. Stress-test fragile conclusions with `construct-counterexamples`.

Publish useful conclusions with `gm_add(kind="conclusion")`, including the statement, justification type, confidence, scope, fragility reason, and suggested follow-up. This publication shares awareness only. If another proof step will depend on a conclusion, turn it into a self-contained claim and pass it through `fact_submit` first.
