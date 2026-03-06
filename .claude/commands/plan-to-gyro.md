Convert a plan file into Gyro Loop tasks (prd.json).

Read the plan file at: $ARGUMENTS

If no file path is given, look for plan.md or PLAN.md in the current directory.

Then read the existing .gyro/prd.json to understand the current format, pipelines, and any existing stories.

Also read AGENTS.md to understand the project's tech stack and conventions.

## Your Task

Convert the plan into Gyro Loop stories in .gyro/prd.json. Follow these rules:

### Story Decomposition
- Each story must be ONE cohesive unit of work completable in a single Claude context window
- A story should touch at most 3-4 files
- If a plan step is too large, split it into multiple stories
- Order stories by dependency — later stories can depend on earlier ones
- Group: setup first, then backend, then frontend, then polish

### Pipeline Assignment
Assign each story the correct pipeline based on what it does:
- `setup` — project initialization, config, scaffolding (simple array: `["work", "review"]`)
- `backend-tdd` — any backend endpoint, logic, or data layer work (object with test_lock — see format below)
- `frontend-e2e` — any UI component, page, or interaction (simple array: `["work", "review", "visual-verify"]`)
- `simplify` — only for checkpoint stories, never assign to feature stories

The `backend-tdd` pipeline MUST be an object (not an array):
```json
"backend-tdd": {
  "steps": ["test", "work", "review"],
  "test_lock": {
    "test_cmd": "<test command>",
    "file_pattern": "<test file glob>",
    "verify_red": true
  }
}
```

Set test_cmd and file_pattern based on the project's language:
- Go:         test_cmd = "go test ./...",   file_pattern = "*_test.go"
- TypeScript: test_cmd = "npm test",        file_pattern = "*.test.ts,*.spec.ts"
- JavaScript: test_cmd = "npm test",        file_pattern = "*.test.js,*.spec.js"
- Python:     test_cmd = "pytest",          file_pattern = "test_*.py,*_test.py"
- Rust:       test_cmd = "cargo test",      file_pattern = "*_test.rs"

Also ensure models config includes `"test": "claude:sonnet"`.

If the project has custom pipelines in prd.json, use those. If the plan mentions
work that doesn't fit existing pipelines, create a new pipeline and explain it.

### Acceptance Criteria Rules
Each criterion must be SPECIFIC and VERIFIABLE. The AI reviewer will check these
one-by-one, so vague criteria cause the loop to fail.

BAD:  "Validates input"
GOOD: "POST /items with empty name returns 400 with {error: 'name is required'}"

BAD:  "Shows items"
GOOD: "GET /items after creating 3 items returns 200 with array of length 3"

BAD:  "Looks good"
GOOD: "Form has text input with placeholder 'Item name' and button labeled 'Add'"

For backend-tdd stories:
- Do NOT use "Write test FIRST:" prefix — the separate test step handles TDD automatically
- Just describe WHAT to test and implement, not HOW to do TDD
- Always include "All prior tests still pass" as the last criterion

For frontend e2e stories, always include criteria like:
- "E2E test: [specific user action] → [specific expected result]"

### Checkpoint Placement
Add simplify checkpoints at natural boundaries:
- After all backend stories are done
- After all frontend stories are done
- on_complete: true (final cleanup pass)

### Output
Update .gyro/prd.json with the new stories. Preserve any existing stories that
have passes: true (already completed work). Replace stories with passes: false
if the plan has changed.

Show the user a summary table:
| ID | Title | Pipeline | Priority |
And note how many stories total, how many are backend vs frontend, and where
checkpoints will run.
