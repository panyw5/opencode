# Initialize a Math Mode swarm

1. Maximize your reasoning capability, identify the mathematical problem, decompose the problem into achievable subproblems for workers, and devise a tasking strategy.
   Make sure you understand the definitions, notations; ASK the user to clarify if you don't
2. Initialize the problem with its problem ID `<problem-id>` and isolated workspace under `.math/problems/<problem-id>`. NEVER reuse another problem's store: CROSS-PROBLEM contamination is a serious RISK.

3. **Before dispatching any worker**:
   1. Use `PROBLEM.md`: persist the complete problem statement into `PROBLEM.md` in the problem workspace: explicit definitions, formula, notation, and constant convention the user gave, verbatim.
   2. `PROBLEM.md` is workers' only copy of the problem. Never rely on a TASK phrase like "the given definition" — the worker cannot see it.
   3. Do not write `@file` pointer references in `PROBLEM.md`: `math_worker_start` will fail
   4. Use `references`: Standalone reference files must be staged with the `references` parameter so they are copied into the problem workspace
4. Call `math_worker_status` before creating anything. Returned child session IDs are durable worker identities.
5. Reconnect to existing transcripts.
   1. If a worker is dead and `restartable=true`, call `math_worker_ensure` with that session ID.
   2. If a worker is content-blocked, inspect its report and shared memory, call `math_worker_task_update` with a substantively revised TASK, then call `math_worker_ensure` with the same session ID.
   3. NEVER replace worker with a new worker UNLESS its workstream is intentionally retired.
6. Use `math_worker_start` ONLY for genuinely NEW evidence workstreams.
7. Write precise, non-overlapping, **self-contained** TASK bodies: each round a worker receives only `PROBLEM.md`, its own TASK file, and the shared stores, so a TASK must carry every definition and convention its proof route needs (or name the `PROBLEM.md`/`fact_id` that carries them)

8. Record shared strategy with `math_gm_add(kind="master_guidance")`, restating the fixed notation and conventions from `PROBLEM.md` that all workers must honor; it is not a proof fact.

## Optional 30-minute control beat

When ongoing autonomous coordination is desired, create one scheduled task in `existing_session` mode with interval `1800000` ms. Its prompt should tell the orchestrator to load `math-elaboration`, reconcile `math_worker_status`, call `math_worker_ensure` only for unexpectedly dead restartable workers, inspect new verified facts with `math_fact_search`/`math_fact_get`, inspect verification gaps with `math_gm_search`, and update `master_guidance` with `math_gm_add`. Never use the scheduled task as a worker host.

Never create a duplicate beat without listing existing scheduled tasks first.
