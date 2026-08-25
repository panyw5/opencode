# Construct counterexamples

Actively try to falsify fragile conjectures and intermediate claims.

1. List the assumptions that must remain true and the conclusion that must fail.
2. Search standard edge cases, degenerate objects, boundary regimes, and known pathological families using reasoning and, when useful, `websearch` / `webfetch`.
3. Classify the result as `refuted`, `not_refuted`, or `inconclusive`.
4. Check a concrete refutation line by line; absence of a counterexample is never a proof.
5. Record branches invalidated by a genuine counterexample.

Publish the result with `gm_add(kind="counterexample")`. If it kills a branch, also publish a concise `dead_end`. If the construction is informative but not refuting, publish it as an `example`. These entries remain hypotheses/awareness until a self-contained mathematical claim is accepted by `fact_submit`.
