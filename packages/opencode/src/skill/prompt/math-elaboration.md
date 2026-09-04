# Elaborate mathematical state

Maintain a compact five-part control artifact:

1. **Problem and targets** — exact statements still required.
2. **Definitions and glossary** — symbols and conventions, distinguishing verified definitions from proposed ones.
3. **Verified foundation** — only `fact_id` values and their predecessor relationships.
4. **Active decomposition** — worker session ID → assigned obligation, approach, and latest status.
5. **Open obligations** — verifier gaps, counterexamples, obstacles, dead ends, and the next control action.

Publish this artifact with `math_gm_add` as global-memory `elaboration` or `master_guidance`. Query shared state with `math_gm_search`, and ground the verified foundation with `math_fact_search`/`math_fact_get`. It coordinates the swarm but is never itself a proof brick. Keep it concise and replace stale strategy rather than copying full worker transcripts.
