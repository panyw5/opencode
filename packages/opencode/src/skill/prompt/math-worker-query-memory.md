# Query memory before proving

Use the three durable sources in this order:

1. Review this worker session's prior transcript for its own attempts.
2. Use `gm_search` with a narrow query and selected kinds to find shared plans, examples, counterexamples, obstacles, dead ends, guidance, and verifier feedback.
3. Use `fact_search` to find verified statements. Call `fact_get` on relevant hits to read the complete fact, then cite its exact `fact_id` as a predecessor.

Verified facts are the only proof bricks. Global-memory entries and prior prose are hypotheses even when they look rigorous. Re-derive and submit anything you intend to use downstream. Stay inside the current workspace and shared Math Mode store; never inspect another worker's private files. Do not republish recalled findings merely to duplicate them.
