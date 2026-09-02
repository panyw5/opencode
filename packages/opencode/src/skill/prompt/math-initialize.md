# Initialize a Math Mode swarm

1. Identify the current mathematical problem and its target obligations. Every initialization must use its own problem ID and isolated workspace under `.math/problems/<problem-id>`; never reuse another problem's store. **Before dispatching any worker**, persist the complete problem statement into `PROBLEM.md` in the problem workspace — every definition, formula, notation, and constant convention the operator gave, verbatim. Workers cannot read this session, the parent files, or anything outside the problem workspace: `PROBLEM.md` is their only copy of the problem. Never rely on a TASK phrase like "the given definition" — the worker cannot see it.
2. Call `math_worker_status` before creating anything. Treat returned child session IDs as durable worker identities.
3. Reconnect to existing transcripts. If a worker is dead and `restartable=true`, call `math_worker_ensure` with that session ID. Never replace it with a new worker unless its workstream is intentionally retired.
4. Ask for or choose a bounded roster only when no existing roster covers the obligations.
   The recommended default is seven independent workers: three with variant `high` and four with variant `xhigh`. Present this roster for human confirmation; do not silently launch it. Variants are model effort levels, never nested-agent depth.
5. Write precise, non-overlapping, **self-contained** TASK bodies: each round a worker receives only `PROBLEM.md`, its own TASK file, and the shared stores, so a TASK must carry every definition, notation, and convention its proof route needs (or name the `PROBLEM.md`/`fact_id` that carries them). Use `math_worker_start` only for genuinely new evidence workstreams.
6. Record shared strategy as `master_guidance`, restating the fixed notation and conventions from `PROBLEM.md` that all workers must honor; it is not a proof fact.
7. Confirm the orchestrator cannot see or invoke `fact_submit`.

## Optional 30-minute control beat

When ongoing autonomous coordination is desired, create one scheduled task in `existing_session` mode with interval `1800000` ms. Its prompt should tell the orchestrator to load `math-elaboration`, reconcile `math_worker_status`, call `math_worker_ensure` only for unexpectedly dead restartable workers, inspect new verified facts and verification gaps, and update `master_guidance`. Never use the scheduled task as a worker host, and never create a duplicate beat without listing existing scheduled tasks first.
