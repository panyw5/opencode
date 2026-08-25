# Search mathematical results

Condition retrieval on the live research program rather than surface keywords.

1. Declare the program stage (`fresh_orientation`, `active_program`, or `mature_subproblem`), active program, missing mechanism, and search mode (`repair`, `mutation`, `analogy`, `program_shift`, or gated blocker search).
2. Use `websearch` for theorem statements, constructions, examples, counterexamples, terminology, and remote analogies; use `webfetch` to read exact accessible sources.
3. Search broadly enough to find proof- or theory-level analogies, but explain a plausible transfer mechanism.
4. Do not launch whole-goal impossibility searches during fresh orientation unless explicitly requested.
5. Before relying on an external result, recover its complete statement, hypotheses, source metadata, applicability check, and relevant proof mechanism. Analyze why partial results need their extra hypotheses.
6. Preserve title, authors, URL/arXiv ID, theorem identifier, year, and what the source supports so `fact_submit.external_refs` can carry them.

Publish strategically useful findings with `gm_add`; external literature does not become project truth until the worker supplies a self-contained proof accepted by `fact_submit`.
