#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { dirname } from "path";
import type { PRD } from "./types.js";

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

function log(msg: string) { console.log(`${CYAN}[plan-to-gyro]${NC} ${msg}`); }
function ok(msg: string) { console.log(`${GREEN}[plan-to-gyro]${NC} ${msg}`); }
function warn(msg: string) { console.log(`${YELLOW}[plan-to-gyro]${NC} ${msg}`); }
function die(msg: string): never { console.error(`${RED}[plan-to-gyro]${NC} ${msg}`); process.exit(1); return undefined as never; }

// --- Parse args ---
const args = process.argv.slice(2);
let planFile = "";
let outputFile = ".gyro/prd.json";
let preview = false;
let techStack = "";

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--output": outputFile = args[++i]; break;
    case "--preview": preview = true; break;
    case "--tech": techStack = args[++i]; break;
    case "--help": case "-h":
      console.log("Usage: npx tsx src/convert.ts <plan-file> [options]");
      console.log("\nOptions:");
      console.log("  --output <path>   Output path (default: .gyro/prd.json)");
      console.log("  --preview         Preview without writing");
      console.log("  --tech <stack>    Tech stack hint (e.g., 'Go+React')");
      process.exit(0);
    default:
      if (args[i].startsWith("-")) die(`Unknown option: ${args[i]}`);
      planFile = args[i];
  }
}

// --- Find plan file ---
if (!planFile) {
  const candidates = ["plan.md", "PLAN.md", "IMPLEMENTATION_PLAN.md"];
  planFile = candidates.find((f) => existsSync(f)) ?? "";
  if (!planFile) die("No plan file specified and no plan.md found.");
}

if (!existsSync(planFile)) die(`Plan file not found: ${planFile}`);

try { execSync("which claude", { stdio: "ignore" }); }
catch { die("claude CLI not found. Install: npm i -g @anthropic-ai/claude-code"); }

log(`Reading plan from: ${BOLD}${planFile}${NC}`);

// --- Read context ---
const planContent = readFileSync(planFile, "utf-8");
const existingPrd = existsSync(".gyro/prd.json") ? readFileSync(".gyro/prd.json", "utf-8") : "";
const agentsMd = existsSync("AGENTS.md") ? readFileSync("AGENTS.md", "utf-8") : "";

if (existingPrd) log("Found existing prd.json -- will preserve completed stories");
if (agentsMd) log("Found AGENTS.md -- will use for tech stack context");

// --- Build prompt ---
const CONVERSION_PROMPT = `IMPORTANT: You are being used as a pure text converter. Do NOT use any tools.
Do NOT read files. Do NOT write files. Do NOT run commands.
Your ONLY job is to print raw JSON to stdout. Nothing else.

Convert the following implementation plan into a Gyro Loop prd.json file.

## Rules

### Story Decomposition
- Each story must be ONE cohesive unit of work completable in a single AI context window
- A story should touch at most 3-4 files
- If a plan step is too large, split it into multiple stories
- Order by dependency: setup -> backend -> frontend -> polish
- Use sequential priority numbers starting from 1

### Pipeline Assignment
Assign pipelines based on story type:
- "setup" -> simple array: ["work", "review"] -- project init, config, scaffolding
- "backend-tdd" -> object with test_lock (see format below) -- API endpoints, logic, data layer (strict TDD)
- "frontend-e2e" -> simple array: ["work", "review", "visual-verify"] -- UI pages, components (e2e test)

The backend-tdd pipeline uses a 3-step flow: test -> work -> review.
A separate "test" agent writes failing tests FIRST, then the "work" agent implements code
to make them pass. The test_lock gate enforces this by checksumming test files.

DO NOT create stories with a "simplify" pipeline. Simplification is handled automatically
by the checkpoint system -- never add simplify stories to the stories array.

### Detecting test_lock config from tech stack
Set test_cmd, test_cmd_file, and file_pattern based on the project's language:
- Go:         test_cmd = "go test ./...",   test_cmd_file = "go test {files}",   file_pattern = "*_test.go"
- TypeScript: test_cmd = "npm test",        test_cmd_file = "npx vitest {files}", file_pattern = "*.test.ts,*.spec.ts"
- JavaScript: test_cmd = "npm test",        test_cmd_file = "npx vitest {files}", file_pattern = "*.test.js,*.spec.js"
- Python:     test_cmd = "pytest",          test_cmd_file = "pytest {files}",     file_pattern = "test_*.py,*_test.py"
- Rust:       test_cmd = "cargo test",      file_pattern = "*_test.rs"
- Other:      infer from AGENTS.md, package.json, Makefile, or similar project config

Always set verify_red: true and verify_green: true on test_lock.
test_cmd_file uses {files} placeholder -- the engine substitutes the story's test files for scoped execution.

### Acceptance Criteria
MUST be specific and machine-verifiable. Each criterion is checked by an AI reviewer.
Keep criteria TERSE -- verifiable assertions only, not implementation detail.
The AI worker already has access to the plan file for full context.

Only describe WHAT the story delivers -- business logic and behavior.
Do NOT include infrastructure criteria like:
- "All prior tests still pass" (enforced by test-all checkpoint)
- "npm run build succeeds" (enforced by build checkpoint)
- "No lint errors" (enforced by lint checkpoint)
- "Tests are written first" (enforced by TDD pipeline)
These are already enforced automatically by gates and checkpoints.

Examples of GOOD criteria:
- "POST /items with {name:'X'} returns 201 with {id, name, createdAt}"
- "Empty name returns 400 with {error: 'name is required'}"
- "E2E test: type 'Buy milk', click Add, verify 'Buy milk' appears in list"
- "Form has input with placeholder 'Item name' and button labeled 'Add'"

Examples of BAD criteria (already enforced by the engine):
- "All prior tests still pass"
- "npm run build succeeds with zero errors"
- "go vet reports no issues"

For backend-tdd stories:
- Do NOT use "Write test FIRST:" prefix -- the test step handles this automatically
- Just describe WHAT to test and implement, not HOW to do TDD

For frontend-e2e stories, always include:
- UI description criteria
- "E2E test: [action] -> [expected result]"

### plan_ref Field
When a story maps to a specific section of the plan, add a "plan_ref" field with a short
pointer like "Step 3: HTML template with HTMX". This tells the AI worker where to look
in the plan file for full implementation detail.

### Checkpoints
Configure checkpoints (these run automatically, NOT as stories).
The engine runs them in standard order: lint -> simplify -> test-all -> type-check -> build.

Command checkpoints (run a command, auto-fix on failure):
- "test-all": runs full test suite to catch regressions
  - "after": "each", "on_complete": true
  - "cmd": the project's test command (e.g., "npm test", "go test ./...")
- "type-check": static type analysis
  - "after": "each", "on_complete": true
  - "cmd": the project's type-check command (e.g., "npx tsc --noEmit", "go vet ./...")
- "build": verifies the project compiles
  - "after": "each", "on_complete": true
  - "cmd": the project's build command (e.g., "npm run build", "go build ./...")

AI checkpoints (run an AI agent):
- "lint": standalone checkpoint for formatting/style fixes
  - Same "after" triggers as simplify
  - "standalone": true (no review loop -- linter is the verifier)
  - "on_complete": true
- "simplify": reviewed checkpoint for code quality
  - After the last backend story
  - After the last frontend story
  - "on_complete": true

Detect the correct commands from the project's language:
- Go:         test-all = "go test ./...",  type-check = "go vet ./...",       build = "go build ./..."
- TypeScript: test-all = "npm test",       type-check = "npx tsc --noEmit",  build = "npm run build"
- JavaScript: test-all = "npm test",       build = "npm run build" (no type-check)
- Python:     test-all = "pytest",         type-check = "mypy ." (if mypy configured), build = skip
- Rust:       test-all = "cargo test",     type-check = "cargo clippy",      build = "cargo build"

### Output Format
CRITICAL: Your entire response must be ONLY the raw JSON object.
- No markdown code fences (no \`\`\`)
- No explanation before or after
- No "here is the JSON" preamble
- No tool calls -- just print the JSON directly
- Start your response with { and end with }
The JSON must match this structure exactly:

{
  "project": "project-name",
  "models": {
    "test": "claude:sonnet",
    "work": "codex:gpt-5.3-codex",
    "review": "claude:opus",
    "fix": "claude:sonnet",
    "lint": "claude:haiku",
    "simplify": "claude:sonnet",
    "visual-verify": "claude:haiku"
  },
  "pipelines": {
    "setup": ["work", "review"],
    "backend-tdd": {
      "steps": ["test", "work", "review"],
      "test_lock": {
        "test_cmd": "<full test command>",
        "test_cmd_file": "<scoped test command with {files}>",
        "file_pattern": "<test file glob>",
        "verify_red": true,
        "verify_green": true
      }
    },
    "frontend-e2e": ["work", "review", "visual-verify"]
  },
  "checkpoints": {
    "test-all": {
      "cmd": "<full test command>",
      "after": "each",
      "on_complete": true
    },
    "type-check": {
      "cmd": "<type-check command>",
      "after": "each",
      "on_complete": true
    },
    "build": {
      "cmd": "<build command>",
      "after": "each",
      "on_complete": true
    },
    "lint": {
      "after": ["last-backend-story-id", "last-frontend-story-id"],
      "on_complete": true,
      "standalone": true
    },
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
project's language/framework.`;

let fullPrompt = CONVERSION_PROMPT;
if (techStack) fullPrompt += `\n\nThe tech stack is: ${techStack}`;
fullPrompt += `\n\n## Plan to Convert\n\n${planContent}`;
if (agentsMd) fullPrompt += `\n\n## Project Context (AGENTS.md)\n\n${agentsMd}`;
if (existingPrd) fullPrompt += `\n\n## Existing prd.json (preserve stories where passes: true)\n\n${existingPrd}`;

// --- Check for nested Claude Code session ---
if (process.env.CLAUDECODE) {
  die("Cannot run inside Claude Code session (nested sessions not supported).\n" +
    `  Run from a regular terminal: npx tsx src/convert.ts ${planFile}\n` +
    `  Or use the /plan-to-gyro slash command inside Claude Code.`);
}

// --- Run conversion ---
log("Converting plan to Gyro tasks...");

let rawResult: string;
try {
  rawResult = execSync("claude -p --max-turns 1", {
    input: fullPrompt,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
  });
} catch (err: any) {
  die(`Claude CLI failed: ${err.message}`);
}

// --- Extract JSON ---
function extractJson(text: string): PRD {
  // Strip code fences
  let cleaned = text.replace(/^```json?\s*$/gm, "").replace(/^```\s*$/gm, "");

  // Try parsing directly
  try { return JSON.parse(cleaned); } catch {}

  // Extract from first { to last }
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)); } catch {}
  }

  throw new Error("Claude returned invalid JSON");
}

let prd: PRD;
try {
  prd = extractJson(rawResult);
} catch (err: any) {
  die(`${err.message}. Raw output:\n\n${rawResult}`);
}

// --- Validate structure ---
if (!prd.pipelines || !prd.stories) die("Invalid prd.json structure -- missing pipelines or stories");
if (prd.stories.length === 0) die("No stories generated");

// --- Fix-ups ---

// Remove simplify stories
const simplifyStories = prd.stories.filter((s) => s.pipeline === "simplify");
if (simplifyStories.length > 0) {
  warn(`Found ${simplifyStories.length} simplify stories -- removing (should be checkpoints)`);
  prd.stories = prd.stories.filter((s) => s.pipeline !== "simplify");
  prd.stories.forEach((s, i) => { s.priority = i + 1; });
}

// Fix backend-tdd if generated as array
const backendCount = prd.stories.filter((s) => s.pipeline === "backend-tdd").length;
const backendPipeline = prd.pipelines["backend-tdd"];

interface TechConfig {
  testCmd: string;
  testCmdFile: string;
  filePattern: string;
  typeCheck?: string;
  buildCmd?: string;
}

function detectTechConfig(stack: string): TechConfig {
  const ts = stack.toLowerCase();
  if (ts.includes("typescript") || ts.includes("ts")) {
    return { testCmd: "npm test", testCmdFile: "npx vitest {files}", filePattern: "*.test.ts,*.spec.ts", typeCheck: "npx tsc --noEmit", buildCmd: "npm run build" };
  } else if (ts.includes("javascript") || ts.includes("js")) {
    return { testCmd: "npm test", testCmdFile: "npx vitest {files}", filePattern: "*.test.js,*.spec.js", buildCmd: "npm run build" };
  } else if (ts.includes("python")) {
    return { testCmd: "pytest", testCmdFile: "pytest {files}", filePattern: "test_*.py,*_test.py" };
  } else if (ts.includes("rust")) {
    return { testCmd: "cargo test", testCmdFile: "cargo test", filePattern: "*_test.rs", typeCheck: "cargo clippy", buildCmd: "cargo build" };
  }
  // Default: Go
  return { testCmd: "go test ./...", testCmdFile: "go test {files}", filePattern: "*_test.go", typeCheck: "go vet ./...", buildCmd: "go build ./..." };
}

const tech = detectTechConfig(techStack || agentsMd);

if (backendCount > 0 && Array.isArray(backendPipeline)) {
  warn("backend-tdd pipeline generated as array -- converting to object with test_lock");

  prd.pipelines["backend-tdd"] = {
    steps: ["test", "work", "review"],
    test_lock: {
      test_cmd: tech.testCmd,
      test_cmd_file: tech.testCmdFile,
      file_pattern: tech.filePattern,
      verify_red: true,
      verify_green: true,
    },
  };

  if (!prd.models?.test) {
    prd.models = prd.models ?? {};
    prd.models.test = "claude:sonnet";
  }

  ok(`Fixed: backend-tdd -> test -> work -> review [test-lock: ${tech.testCmd}]`);
}

// Validate and fix test_lock
if (backendCount > 0 && !Array.isArray(prd.pipelines["backend-tdd"])) {
  const p = prd.pipelines["backend-tdd"] as any;
  if (!p.test_lock) {
    warn("backend-tdd pipeline is missing test_lock config");
  } else {
    if (!p.test_lock.verify_green) {
      p.test_lock.verify_green = true;
      ok("Fixed: added verify_green to test_lock");
    }
    if (!p.test_lock.test_cmd_file) {
      p.test_lock.test_cmd_file = tech.testCmdFile;
      ok(`Fixed: added test_cmd_file to test_lock (${tech.testCmdFile})`);
    }
  }
}

// Ensure fix model
prd.models = prd.models ?? {};
if (!prd.models.fix) {
  prd.models.fix = "claude:sonnet";
}

// Ensure standard checkpoints
if (prd.stories.length > 0) {
  prd.checkpoints = prd.checkpoints ?? {};

  // Command checkpoints
  if (!prd.checkpoints["test-all"] && tech.testCmd) {
    prd.checkpoints["test-all"] = { cmd: tech.testCmd, after: "each", on_complete: true };
    ok(`Fixed: added test-all checkpoint (${tech.testCmd})`);
  }
  if (!prd.checkpoints["type-check"] && tech.typeCheck) {
    prd.checkpoints["type-check"] = { cmd: tech.typeCheck, after: "each", on_complete: true };
    ok(`Fixed: added type-check checkpoint (${tech.typeCheck})`);
  }
  if (!prd.checkpoints["build"] && tech.buildCmd) {
    prd.checkpoints["build"] = { cmd: tech.buildCmd, after: "each", on_complete: true };
    ok(`Fixed: added build checkpoint (${tech.buildCmd})`);
  }

  // AI checkpoints
  if (!prd.checkpoints.lint) {
    warn("Adding missing lint checkpoint");
    const simplifyAfter = prd.checkpoints.simplify?.after;
    const after = simplifyAfter && simplifyAfter !== "each"
      ? simplifyAfter
      : [prd.stories[prd.stories.length - 1].id];
    prd.checkpoints.lint = { after, on_complete: true, standalone: true };
    prd.models.lint = prd.models.lint ?? "claude:haiku";
    ok("Fixed: added lint checkpoint (standalone)");
  }
}

// --- Summary ---
const setupCount = prd.stories.filter((s) => s.pipeline === "setup").length;
const frontendCount = prd.stories.filter((s) => s.pipeline === "frontend-e2e").length;
const otherCount = prd.stories.length - setupCount - backendCount - frontendCount;

const testLockConfig = !Array.isArray(prd.pipelines["backend-tdd"])
  ? (prd.pipelines["backend-tdd"] as any)?.test_lock
  : null;

console.log(`\n${BOLD}Conversion Summary${NC}`);
console.log("──────────────────────────────────────");
console.log(`  Total stories:  ${BOLD}${prd.stories.length}${NC}`);
console.log(`  Setup:          ${setupCount}`);
console.log(`  Backend (TDD):  ${backendCount}`);
console.log(`  Frontend (E2E): ${frontendCount}`);
if (otherCount > 0) console.log(`  Other:          ${otherCount}`);
console.log("");

if (testLockConfig) {
  console.log(`  ${BOLD}Pipeline gates (backend-tdd):${NC}`);
  console.log(`    test_cmd:        ${testLockConfig.test_cmd}`);
  if (testLockConfig.test_cmd_file) console.log(`    test_cmd_file:   ${testLockConfig.test_cmd_file}`);
  console.log(`    file_pattern:    ${testLockConfig.file_pattern}`);
  console.log(`    verify_red:      ${testLockConfig.verify_red ?? false}`);
  console.log(`    verify_green:    ${testLockConfig.verify_green ?? false}`);
  console.log(`    flow:            test -> ${YELLOW}[verify_red]${NC} -> work -> ${YELLOW}[test_lock + verify_green]${NC} -> review`);
}
console.log("");

if (prd.checkpoints && Object.keys(prd.checkpoints).length > 0) {
  console.log(`  ${BOLD}Checkpoints (standard order):${NC}`);
  // Show in standard order
  const stdOrder = ["lint", "simplify", "test-all", "type-check", "build"];
  const allCpNames = [...stdOrder.filter((n) => n in prd.checkpoints!), ...Object.keys(prd.checkpoints).filter((n) => !stdOrder.includes(n))];
  for (const name of allCpNames) {
    const cp = prd.checkpoints![name];
    const type = cp.cmd ? `cmd: ${cp.cmd}` : cp.standalone ? "AI (standalone)" : "AI (reviewed)";
    const after = cp.after ? (cp.after === "each" ? "each" : (cp.after as string[]).join(", ")) : "";
    const onComplete = cp.on_complete ? " + on_complete" : "";
    console.log(`    ${name.padEnd(12)} ${type}`);
    console.log(`    ${"".padEnd(12)} ${DIM}run: ${after}${onComplete}${NC}`);
  }
}
console.log("──────────────────────────────────────\n");

// --- Story table ---
console.log(`${BOLD}Stories:${NC}\n`);
const header = (s: string, w: number) => s.padEnd(w);
console.log(`  ${header("ID", 12)} ${header("TITLE", 45)} ${header("PIPELINE", 15)} PRI`);
console.log(`  ${"─".repeat(12)} ${"─".repeat(45)} ${"─".repeat(15)} ${"─".repeat(3)}`);

for (const story of prd.stories) {
  const title = story.title.length > 43 ? story.title.slice(0, 40) + "..." : story.title;
  console.log(`  ${header(story.id, 12)} ${header(title, 45)} ${header(story.pipeline, 15)} ${story.priority}`);
}

console.log("");

// --- Write or preview ---
if (preview) {
  log("Preview mode -- not writing to disk");
  console.log(`${BOLD}Generated prd.json:${NC}`);
  console.log(JSON.stringify(prd, null, 2));
} else {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(prd, null, 2) + "\n");
  ok(`Written to ${BOLD}${outputFile}${NC}`);
  console.log(`\n  Next steps:`);
  console.log(`    ${CYAN}npx tsx src/index.ts --dry-run${NC}    # Review the execution plan`);
  console.log(`    ${CYAN}npx tsx src/index.ts${NC}              # Run it`);
}
