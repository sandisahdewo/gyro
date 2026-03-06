# Brain - Improvements Roadmap

## Language Rewrite

Rewrite from bash to TypeScript. Bash is straining with JSON manipulation (~30 jq
subprocesses), file-based state simulation, and no structured error handling. TypeScript
gives native JSON, async parallelism, and shared types with the Kanban web app.

Suggested structure:

```
src/
  index.ts          # CLI entry point (replaces gyro.sh arg parsing)
  engine.ts         # Main loop (story iteration, retry logic)
  pipeline.ts       # Step runner, gate verification
  prd.ts            # PRD loading, story/pipeline queries (replaces all jq calls)
  checkpoint.ts     # Checkpoint runner with scoping
  agents/
    claude.ts       # Claude CLI wrapper
    codex.ts        # Codex CLI wrapper
  state.ts          # State management (replaces file-based state)
  progress.ts       # Event emitter for Kanban integration
  convert.ts        # Plan-to-PRD conversion (replaces plan-to-gyro.sh)
```

---

## Pipelines

### 1. Programmatic verify step

Currently the review step is an AI agent deciding SHIP/REVISE. No step actually runs
tests programmatically as a hard gate. The test_lock gates verify checksums and red/green
state, but the main pipeline relies on the AI worker to self-report test results.

Add a `verify` step type that runs a shell command (e.g. `npm test`) and gates on exit
code -- no AI involved. Cheaper, faster, deterministic.

```json
"pipelines": {
  "backend-tdd": {
    "steps": ["test", "work", "verify", "review"],
    "verify": { "cmd": "npm test", "timeout": 120 },
    "test_lock": { ... }
  }
}
```

The AI review then focuses only on code quality/acceptance criteria, not "did tests pass."

### 2. Selective retry (don't restart the whole pipeline)

On REVISE the entire pipeline restarts from step 1 (clear_completed_steps at gyro.sh:974).
If the test step wrote good tests but work failed review, tokens are wasted re-running test.

Allow retry from a specific step. The review feedback could include a retry_from hint:
- Gate failure after work -> retry from work only (tests are locked anyway)
- Review says code quality is bad -> retry from work
- Review says tests are wrong -> retry from test

### 3. Conditional steps

Some pipelines need steps only under certain conditions. For example, visual-verify only
makes sense if the story touches UI. A conditional step mechanism would be more flexible
than separate pipeline definitions:

```json
"steps": ["work", "review", { "step": "visual-verify", "if": "has_frontend_changes" }]
```

### 4. Per-story step overrides

Currently a story just picks a pipeline name. If one backend story needs an extra step
(e.g. migrate-db before test), you need a whole new pipeline. Allow stories to override
or prepend steps:

```json
{ "id": "story-03", "pipeline": "backend-tdd", "prepend_steps": ["migrate-db"] }
```

---

## Workflow

### 5. Progress reporting API [CRITICAL for Kanban integration]

gyro.sh writes to progress.txt and logs to stdout. The web app has no way to consume this.

Structured status events (JSON to stdout or a socket/webhook):

```json
{"event": "story_start", "story_id": "story-03", "attempt": 1, "timestamp": "..."}
{"event": "step_complete", "story_id": "story-03", "step": "work", "duration": 45}
{"event": "story_ship", "story_id": "story-03", "attempt": 2, "tokens": {...}}
{"event": "story_fail", "story_id": "story-03", "error": "max retries"}
```

A status file (state/status.json) the web app can poll, containing current story, step,
attempt, progress percentage, and token usage.

### 6. Story dependency graph

Stories currently run in linear priority order. Real projects have dependency trees --
story-05 might depend on story-02 and story-03, while story-04 is independent.

A depends_on field would let you:
- Validate the execution order at plan time
- Run independent stories in parallel (separate worktrees)
- Skip downstream stories if a dependency fails

```json
{ "id": "story-05", "depends_on": ["story-02", "story-03"] }
```

### 7. Parallel story execution

Independent stories (no dependency overlap) could run in parallel using git worktrees.
Each story already gets its own branch when work_branches: true. Two independent stories
touching different files could run simultaneously, cutting wall-clock time.

### 8. Story-level timeout

No timeout per story. A runaway AI agent could burn tokens indefinitely.

```json
{ "id": "story-03", "timeout": 600 }
```

Kill the step after N seconds.

### 9. Graceful pause/resume

Currently --from story-05 marks all prior stories as passed (whether they actually are
or not). A proper pause mechanism would:
- Write a state/pause-requested.txt flag
- The main loop checks it between stories and stops cleanly
- Resume picks up from state/current-story.txt without marking anything

---

## Checkpoints

### 10. Checkpoint dependencies and ordering

Checkpoints run independently. But lint should run before simplify (simplify shouldn't
be reformatting). Add ordering:

```json
"checkpoints": {
  "lint": { "after": "each", "standalone": true, "order": 1 },
  "simplify": { "after": ["story-05"], "order": 2 }
}
```

### 11. Checkpoint failure policy

If a non-standalone checkpoint maxes out retries, it logs a warning and continues
(gyro.sh:629). This is a silent swallow. Add configurable policy:

- "warn" -- current behavior (continue)
- "stop" -- halt the loop
- "skip" -- skip and record for the web app to surface

```json
{ "lint": { "on_fail": "stop" } }
```

### 12. Command-based checkpoints (no AI needed)

Allow arbitrary checkpoint types with a command-based runner. Some checkpoints don't
need an AI agent -- just a shell command with an exit code:

```json
"checkpoints": {
  "security-scan": {
    "cmd": "npm audit --audit-level=high",
    "on_fail": "stop",
    "after": "each"
  },
  "bundle-size": {
    "cmd": "node scripts/check-bundle-size.js",
    "on_fail": "warn",
    "on_complete": true
  }
}
```

### 13. Better checkpoint scope for after: "each"

When a checkpoint runs after every story, pass the story ID to the checkpoint prompt so
it knows exactly what was just built, not just "files changed since last tag."

---

## Priority

| Pri | #  | Improvement                    | Impact                        | Effort |
|-----|----|--------------------------------|-------------------------------|--------|
| 1   | 5  | Progress reporting API         | Critical for Kanban           | Medium |
| 2   | 1  | Programmatic verify step       | Saves tokens, real failures   | Small  |
| 3   | 2  | Selective retry                | Major token savings           | Small  |
| 4   | 8  | Story-level timeout            | Prevents runaway costs        | Small  |
| 5   | 6  | Dependency graph               | Enables parallel execution    | Medium |
| 6   | 9  | Graceful pause/resume          | Better UX                     | Small  |
| 7   | 11 | Checkpoint failure policy      | Prevents silent failures      | Small  |
| 8   | 7  | Parallel story execution       | Big speed improvement         | Large  |
| 9   | 12 | Command-based checkpoints      | Extensibility                 | Medium |
| 10  | 4  | Per-story step overrides       | Flexibility                   | Small  |
| 11  | 10 | Checkpoint ordering            | Correctness                   | Small  |
| 12  | 3  | Conditional steps              | Nice-to-have                  | Medium |
| 13  | 13 | Better checkpoint scope        | Polish                        | Small  |
