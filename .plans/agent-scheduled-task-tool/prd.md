# Agent Scheduled Task Tool

## Goal

Expose the desktop app's scheduled task creation capability as a built-in agent tool.

## API Contract

- Tool ID: `scheduled_task_create`
- Required input: `name`, `prompt`, `schedule`
- Optional input: `executionMode`, `enabled`
- Schedule variants:
  - `{ kind: "at", at: <unix timestamp in milliseconds> }`
  - `{ kind: "every", interval: <positive milliseconds> }`
  - `{ kind: "cron", expression: <five-field cron>, timezone?: <IANA timezone> }`
- Runtime-owned fields: `projectID`, `projectName`, `directory`, `sessionID`, `agent`, `model`, `unattended`
- Output: the same scheduled task object returned by the existing create API
- Permission: `scheduled_task_create`

## Requirements

- Reuse the existing scheduled task repository and event behavior.
- Derive project, directory, session, agent, and model from the active tool context.
- Bind `existing_session` tasks to the current session; omit the session for `new_session` tasks.
- Make the tool visible through `ToolRegistry` for normal agent prompts.
- Keep the scheduler execution service out of the tool registry dependency graph.
- Log tool registration and create execution for diagnosis and production troubleshooting.

## Validation Matrix

| Case | Input | Expected result |
| --- | --- | --- |
| Good | Future `at` timestamp | Enabled task created for the current project/session |
| Good | Positive `every` interval | Recurring task created |
| Good | Valid cron and IANA timezone | Cron task created |
| Bad | Empty name or prompt | Tool argument validation fails |
| Bad | Zero/negative interval | Tool argument validation fails |
| Bad | Invalid cron or timezone | Creation fails without inserting a task |
| Bad | Permission denied | No task is inserted |
| Base | Omitted execution mode | Defaults to `existing_session` and binds current session |

## Acceptance Criteria

- [x] `scheduled_task_create` appears in the built-in registry and model tool set.
- [x] A tool invocation persists a task with the active project/session/model context.
- [x] The scheduled-task created event is emitted as it is for HTTP API creation.
- [x] Invalid schedules do not persist records.
- [x] Targeted tests and package typecheck pass.
- [ ] A real agent invocation creates a task that is observable through the scheduled task API.
