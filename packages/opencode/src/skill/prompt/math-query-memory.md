# Query Math Mode memory safely

1. Search the fact graph first for claims that may be cited. Record exact `fact_id` values.
2. Search global memory separately for plans, directions, obstacles, examples, counterexamples, dead ends, verification reports, and guidance.
3. Never cite global-memory entry IDs as proof dependencies.
4. Read only the top relevant matches, then inspect individual fact files or entries as needed; do not inject the whole store.
5. Check predecessor chains and revocation status before assigning a fact to a worker.
6. Convert a promising unverified idea into a precise worker TASK. Only the worker's verifier-accepted submission promotes it to truth.
