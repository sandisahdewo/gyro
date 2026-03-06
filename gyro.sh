#!/bin/bash
set -euo pipefail

# ==============================================================================
# gyro.sh — Gyro Loop orchestrator with per-story pipelines and checkpoints
#
# Usage:
#   ./gyro.sh                     # Run all stories
#   ./gyro.sh --dry-run           # Show execution plan without running
#   ./gyro.sh --from story-05     # Resume from a specific story
#   ./gyro.sh --plan              # Run planning mode (gap analysis)
# ==============================================================================

# === Config ===
MAX_STORY_RETRIES=${GYRO_MAX_RETRIES:-5}
BASE_BRANCH="${GYRO_BASE_BRANCH:-main}"
STATE_DIR=".gyro/state"
PROMPT_DIR=".gyro/prompts"
PRD=".gyro/prd.json"
PROGRESS=".gyro/progress.txt"
GYRO_LOG=".gyro/gyro.log"

# === Token Usage Tracking ===
TOTAL_INPUT_TOKENS=0
TOTAL_OUTPUT_TOKENS=0
TOTAL_CACHE_READ=0
STORY_INPUT_TOKENS=0
STORY_OUTPUT_TOKENS=0

# Default AI agent — used when models field has no "agent:" prefix
# Set to "claude", "codex", or "auto" (tries claude first, then codex)
GYRO_DEFAULT_AGENT="${GYRO_DEFAULT_AGENT:-auto}"

# === Colors ===
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# === Logging ===
log()  { echo -e "${CYAN}[gyro]${NC} $1"; echo "[$(date -Iseconds)] $1" >> "$GYRO_LOG"; }
ok()   { echo -e "${GREEN}[gyro] ✓${NC} $1"; echo "[$(date -Iseconds)] OK: $1" >> "$GYRO_LOG"; }
warn() { echo -e "${YELLOW}[gyro] !${NC} $1"; echo "[$(date -Iseconds)] WARN: $1" >> "$GYRO_LOG"; }
fail() { echo -e "${RED}[gyro] ✗${NC} $1"; echo "[$(date -Iseconds)] FAIL: $1" >> "$GYRO_LOG"; }
hr()   { echo -e "${DIM}$(printf '%.0s─' {1..60})${NC}"; }

# === Step Checkpointing ===
is_step_completed() {
  local story_id="$1" step="$2"
  local file="$STATE_DIR/completed-steps-${story_id}.txt"
  [ -f "$file" ] && grep -qxF "$step" "$file"
}

mark_step_completed() {
  local story_id="$1" step="$2"
  echo "$step" >> "$STATE_DIR/completed-steps-${story_id}.txt"
}

clear_completed_steps() {
  local story_id="$1"
  rm -f "$STATE_DIR/completed-steps-${story_id}.txt"
}

# === Duration Formatting ===
format_duration() {
  local seconds="$1"
  if [ "$seconds" -lt 60 ]; then
    echo "${seconds}s"
  else
    local mins=$((seconds / 60))
    local secs=$((seconds % 60))
    echo "${mins}m ${secs}s"
  fi
}

# === Token Formatting ===
format_tokens() {
  local tokens="$1"
  if [ "$tokens" -ge 1000000 ]; then
    awk "BEGIN {printf \"%.1fM\", $tokens/1000000}"
  elif [ "$tokens" -ge 1000 ]; then
    awk "BEGIN {printf \"%.1fk\", $tokens/1000}"
  else
    echo "$tokens"
  fi
}

# === Usage Parsing ===
parse_step_usage() {
  local step_log="$1" step_name="$2" agent="$3"

  [ "$agent" != "claude" ] && return 0
  [ ! -f "$step_log" ] && return 0

  # Try parsing as JSON with usage field
  if ! jq -e '.usage' "$step_log" > /dev/null 2>&1; then
    return 0
  fi

  local input_tokens output_tokens cache_read num_turns
  input_tokens=$(jq -r '.usage.input_tokens // 0' "$step_log")
  output_tokens=$(jq -r '.usage.output_tokens // 0' "$step_log")
  cache_read=$(jq -r '.usage.cache_read_input_tokens // 0' "$step_log")
  num_turns=$(jq -r '.num_turns // 0' "$step_log")

  # Accumulate totals
  TOTAL_INPUT_TOKENS=$((TOTAL_INPUT_TOKENS + input_tokens))
  TOTAL_OUTPUT_TOKENS=$((TOTAL_OUTPUT_TOKENS + output_tokens))
  TOTAL_CACHE_READ=$((TOTAL_CACHE_READ + ${cache_read:-0}))
  STORY_INPUT_TOKENS=$((STORY_INPUT_TOKENS + input_tokens))
  STORY_OUTPUT_TOKENS=$((STORY_OUTPUT_TOKENS + output_tokens))

  local total=$((input_tokens + output_tokens))
  log "  ${DIM}[${step_name}] $(format_tokens $input_tokens) in / $(format_tokens $output_tokens) out ($(format_tokens $total) total) | ${num_turns} turns${NC}"
}

show_usage_summary() {
  local label="$1" in_tok="$2" out_tok="$3"
  local total=$((in_tok + out_tok))
  log "${DIM}${label}: $(format_tokens $in_tok) in / $(format_tokens $out_tok) out ($(format_tokens $total) total)${NC}"
}

# === PRD Helpers ===
get_next_story() {
  jq -r '
    .stories
    | sort_by(.priority)
    | map(select(.passes == false))
    | first
    | .id // empty
  ' "$PRD"
}

get_story_field() {
  local story_id="$1" field="$2"
  jq -r --arg id "$story_id" --arg f "$field" \
    '.stories[] | select(.id == $id) | .[$f]' "$PRD"
}

get_pipeline_steps() {
  local story_id="$1"
  local pipeline
  pipeline=$(get_story_field "$story_id" "pipeline")
  local ptype
  ptype=$(jq -r --arg p "$pipeline" '.pipelines[$p] | type' "$PRD")
  if [ "$ptype" = "array" ]; then
    jq -r --arg p "$pipeline" '.pipelines[$p][]' "$PRD"
  else
    jq -r --arg p "$pipeline" '.pipelines[$p].steps[]' "$PRD"
  fi
}

get_pipeline_field() {
  local story_id="$1" field="$2"
  local pipeline
  pipeline=$(get_story_field "$story_id" "pipeline")
  jq -r --arg p "$pipeline" --arg f "$field" '.pipelines[$p][$f] // empty' "$PRD" 2>/dev/null
}

has_test_lock() {
  local story_id="$1"
  local pipeline
  pipeline=$(get_story_field "$story_id" "pipeline")
  jq -e --arg p "$pipeline" '.pipelines[$p].test_lock // empty' "$PRD" > /dev/null 2>&1
}

get_test_lock_field() {
  local story_id="$1" field="$2"
  local pipeline
  pipeline=$(get_story_field "$story_id" "pipeline")
  jq -r --arg p "$pipeline" --arg f "$field" '.pipelines[$p].test_lock[$f] // empty' "$PRD"
}

# === Test-Lock Gates ===
#
# Gates enforce TDD discipline between pipeline steps:
#   after "test" step  → snapshot test files + verify they FAIL (red phase)
#   after "work" step  → verify test files unchanged (test lock)
#

# Build find args for test file patterns (supports comma-separated patterns)
# e.g. "*.test.ts,*.spec.ts" → -name "*.test.ts" -o -name "*.spec.ts"
find_test_files() {
  local file_pattern="$1"
  local find_args=()

  IFS=',' read -ra patterns <<< "$file_pattern"
  for i in "${!patterns[@]}"; do
    local p="${patterns[$i]}"
    p="${p## }"  # trim leading space
    p="${p%% }"  # trim trailing space
    if [ "$i" -gt 0 ]; then
      find_args+=("-o")
    fi
    find_args+=("-name" "$p")
  done

  find . \( "${find_args[@]}" \) \
    -not -path "./.gyro/*" \
    -not -path "./node_modules/*" \
    -not -path "./.git/*" \
    -not -path "./.venv/*" \
    -not -path "./__pycache__/*"
}

snapshot_test_files() {
  local story_id="$1"
  local file_pattern
  file_pattern=$(get_test_lock_field "$story_id" "file_pattern")
  [ -z "$file_pattern" ] && file_pattern="*_test.go"

  find_test_files "$file_pattern" -exec md5sum {} \; | sort > "$STATE_DIR/test-checksums.txt"

  local count
  count=$(wc -l < "$STATE_DIR/test-checksums.txt")
  log "  ${CYAN}[gate]${NC} Snapshotted ${BOLD}${count}${NC} test file(s)"
}

gate_verify_red() {
  local story_id="$1"
  local test_cmd
  test_cmd=$(get_test_lock_field "$story_id" "test_cmd")
  [ -z "$test_cmd" ] && return 0

  local verify_red
  verify_red=$(get_test_lock_field "$story_id" "verify_red")
  [ "$verify_red" != "true" ] && return 0

  log "  ${CYAN}[gate]${NC} Verifying tests fail (red phase)..."

  if eval "$test_cmd" > "$STATE_DIR/gate-test-output.log" 2>&1; then
    warn "  [gate] Tests PASS after test step — expected them to FAIL"
    warn "  [gate] The test step must write tests that fail without implementation"
    cat > "$STATE_DIR/review-feedback.txt" << 'GATEFAIL'
GATE_FAIL (verify-red): Tests passed when they should fail.
The test step wrote tests that pass without new implementation.
This means the tests are not verifying new behavior.
Fix: write tests that assert on behavior that does NOT yet exist,
so they fail against the current code.
GATEFAIL
    return 1
  fi

  ok "  [gate] Red phase confirmed — tests correctly fail"
  return 0
}

gate_verify_test_lock() {
  local story_id="$1"

  if [ ! -f "$STATE_DIR/test-checksums.txt" ]; then
    warn "  [gate] No test checksums found — skipping test-lock check"
    return 0
  fi

  local file_pattern
  file_pattern=$(get_test_lock_field "$story_id" "file_pattern")
  [ -z "$file_pattern" ] && file_pattern="*_test.go"

  find_test_files "$file_pattern" -exec md5sum {} \; | sort > "$STATE_DIR/test-checksums-after.txt"

  if ! diff -q "$STATE_DIR/test-checksums.txt" "$STATE_DIR/test-checksums-after.txt" > /dev/null 2>&1; then
    warn "  [gate] FAIL — Test files were modified by the work step!"
    echo ""
    diff "$STATE_DIR/test-checksums.txt" "$STATE_DIR/test-checksums-after.txt" 2>/dev/null || true
    echo ""
    cat > "$STATE_DIR/review-feedback.txt" << GATEFAIL
GATE_FAIL (test-lock): Test files were modified by the work step.
The work step MUST NOT modify test files (${file_pattern}) — they were written by the test step.
Only write implementation/production code to make the existing tests pass.
Do NOT touch any test files matching: ${file_pattern}
GATEFAIL
    return 1
  fi

  ok "  [gate] Test lock verified — test files unchanged"
  return 0
}

# Run post-step gates based on pipeline config
# Returns 0 if gate passes, 1 if gate fails
run_post_step_gate() {
  local story_id="$1" step="$2"

  # Only run gates if pipeline has test_lock
  has_test_lock "$story_id" || return 0

  case "$step" in
    test)
      snapshot_test_files "$story_id"
      gate_verify_red "$story_id" || return 1
      ;;
    work)
      gate_verify_test_lock "$story_id" || return 1
      ;;
  esac

  return 0
}

mark_story_passed() {
  local story_id="$1" tmp
  tmp=$(mktemp)
  jq --arg id "$story_id" \
    '.stories |= map(if .id == $id then .passes = true else . end)' \
    "$PRD" > "$tmp" && mv -f "$tmp" "$PRD"
}

count_stories() {
  jq '.stories | length' "$PRD"
}

count_passed() {
  jq '[.stories[] | select(.passes == true)] | length' "$PRD"
}

count_remaining() {
  jq '[.stories[] | select(.passes == false)] | length' "$PRD"
}

has_checkpoints() {
  jq -e '.checkpoints // empty' "$PRD" > /dev/null 2>&1
}

should_run_checkpoint_after() {
  local story_id="$1" checkpoint_name="$2"
  jq -r --arg id "$story_id" --arg cp "$checkpoint_name" \
    'if .checkpoints[$cp].after == "each" then true
     elif .checkpoints[$cp].after then
       (.checkpoints[$cp].after | index($id)) != null
     else false end' "$PRD"
}

get_checkpoint_names() {
  jq -r '.checkpoints | keys[]' "$PRD" 2>/dev/null || true
}

get_on_complete_checkpoints() {
  jq -r '.checkpoints | to_entries[] | select(.value.on_complete == true) | .key' "$PRD" 2>/dev/null || true
}

# === Checkpoint Scoping (git tags) ===
get_latest_checkpoint_tag() {
  local checkpoint_name="$1"
  git tag -l "gyro-cp-${checkpoint_name}-*" --sort=-version:refname | head -1
}

get_next_checkpoint_tag_number() {
  local checkpoint_name="$1"
  local latest
  latest=$(get_latest_checkpoint_tag "$checkpoint_name")
  if [ -z "$latest" ]; then
    echo 1
  else
    local num="${latest##*-}"
    echo $((num + 1))
  fi
}

create_checkpoint_tag() {
  local checkpoint_name="$1"
  local num
  num=$(get_next_checkpoint_tag_number "$checkpoint_name")
  local tag="gyro-cp-${checkpoint_name}-${num}"
  git tag "$tag"
  log "  Tagged: ${tag}"
}

write_checkpoint_scope() {
  local checkpoint_name="$1"
  local latest_tag
  latest_tag=$(get_latest_checkpoint_tag "$checkpoint_name")

  if [ -z "$latest_tag" ]; then
    # First run — no prior tag, scope is everything
    echo "" > "$STATE_DIR/checkpoint-scope.txt"
    log "  [${checkpoint_name}] Scope: full codebase (first run)"
  else
    # Scope to files changed since last checkpoint tag
    echo "$latest_tag" > "$STATE_DIR/checkpoint-scope.txt"
    local changed_count
    changed_count=$(git diff --name-only "$latest_tag"..HEAD | wc -l)
    log "  [${checkpoint_name}] Scope: ${changed_count} files changed since ${latest_tag}"
  fi
}

# === Work Branch Management ===
use_work_branches() {
  jq -e '.work_branches // false' "$PRD" 2>/dev/null | grep -q true
}

create_story_branch() {
  local story_id="$1"
  local branch="gyro/${story_id}"

  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git checkout "$branch"
    log "Switched to existing branch: $branch"
  else
    git checkout -b "$branch"
    log "Created branch: $branch"
  fi
}

# === Agent + Model Selection ===
#
# prd.json "models" values can be:
#   "opus"                     — alias, uses default agent
#   "claude:opus"              — explicit agent + alias
#   "codex:gpt-5.3-codex"      — explicit agent + model ID
#   "codex:gpt-5-codex"        — explicit agent + full model ID
#
get_model_config() {
  local step_name="$1"
  jq -r --arg s "$step_name" '.models[$s] // empty' "$PRD"
}

# Parse "agent:model" → sets STEP_AGENT and STEP_MODEL
parse_agent_model() {
  local config="$1"
  if [[ "$config" == *:* ]]; then
    STEP_AGENT="${config%%:*}"
    STEP_MODEL="${config#*:}"
  else
    STEP_AGENT="$DEFAULT_AGENT"
    STEP_MODEL="$config"
  fi
}

expand_model_alias() {
  local agent="$1" alias="$2"
  case "$agent" in
    codex)
      case "$alias" in
        opus|sonnet|haiku) echo "gpt-5.3-codex" ;;
        *)      echo "$alias" ;;
      esac
      ;;
    claude)
      case "$alias" in
        opus)   echo "claude-opus-4-6" ;;
        sonnet) echo "claude-sonnet-4-6" ;;
        haiku)  echo "claude-haiku-4-5-20251001" ;;
        *)      echo "$alias" ;;
      esac
      ;;
    *)
      echo "$alias" ;;
  esac
}

build_ai_cmd() {
  local agent="$1" resolved_model="$2"
  case "$agent" in
    codex)  echo "codex exec -s danger-full-access${resolved_model:+ -m ${resolved_model}}" ;;
    claude) echo "claude -p --dangerously-skip-permissions --output-format json${resolved_model:+ --model ${resolved_model}}" ;;
    *)
      fail "Unknown agent: $agent"
      exit 1
      ;;
  esac
}

require_agent() {
  local agent="$1"
  if ! command -v "$agent" &> /dev/null; then
    fail "${agent} CLI not found but required by models config."
    case "$agent" in
      claude) fail "  Install: npm i -g @anthropic-ai/claude-code" ;;
      codex)  fail "  Install: npm i -g @openai/codex" ;;
    esac
    exit 1
  fi
}

# === Step Runner ===
run_step() {
  local step_name="$1"
  local prompt_file="$PROMPT_DIR/${step_name}.md"

  if [ ! -f "$prompt_file" ]; then
    fail "Prompt not found: $prompt_file"
    exit 1
  fi

  # Resolve agent + model from prd.json
  local config resolved_model="" agent label
  config=$(get_model_config "$step_name")

  if [ -n "$config" ]; then
    parse_agent_model "$config"
    require_agent "$STEP_AGENT"
    resolved_model=$(expand_model_alias "$STEP_AGENT" "$STEP_MODEL")
    agent="$STEP_AGENT"
    label="${STEP_AGENT}:${STEP_MODEL}"
  else
    agent="$DEFAULT_AGENT"
    require_agent "$agent"
    label="$agent"
  fi

  local ai_cmd
  ai_cmd=$(build_ai_cmd "$agent" "$resolved_model")

  log "  [${BOLD}${step_name}${NC}] Running (${label})..."

  local step_log="$STATE_DIR/${step_name}-output.log"
  local step_stderr="$STATE_DIR/${step_name}-stderr.log"

  if $ai_cmd < "$prompt_file" > "$step_log" 2>"$step_stderr"; then
    parse_step_usage "$step_log" "$step_name" "$agent"
    log "  [${step_name}] Completed"
  else
    parse_step_usage "$step_log" "$step_name" "$agent"
    warn "  [${step_name}] Exited with non-zero status"
    echo -e "${DIM}"
    if [ "$agent" = "claude" ] && jq -e . "$step_log" > /dev/null 2>&1; then
      jq -r '.result // empty' "$step_log" | tail -20
    else
      tail -20 "$step_log" 2>/dev/null || true
    fi
    tail -5 "$step_stderr" 2>/dev/null || true
    echo -e "${NC}"
    return 1
  fi
}

# === Checkpoint Runner ===
run_checkpoint() {
  local checkpoint_name="$1"
  local prompt_file="$PROMPT_DIR/${checkpoint_name}.md"

  if [ ! -f "$prompt_file" ]; then
    warn "Checkpoint prompt not found: $prompt_file — skipping"
    return
  fi

  hr
  log "${BOLD}CHECKPOINT: ${checkpoint_name}${NC}"
  hr

  # Write scope info so the checkpoint prompt knows what to review
  write_checkpoint_scope "$checkpoint_name"

  rm -f "$STATE_DIR/work-summary.txt"
  rm -f "$STATE_DIR/review-result.txt"
  rm -f "$STATE_DIR/review-feedback.txt"

  # Standalone checkpoints (e.g., push) run once with no review loop
  local is_standalone
  is_standalone=$(jq -r --arg cp "$checkpoint_name" '.checkpoints[$cp].standalone // false' "$PRD")

  if [ "$is_standalone" = "true" ]; then
    if ! run_step "$checkpoint_name"; then
      warn "  [${checkpoint_name}] Standalone checkpoint crashed"
      return
    fi
    # Commit if there are changes
    if ! git diff --quiet HEAD 2>/dev/null || [ -n "$(git ls-files --others --exclude-standard)" ]; then
      git add -A
      git commit -m "${checkpoint_name}: standalone checkpoint" || true
      log "  [${checkpoint_name}] Committed"
    fi
    ok "  [${checkpoint_name}] Completed"
    create_checkpoint_tag "$checkpoint_name"

    echo "---" >> "$PROGRESS"
    echo "[checkpoint:${checkpoint_name}] Completed on $(date -Iseconds)" >> "$PROGRESS"
    cat "$STATE_DIR/work-summary.txt" >> "$PROGRESS" 2>/dev/null || true
    echo "" >> "$PROGRESS"
    return
  fi

  for attempt in $(seq 1 "$MAX_STORY_RETRIES"); do
    log "  [${checkpoint_name}] Attempt $attempt/$MAX_STORY_RETRIES"

    # Run the checkpoint step
    if ! run_step "$checkpoint_name"; then
      warn "  [${checkpoint_name}] Step crashed — retrying"
      continue
    fi

    # Check if no changes needed
    if [ -f "$STATE_DIR/work-summary.txt" ] && \
       grep -qi "NO_CHANGES" "$STATE_DIR/work-summary.txt" 2>/dev/null; then
      ok "  [${checkpoint_name}] No changes needed — code is clean"
      create_checkpoint_tag "$checkpoint_name"
      return
    fi

    # Run review on the checkpoint's changes
    if ! run_step "review"; then
      warn "  [review] Step crashed — retrying"
      continue
    fi

    local result
    result=$(cat "$STATE_DIR/review-result.txt" 2>/dev/null | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')

    if [ "$result" = "SHIP" ]; then
      # Commit after review passes
      local cp_summary=""
      [ -f "$STATE_DIR/work-summary.txt" ] && cp_summary=$(head -1 "$STATE_DIR/work-summary.txt")
      git add -A
      git commit -m "${checkpoint_name}: ${cp_summary:-checkpoint complete}" || true
      log "  [${checkpoint_name}] Committed"

      ok "  [${checkpoint_name}] SHIPPED on attempt $attempt"
      create_checkpoint_tag "$checkpoint_name"

      echo "---" >> "$PROGRESS"
      echo "[checkpoint:${checkpoint_name}] Completed on $(date -Iseconds)" >> "$PROGRESS"
      cat "$STATE_DIR/work-summary.txt" >> "$PROGRESS" 2>/dev/null || true
      echo "" >> "$PROGRESS"
      return
    fi

    warn "  [${checkpoint_name}] REVISE — retrying"
    if [ -f "$STATE_DIR/review-feedback.txt" ]; then
      echo -e "${DIM}"
      head -20 "$STATE_DIR/review-feedback.txt"
      echo -e "${NC}"
    fi
  done

  warn "[${checkpoint_name}] Max retries reached. Continuing anyway."
}

# === Progress Display ===
show_progress() {
  local passed total remaining
  passed=$(count_passed)
  total=$(count_stories)
  remaining=$(count_remaining)

  local pct=0
  if [ "$total" -gt 0 ]; then
    pct=$((passed * 100 / total))
  fi

  local bar_len=30
  local filled=$((pct * bar_len / 100))
  local empty=$((bar_len - filled))

  local bar="${GREEN}"
  for ((i=0; i<filled; i++)); do bar+="█"; done
  bar+="${DIM}"
  for ((i=0; i<empty; i++)); do bar+="░"; done
  bar+="${NC}"

  echo -e "\n  ${bar} ${BOLD}${pct}%${NC} (${passed}/${total} stories, ${remaining} remaining)\n"
}

# === Dry Run ===
dry_run() {
  echo -e "\n${BOLD}Gyro Loop — Execution Plan${NC}\n"
  echo -e "  ${CYAN}Default agent: ${DEFAULT_AGENT}${NC}"

  if use_work_branches; then
    echo -e "  ${CYAN}Work branches: enabled${NC} (base: ${BASE_BRANCH})"
    echo ""
  fi

  local stories
  stories=$(jq -r '.stories | sort_by(.priority)[] | "\(.id)|\(.title)|\(.pipeline)|\(.passes)"' "$PRD")

  while IFS='|' read -r id title pipeline passes; do
    local status="⬚"
    [ "$passes" = "true" ] && status="${GREEN}✓${NC}"

    local steps ptype has_lock=""
    ptype=$(jq -r --arg p "$pipeline" '.pipelines[$p] | type' "$PRD")
    if [ "$ptype" = "array" ]; then
      steps=$(jq -r --arg p "$pipeline" '.pipelines[$p] | join(" → ")' "$PRD")
    else
      steps=$(jq -r --arg p "$pipeline" '.pipelines[$p].steps | join(" → ")' "$PRD")
      if jq -e --arg p "$pipeline" '.pipelines[$p].test_lock // empty' "$PRD" > /dev/null 2>&1; then
        has_lock=" ${YELLOW}[test-lock]${NC}"
      fi
    fi

    local branch_info=""
    if use_work_branches; then
      branch_info=" ${DIM}→ gyro/${id}${NC}"
    fi

    echo -e "  ${status} ${BOLD}${id}${NC}: ${title}${branch_info}"
    echo -e "    ${DIM}pipeline: ${steps}${has_lock}${NC}"

    # Show checkpoints after this story
    if has_checkpoints; then
      for cp_name in $(get_checkpoint_names); do
        if [ "$(should_run_checkpoint_after "$id" "$cp_name")" = "true" ]; then
          echo -e "    ${YELLOW}↳ checkpoint: ${cp_name}${NC}"
        fi
      done
    fi
  done <<< "$stories"

  # Show on_complete checkpoints
  local on_complete
  on_complete=$(get_on_complete_checkpoints)
  if [ -n "$on_complete" ]; then
    echo ""
    for cp_name in $on_complete; do
      echo -e "  ${YELLOW}↳ final checkpoint: ${cp_name}${NC}"
    done
  fi

  echo ""
  show_progress
}

# === Parse Args ===
DRY_RUN=false
PLAN_MODE=false
RESUME_FROM=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run) DRY_RUN=true; shift ;;
    --plan)    PLAN_MODE=true; shift ;;
    --from)    RESUME_FROM="$2"; shift 2 ;;
    *)         echo "Unknown option: $1"; exit 1 ;;
  esac
done

# === Preflight ===
if [ ! -f "$PRD" ]; then
  fail "PRD not found at $PRD"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  fail "jq not found. Install it: sudo apt install jq"
  exit 1
fi

# === Resolve Default Agent ===
# Used for steps that don't specify "agent:" prefix in models config
resolve_default_agent() {
  case "$GYRO_DEFAULT_AGENT" in
    claude|codex)
      DEFAULT_AGENT="$GYRO_DEFAULT_AGENT"
      ;;
    auto)
      if command -v claude &> /dev/null; then
        DEFAULT_AGENT="claude"
      elif command -v codex &> /dev/null; then
        DEFAULT_AGENT="codex"
      else
        fail "No AI CLI found. Install one of:"
        fail "  Claude Code: npm i -g @anthropic-ai/claude-code"
        fail "  Codex CLI:   npm i -g @openai/codex"
        exit 1
      fi
      ;;
    *)
      fail "Unknown GYRO_DEFAULT_AGENT: $GYRO_DEFAULT_AGENT (expected: claude, codex, auto)"
      exit 1
      ;;
  esac
  ok "Default agent: ${DEFAULT_AGENT}"
}

resolve_default_agent

# === Init ===
mkdir -p "$STATE_DIR"
touch "$PROGRESS"
touch "$GYRO_LOG"

# === Init git if needed ===
if [ ! -d .git ]; then
  log "Initializing git repository"
  git init

  # Create .gitignore if one doesn't exist
  if [ ! -f .gitignore ]; then
    log "Creating default .gitignore"
    cat > .gitignore << 'GITIGNORE'
# Dependencies
node_modules/
vendor/
.venv/
__pycache__/

# Environment
.env
.env.*
!.env.example

# Build output
dist/
build/
out/

# OS / IDE
.DS_Store
Thumbs.db
*.swp
*.swo
.idea/
.vscode/

# Gyro state (keep config, ignore runtime state)
.gyro/state/
.gyro/gyro.log
GITIGNORE
  fi

  git add -A
  git commit -m "initial: gyro loop setup"
fi

# === Dry run mode ===
if [ "$DRY_RUN" = true ]; then
  dry_run
  exit 0
fi

# === Plan mode ===
if [ "$PLAN_MODE" = true ]; then
  log "Running planning mode..."
  run_step "plan"
  ok "Planning complete. Review PLAN.md, then run: ./plan-to-gyro.sh PLAN.md"
  exit 0
fi

# === Skip to resume point if specified ===
if [ -n "$RESUME_FROM" ]; then
  log "Resuming from $RESUME_FROM — marking prior stories as passed"
  # Mark all stories before the resume point as passed
  while read -r sid; do
    if [ "$sid" = "$RESUME_FROM" ]; then
      break
    fi
    mark_story_passed "$sid"
  done < <(jq -r '.stories | sort_by(.priority)[] | .id' "$PRD")
fi

# === Banner ===
echo ""
echo -e "${BOLD}  ╔══════════════════════════════════╗${NC}"
echo -e "${BOLD}  ║          Gyro Loop              ║${NC}"
echo -e "${BOLD}  ╚══════════════════════════════════╝${NC}"
echo -e "  ${DIM}Default agent: ${DEFAULT_AGENT}${NC}"
show_progress
hr

GYRO_START_TIME=$(date +%s)

# === Main Loop ===
while true; do
  STORY_ID=$(get_next_story)

  # All done?
  if [ -z "$STORY_ID" ]; then
    hr

    # Run on_complete checkpoints
    for cp_name in $(get_on_complete_checkpoints); do
      run_checkpoint "$cp_name"
    done

    GYRO_ELAPSED=$(( $(date +%s) - GYRO_START_TIME ))

    echo ""
    ok "${BOLD}All stories pass! Project complete.${NC} ($(format_duration $GYRO_ELAPSED))"
    show_progress
    show_usage_summary "Total tokens" "$TOTAL_INPUT_TOKENS" "$TOTAL_OUTPUT_TOKENS"
    if [ "$TOTAL_CACHE_READ" -gt 0 ]; then
      log "${DIM}Cache read: $(format_tokens $TOTAL_CACHE_READ)${NC}"
    fi

    echo -e "${DIM}Log: $GYRO_LOG${NC}"
    echo -e "${DIM}Progress: $PROGRESS${NC}"
    exit 0
  fi

  # Story info
  STORY_TITLE=$(get_story_field "$STORY_ID" "title")
  PIPELINE_STEPS=$(get_pipeline_steps "$STORY_ID")
  STEP_LIST=$(echo $PIPELINE_STEPS | tr '\n' ' ')

  hr
  log "${BOLD}$STORY_ID${NC}: $STORY_TITLE"
  log "Pipeline: ${STEP_LIST}"
  show_progress

  echo "$STORY_ID" > "$STATE_DIR/current-story.txt"
  STORY_START_TIME=$(date +%s)
  STORY_INPUT_TOKENS=0
  STORY_OUTPUT_TOKENS=0

  SHIPPED=false

  for attempt in $(seq 1 "$MAX_STORY_RETRIES"); do
    log "Attempt $attempt/$MAX_STORY_RETRIES"

    # Clear state for this attempt
    rm -f "$STATE_DIR/work-summary.txt"
    rm -f "$STATE_DIR/review-result.txt"
    rm -f "$STATE_DIR/test-summary.txt"
    rm -f "$STATE_DIR/test-checksums.txt"
    rm -f "$STATE_DIR/test-checksums-after.txt"
    rm -f "$STATE_DIR/gate-test-output.log"

    # Keep review feedback on retries so worker can read it
    if [ "$attempt" -eq 1 ]; then
      rm -f "$STATE_DIR/review-feedback.txt"
      clear_completed_steps "$STORY_ID"
    fi

    # Remove stale step logs (preserve logs for completed steps)
    for _logfile in "$STATE_DIR"/*-output.log; do
      [ -f "$_logfile" ] || continue
      _step_from_log=$(basename "$_logfile" -output.log)
      if ! is_step_completed "$STORY_ID" "$_step_from_log"; then
        rm -f "$_logfile"
      fi
    done

    # ---- Run each step in the pipeline ----
    STEP_FAILED=false

    for step in $PIPELINE_STEPS; do
      # Skip steps completed in a previous attempt (crash-retry)
      if is_step_completed "$STORY_ID" "$step"; then
        log "  [${step}] Already completed — skipping"
        continue
      fi

      step_start_time=$(date +%s)
      if ! run_step "$step"; then
        step_elapsed=$(( $(date +%s) - step_start_time ))
        warn "  [${step}] Step crashed — treating as REVISE ($(format_duration $step_elapsed))"
        STEP_FAILED=true
        break
      fi
      step_elapsed=$(( $(date +%s) - step_start_time ))
      log "  [${step}] Done ($(format_duration $step_elapsed))"

      # Run post-step gates (test-lock verification)
      if ! run_post_step_gate "$STORY_ID" "$step"; then
        warn "  [${step}] Gate failed — treating as REVISE"
        if [ -f "$STATE_DIR/review-feedback.txt" ]; then
          echo -e "${DIM}"
          head -20 "$STATE_DIR/review-feedback.txt"
          echo -e "${NC}"
        fi
        STEP_FAILED=true
        clear_completed_steps "$STORY_ID"
        break
      fi

      mark_step_completed "$STORY_ID" "$step"

      # After any step that can produce a review decision, check it
      if [ -f "$STATE_DIR/review-result.txt" ]; then
        RESULT=$(cat "$STATE_DIR/review-result.txt" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')

        if [ "$RESULT" = "REVISE" ]; then
          warn "  [${step}] → REVISE"
          if [ -f "$STATE_DIR/review-feedback.txt" ]; then
            echo -e "${DIM}"
            head -20 "$STATE_DIR/review-feedback.txt"
            echo -e "${NC}"
          fi
          STEP_FAILED=true
          clear_completed_steps "$STORY_ID"
          break  # exit step loop, retry from work
        fi

        # If SHIP, clear for next step to write its own decision
        if [ "$RESULT" = "SHIP" ]; then
          rm -f "$STATE_DIR/review-result.txt"
        fi
      fi
    done

    # ---- Evaluate outcome ----
    if [ "$STEP_FAILED" = false ]; then
      STORY_ELAPSED=$(( $(date +%s) - STORY_START_TIME ))

      # Branch + commit after all pipeline steps pass
      if use_work_branches; then
        create_story_branch "$STORY_ID"
      fi
      summary=""
      [ -f "$STATE_DIR/work-summary.txt" ] && summary=$(head -1 "$STATE_DIR/work-summary.txt")
      git add -A
      git commit -m "feat(${STORY_ID}): ${summary:-implementation complete}" || true
      log "  Committed on $(git branch --show-current)"

      ok "$STORY_ID SHIPPED on attempt $attempt ($(format_duration $STORY_ELAPSED))"
      show_usage_summary "Story tokens" "$STORY_INPUT_TOKENS" "$STORY_OUTPUT_TOKENS"
      mark_story_passed "$STORY_ID"

      # Append to progress
      echo "---" >> "$PROGRESS"
      echo "[$STORY_ID] Completed on $(date -Iseconds)" >> "$PROGRESS"
      cat "$STATE_DIR/work-summary.txt" >> "$PROGRESS" 2>/dev/null || true
      echo "" >> "$PROGRESS"

      SHIPPED=true

      # Run checkpoints if configured for after this story
      if has_checkpoints; then
        for cp_name in $(get_checkpoint_names); do
          if [ "$(should_run_checkpoint_after "$STORY_ID" "$cp_name")" = "true" ]; then
            run_checkpoint "$cp_name"
          fi
        done
      fi

      break
    fi

    # Max retries exhausted
    if [ "$attempt" -eq "$MAX_STORY_RETRIES" ]; then
      STORY_ELAPSED=$(( $(date +%s) - STORY_START_TIME ))
      GYRO_ELAPSED=$(( $(date +%s) - GYRO_START_TIME ))
      fail "$STORY_ID FAILED after $MAX_STORY_RETRIES attempts ($(format_duration $STORY_ELAPSED))"
      show_usage_summary "Story tokens" "$STORY_INPUT_TOKENS" "$STORY_OUTPUT_TOKENS"
      show_usage_summary "Total tokens" "$TOTAL_INPUT_TOKENS" "$TOTAL_OUTPUT_TOKENS"
      fail "Last review feedback:"
      cat "$STATE_DIR/review-feedback.txt" 2>/dev/null || echo "(none)"
      echo ""
      fail "Stopping. Fix the issue and run: ./gyro.sh --from $STORY_ID"
      fail "Total time: $(format_duration $GYRO_ELAPSED)"
      exit 1
    fi
  done
done
