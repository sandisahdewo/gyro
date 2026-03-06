#!/bin/bash
set -euo pipefail

# ==============================================================================
# plan-to-gyro.sh — Convert a plan.md file into Gyro Loop prd.json
#
# Usage:
#   ./plan-to-gyro.sh plan.md                    # Convert plan.md
#   ./plan-to-gyro.sh plan.md --output prd.json  # Custom output path
#   ./plan-to-gyro.sh plan.md --preview          # Preview without writing
#   ./plan-to-gyro.sh plan.md --tech "Go+React"  # Specify tech stack
# ==============================================================================

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

log()  { echo -e "${CYAN}[plan-to-gyro]${NC} $1"; }
ok()   { echo -e "${GREEN}[plan-to-gyro]${NC} $1"; }
warn() { echo -e "${YELLOW}[plan-to-gyro]${NC} $1"; }
fail() { echo -e "${RED}[plan-to-gyro]${NC} $1"; exit 1; }

# === Parse Args ===
PLAN_FILE=""
OUTPUT_FILE=".gyro/prd.json"
PREVIEW=false
TECH_STACK=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --output)  OUTPUT_FILE="$2"; shift 2 ;;
    --preview) PREVIEW=true; shift ;;
    --tech)    TECH_STACK="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: ./plan-to-gyro.sh <plan-file> [options]"
      echo ""
      echo "Options:"
      echo "  --output <path>   Output path (default: .gyro/prd.json)"
      echo "  --preview         Preview the prd.json without writing"
      echo "  --tech <stack>    Tech stack hint (e.g., 'Go+React', 'Python+Vue')"
      echo "  --help            Show this help"
      exit 0
      ;;
    -*)        fail "Unknown option: $1" ;;
    *)         PLAN_FILE="$1"; shift ;;
  esac
done

# === Find plan file ===
if [ -z "$PLAN_FILE" ]; then
  if [ -f "plan.md" ]; then
    PLAN_FILE="plan.md"
  elif [ -f "PLAN.md" ]; then
    PLAN_FILE="PLAN.md"
  elif [ -f "IMPLEMENTATION_PLAN.md" ]; then
    PLAN_FILE="IMPLEMENTATION_PLAN.md"
  else
    fail "No plan file specified and no plan.md found. Usage: ./plan-to-gyro.sh <plan-file>"
  fi
fi

if [ ! -f "$PLAN_FILE" ]; then
  fail "Plan file not found: $PLAN_FILE"
fi

if ! command -v claude &> /dev/null; then
  fail "claude CLI not found. Install it first."
fi

log "Reading plan from: ${BOLD}$PLAN_FILE${NC}"

# === Read existing context ===
EXISTING_PRD=""
if [ -f ".gyro/prd.json" ]; then
  EXISTING_PRD=$(cat .gyro/prd.json)
  log "Found existing prd.json — will preserve completed stories"
fi

AGENTS_MD=""
if [ -f "AGENTS.md" ]; then
  AGENTS_MD=$(cat AGENTS.md)
  log "Found AGENTS.md — will use for tech stack context"
fi

PLAN_CONTENT=$(cat "$PLAN_FILE")

# === Build the conversion prompt ===
TECH_HINT=""
if [ -n "$TECH_STACK" ]; then
  TECH_HINT="The tech stack is: $TECH_STACK"
fi

CONVERSION_PROMPT=$(cat <<'PROMPT_EOF'
IMPORTANT: You are being used as a pure text converter. Do NOT use any tools.
Do NOT read files. Do NOT write files. Do NOT run commands.
Your ONLY job is to print raw JSON to stdout. Nothing else.

Convert the following implementation plan into a Gyro Loop prd.json file.

## Rules

### Story Decomposition
- Each story must be ONE cohesive unit of work completable in a single AI context window
- A story should touch at most 3-4 files
- If a plan step is too large, split it into multiple stories
- Order by dependency: setup → backend → frontend → polish
- Use sequential priority numbers starting from 1

### Pipeline Assignment
Assign pipelines based on story type:
- "setup" → simple array: ["work", "review"] — project init, config, scaffolding
- "backend-tdd" → object with test_lock (see format below) — API endpoints, logic, data layer (strict TDD)
- "frontend-e2e" → simple array: ["work", "review", "visual-verify"] — UI pages, components (e2e test)

The backend-tdd pipeline uses a 3-step flow: test → work → review.
A separate "test" agent writes failing tests FIRST, then the "work" agent implements code
to make them pass. The test_lock gate enforces this by checksumming test files.

DO NOT create stories with a "simplify" pipeline. Simplification is handled automatically
by the checkpoint system — never add simplify stories to the stories array.

### Detecting test_lock config from tech stack
Set test_cmd and file_pattern based on the project's language:
- Go:         test_cmd = "go test ./...",   file_pattern = "*_test.go"
- TypeScript: test_cmd = "npm test",        file_pattern = "*.test.ts,*.spec.ts"
- JavaScript: test_cmd = "npm test",        file_pattern = "*.test.js,*.spec.js"
- Python:     test_cmd = "pytest",          file_pattern = "test_*.py,*_test.py"
- Rust:       test_cmd = "cargo test",      file_pattern = "*_test.rs"
- Other:      infer from AGENTS.md, package.json, Makefile, or similar project config

### Acceptance Criteria
MUST be specific and machine-verifiable. Each criterion is checked by an AI reviewer.
Keep criteria TERSE — verifiable assertions only, not implementation detail.
The AI worker already has access to the plan file for full context.

Examples of GOOD criteria:
- "POST /items with {name:'X'} returns 201 with {id, name, createdAt}"
- "Empty name returns 400 with {error: 'name is required'}"
- "All prior tests still pass"
- "E2E test: type 'Buy milk', click Add, verify 'Buy milk' appears in list"
- "Form has input with placeholder 'Item name' and button labeled 'Add'"

For backend-tdd stories:
- Do NOT use "Write test FIRST:" prefix — the test step handles this automatically
- Just describe WHAT to test and implement, not HOW to do TDD
- Always include "All prior tests still pass" as the last criterion

For frontend-e2e stories, always include:
- UI description criteria
- "E2E test: [action] → [expected result]"

### plan_ref Field
When a story maps to a specific section of the plan, add a "plan_ref" field with a short
pointer like "Step 3: HTML template with HTMX". This tells the AI worker where to look
in the plan file for full implementation detail — saves tokens vs duplicating that detail
into acceptance criteria.

### Checkpoints
Configure simplify checkpoints (these run automatically, NOT as stories):
- After the last backend story
- After the last frontend story
- "on_complete": true

### Output Format
CRITICAL: Your entire response must be ONLY the raw JSON object.
- No markdown code fences (no ```)
- No explanation before or after
- No "here is the JSON" preamble
- No tool calls — just print the JSON directly
- Start your response with { and end with }
The JSON must match this structure exactly:

{
  "project": "project-name",
  "models": {
    "test": "claude:sonnet",
    "work": "codex:gpt-5.3-codex",
    "review": "claude:opus",
    "simplify": "claude:sonnet",
    "visual-verify": "claude:haiku"
  },
  "pipelines": {
    "setup": ["work", "review"],
    "backend-tdd": {
      "steps": ["test", "work", "review"],
      "test_lock": {
        "test_cmd": "<test command for this language>",
        "file_pattern": "<test file glob for this language>",
        "verify_red": true
      }
    },
    "frontend-e2e": ["work", "review", "visual-verify"]
  },
  "checkpoints": {
    "simplify": {
      "after": ["last-backend-story-id", "last-frontend-story-id"],
      "on_complete": true
    }
  },
  "stories": [
    {
      "id": "story-01",
      "title": "Short imperative title",
      "pipeline": "pipeline-name",
      "plan_ref": "Step N: section name (if applicable)",
      "acceptance_criteria": ["specific criterion 1", "specific criterion 2"],
      "passes": false,
      "priority": 1
    }
  ]
}

IMPORTANT: The "backend-tdd" pipeline MUST be an object with "steps" and "test_lock",
NOT a simple array. The test_lock.test_cmd and test_lock.file_pattern must match the
project's language/framework.
PROMPT_EOF
)

# === Compose the full prompt ===
FULL_PROMPT="$CONVERSION_PROMPT

$TECH_HINT

## Plan to Convert

$PLAN_CONTENT"

if [ -n "$AGENTS_MD" ]; then
  FULL_PROMPT="$FULL_PROMPT

## Project Context (AGENTS.md)

$AGENTS_MD"
fi

if [ -n "$EXISTING_PRD" ]; then
  FULL_PROMPT="$FULL_PROMPT

## Existing prd.json (preserve stories where passes: true)

$EXISTING_PRD"
fi

# === Run conversion ===
log "Converting plan to Gyro tasks..."

# Detect if running inside Claude Code (nested sessions not allowed)
if [ -n "${CLAUDECODE:-}" ]; then
  fail "Cannot run inside Claude Code session (nested sessions not supported).\n\n  Run from a regular terminal instead:\n    ${CYAN}./plan-to-gyro.sh $PLAN_FILE${NC}\n\n  Or use the slash command inside Claude Code:\n    ${CYAN}/plan-to-gyro $PLAN_FILE${NC}"
fi

# --max-turns 1: single response only (no tool use loops)
RESULT=$(echo "$FULL_PROMPT" | claude -p --max-turns 1 2>/dev/null)

# === Extract JSON from response ===
# Claude might wrap output in code fences or add preamble text.
# Strategy: find the first { and last }, extract everything between.
CLEAN_JSON=$(echo "$RESULT" | sed '/^```/d' | sed '/^json$/d')

# If the cleaned text isn't valid JSON, try extracting the JSON object
if ! echo "$CLEAN_JSON" | jq . > /dev/null 2>&1; then
  # Extract from first { to last }
  CLEAN_JSON=$(echo "$RESULT" | sed -n '/^{/,/^}/p')
fi

# Still not valid? Try aggressive extraction — find JSON anywhere in the output
if ! echo "$CLEAN_JSON" | jq . > /dev/null 2>&1; then
  CLEAN_JSON=$(echo "$RESULT" | grep -Pzo '(?s)\{.*\}' | tr -d '\0' || true)
fi

# Final validation
if ! echo "$CLEAN_JSON" | jq . > /dev/null 2>&1; then
  echo ""
  fail "Claude returned invalid JSON. Raw output:\n\n$RESULT"
fi

# === Validate structure ===
STORY_COUNT=$(echo "$CLEAN_JSON" | jq '.stories | length')
HAS_PIPELINES=$(echo "$CLEAN_JSON" | jq 'has("pipelines")')
HAS_STORIES=$(echo "$CLEAN_JSON" | jq 'has("stories")')

if [ "$HAS_PIPELINES" != "true" ] || [ "$HAS_STORIES" != "true" ]; then
  fail "Invalid prd.json structure — missing pipelines or stories"
fi

if [ "$STORY_COUNT" -eq 0 ]; then
  fail "No stories generated"
fi

# === Count by type ===
SETUP_COUNT=$(echo "$CLEAN_JSON" | jq '[.stories[] | select(.pipeline == "setup")] | length')
BACKEND_COUNT=$(echo "$CLEAN_JSON" | jq '[.stories[] | select(.pipeline == "backend-tdd")] | length')
FRONTEND_COUNT=$(echo "$CLEAN_JSON" | jq '[.stories[] | select(.pipeline == "frontend-e2e")] | length')
SIMPLIFY_STORIES=$(echo "$CLEAN_JSON" | jq '[.stories[] | select(.pipeline == "simplify")] | length')
OTHER_COUNT=$(echo "$CLEAN_JSON" | jq "[.stories[] | select(.pipeline != \"setup\" and .pipeline != \"backend-tdd\" and .pipeline != \"frontend-e2e\" and .pipeline != \"simplify\")] | length")

if [ "$SIMPLIFY_STORIES" -gt 0 ]; then
  warn "⚠ Found $SIMPLIFY_STORIES simplify stories — these should be checkpoints, not stories. Removing them..."
  CLEAN_JSON=$(echo "$CLEAN_JSON" | jq 'del(.stories[] | select(.pipeline == "simplify"))')
  # Renumber priorities
  CLEAN_JSON=$(echo "$CLEAN_JSON" | jq '.stories |= [to_entries[] | .value.priority = (.key + 1) | .value]')
  STORY_COUNT=$(echo "$CLEAN_JSON" | jq '.stories | length')
  SETUP_COUNT=$(echo "$CLEAN_JSON" | jq '[.stories[] | select(.pipeline == "setup")] | length')
  BACKEND_COUNT=$(echo "$CLEAN_JSON" | jq '[.stories[] | select(.pipeline == "backend-tdd")] | length')
  FRONTEND_COUNT=$(echo "$CLEAN_JSON" | jq '[.stories[] | select(.pipeline == "frontend-e2e")] | length')
  OTHER_COUNT=$(echo "$CLEAN_JSON" | jq "[.stories[] | select(.pipeline != \"setup\" and .pipeline != \"backend-tdd\" and .pipeline != \"frontend-e2e\")] | length")
fi

# === Fix backend-tdd pipeline if generated as array (old format) ===
BACKEND_TDD_TYPE=$(echo "$CLEAN_JSON" | jq -r '.pipelines["backend-tdd"] | type' 2>/dev/null)
if [ "$BACKEND_TDD_TYPE" = "array" ] && [ "$BACKEND_COUNT" -gt 0 ]; then
  warn "⚠ backend-tdd pipeline generated as array — converting to object with test_lock"

  # Try to detect test_cmd and file_pattern from tech stack hint or AGENTS.md
  DETECTED_TEST_CMD="go test ./..."
  DETECTED_FILE_PATTERN="*_test.go"

  if [ -n "$TECH_STACK" ]; then
    case "$TECH_STACK" in
      *[Tt]ype[Ss]cript*|*[Tt][Ss]*)
        DETECTED_TEST_CMD="npm test"
        DETECTED_FILE_PATTERN="*.test.ts,*.spec.ts" ;;
      *[Jj]ava[Ss]cript*|*[Jj][Ss]*)
        DETECTED_TEST_CMD="npm test"
        DETECTED_FILE_PATTERN="*.test.js,*.spec.js" ;;
      *[Pp]ython*)
        DETECTED_TEST_CMD="pytest"
        DETECTED_FILE_PATTERN="test_*.py,*_test.py" ;;
      *[Rr]ust*)
        DETECTED_TEST_CMD="cargo test"
        DETECTED_FILE_PATTERN="*_test.rs" ;;
    esac
  fi

  CLEAN_JSON=$(echo "$CLEAN_JSON" | jq \
    --arg tc "$DETECTED_TEST_CMD" \
    --arg fp "$DETECTED_FILE_PATTERN" \
    '.pipelines["backend-tdd"] = {
      "steps": ["test", "work", "review"],
      "test_lock": {
        "test_cmd": $tc,
        "file_pattern": $fp,
        "verify_red": true
      }
    }')

  # Ensure "test" model exists
  if [ "$(echo "$CLEAN_JSON" | jq 'has("models") and (.models | has("test"))')" != "true" ]; then
    CLEAN_JSON=$(echo "$CLEAN_JSON" | jq '.models.test = "claude:sonnet"')
  fi

  ok "Fixed: backend-tdd → test → work → review [test-lock: $DETECTED_TEST_CMD]"
fi

# === Validate backend-tdd has test_lock ===
if [ "$BACKEND_COUNT" -gt 0 ]; then
  HAS_TEST_LOCK=$(echo "$CLEAN_JSON" | jq '.pipelines["backend-tdd"].test_lock != null' 2>/dev/null)
  if [ "$HAS_TEST_LOCK" != "true" ]; then
    warn "⚠ backend-tdd pipeline is missing test_lock config"
  fi
fi

CHECKPOINT_AFTER=$(echo "$CLEAN_JSON" | jq -r '.checkpoints.simplify.after // [] | join(", ")' 2>/dev/null)
ON_COMPLETE=$(echo "$CLEAN_JSON" | jq -r '.checkpoints.simplify.on_complete // false' 2>/dev/null)

# === Test-lock info ===
TEST_LOCK_CMD=$(echo "$CLEAN_JSON" | jq -r '.pipelines["backend-tdd"].test_lock.test_cmd // empty' 2>/dev/null)
TEST_LOCK_PATTERN=$(echo "$CLEAN_JSON" | jq -r '.pipelines["backend-tdd"].test_lock.file_pattern // empty' 2>/dev/null)

# === Summary ===
echo ""
echo -e "${BOLD}Conversion Summary${NC}"
echo -e "──────────────────────────────────────"
echo -e "  Total stories:  ${BOLD}$STORY_COUNT${NC}"
echo -e "  Setup:          $SETUP_COUNT"
echo -e "  Backend (TDD):  $BACKEND_COUNT"
echo -e "  Frontend (E2E): $FRONTEND_COUNT"
[ "$OTHER_COUNT" -gt 0 ] && echo -e "  Other:          $OTHER_COUNT"
echo -e ""
if [ -n "$TEST_LOCK_CMD" ]; then
  echo -e "  Test lock:         ${BOLD}enabled${NC}"
  echo -e "    test_cmd:        $TEST_LOCK_CMD"
  echo -e "    file_pattern:    $TEST_LOCK_PATTERN"
  echo -e "    pipeline:        test → work → review"
fi
echo -e ""
[ -n "$CHECKPOINT_AFTER" ] && echo -e "  Checkpoints after: $CHECKPOINT_AFTER"
echo -e "  Final checkpoint:  $ON_COMPLETE"
echo -e "──────────────────────────────────────"
echo ""

# === Show story table ===
echo -e "${BOLD}Stories:${NC}"
echo ""
printf "  %-12s %-45s %-15s %s\n" "ID" "TITLE" "PIPELINE" "PRI"
printf "  %-12s %-45s %-15s %s\n" "──────────" "─────────────────────────────────────────" "─────────────" "───"

echo "$CLEAN_JSON" | jq -r '.stories[] | "\(.id)|\(.title)|\(.pipeline)|\(.priority)"' | while IFS='|' read -r id title pipeline priority; do
  # Truncate long titles
  if [ ${#title} -gt 43 ]; then
    title="${title:0:40}..."
  fi
  printf "  %-12s %-45s %-15s %s\n" "$id" "$title" "$pipeline" "$priority"
done

echo ""

# === Write or preview ===
if [ "$PREVIEW" = true ]; then
  log "Preview mode — not writing to disk"
  echo -e "${BOLD}Generated prd.json:${NC}"
  echo "$CLEAN_JSON" | jq .
else
  mkdir -p "$(dirname "$OUTPUT_FILE")"
  echo "$CLEAN_JSON" | jq . > "$OUTPUT_FILE"
  ok "Written to ${BOLD}$OUTPUT_FILE${NC}"
  echo ""
  echo -e "  Next steps:"
  echo -e "    ${CYAN}./gyro.sh --dry-run${NC}    # Review the execution plan"
  echo -e "    ${CYAN}./gyro.sh${NC}              # Run it"
fi
