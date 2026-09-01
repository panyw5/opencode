# Verify proof

The verifier behind `fact_submit` is the sole correctness authority.

Submit the full target theorem and every sharply delimited intermediate result that downstream reasoning will use. Before submission, write an ugly-but-rigorous proof:

- self-contained using only declared predecessors and glossary;
- every symbol and parameter defined with explicit range;
- every quantifier explicit;
- every dependency cited by exact `fact_id`;
- no “obvious”, “routine”, chart-position reference, hidden computation, or appeal to memory;
- external references recorded as metadata, never substituted for proof;
- search first to avoid duplicate facts.

Call `fact_submit(statement, proof, predecessors, glossary_introduces, external_refs)`. Treat `wrong`, every critical error, every gap, unavailable verification, or write error as failure. Resolve all repair hints before resubmitting. An accepted `fact_id` is the only result that may be used downstream. If your intuition or guidance disagrees with the verifier, the verifier wins.
