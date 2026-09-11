# Verify proof

The verifier behind `fact_submit` is the sole correctness authority.

## Notation contract

Facts are rendered as Markdown with KaTeX. Normalize every `statement`, `proof`, and `intuition` before submission:

- Use `$...$` for inline mathematics and `$$...$$` on standalone lines for display mathematics.
- Do not use `\(...\)` or `\[...\]` delimiters, and do not leave commands such as `\mathbb` or `\frac` in prose.
- Prefer standard commands with explicit braces: `\mathbb{C}`, `\operatorname{Spec}(A)`, `\frac{a}{b}`, `\subseteq`, and `\text{...}`.
- Use `aligned` inside `$$...$$` for multi-line equations. Balance braces, dollar delimiters, `\left/\right`, and every `\begin{...}/\end{...}` pair.
- Do not invent macros or mix raw Unicode/TeX fragments. Keep prose outside math and use normal Markdown code fences for code.
- Before calling `fact_submit`, reread the exact strings and check that the rendered Markdown will not expose literal LaTeX delimiters.

Submit the full target theorem and every sharply delimited intermediate result that downstream reasoning will use. Before submission, write an ugly-but-rigorous proof:

- self-contained using only declared predecessors and glossary;
- every symbol and parameter defined with explicit range;
- every quantifier explicit;
- every dependency cited by exact `fact_id`;
- no “obvious”, “routine”, chart-position reference, hidden computation, or appeal to memory;
- external references recorded as metadata, never substituted for proof;
- search first to avoid duplicate facts.

Call `fact_submit(statement, proof, predecessors, glossary_introduces, external_refs)`. Treat `wrong`, every critical error, every gap, unavailable verification, or write error as failure. Resolve all repair hints before resubmitting. An accepted `fact_id` is the only result that may be used downstream. If your intuition or guidance disagrees with the verifier, the verifier wins.
