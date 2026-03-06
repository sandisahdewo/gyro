#!/usr/bin/env node

/**
 * CLI entry point for plan-to-PRD conversion.
 * Core logic lives in converter.ts for reuse by the server.
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { convertPlanToPrd } from "./converter.js";

const CYAN = "\x1b[0;36m";
const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const RED = "\x1b[0;31m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

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

// --- Check for nested Claude Code session ---
if (process.env.CLAUDECODE) {
  die("Cannot run inside Claude Code session (nested sessions not supported).\n" +
    `  Run from a regular terminal: npx tsx src/convert.ts ${planFile}\n` +
    `  Or use the /plan-to-gyro slash command inside Claude Code.`);
}

// --- Read context ---
const planContent = readFileSync(planFile, "utf-8");
const existingPrd = existsSync(".gyro/prd.json") ? readFileSync(".gyro/prd.json", "utf-8") : undefined;
const agentsMd = existsSync("AGENTS.md") ? readFileSync("AGENTS.md", "utf-8") : undefined;

console.log(`${CYAN}[plan-to-gyro]${NC} Reading plan from: ${BOLD}${planFile}${NC}`);
if (existingPrd) console.log(`${CYAN}[plan-to-gyro]${NC} Found existing prd.json -- will preserve completed stories`);
if (agentsMd) console.log(`${CYAN}[plan-to-gyro]${NC} Found AGENTS.md -- will use for tech stack context`);

// --- Convert ---
const result = convertPlanToPrd({
  planContent,
  techStack,
  existingPrd,
  agentsMd,
  outputFile: preview ? undefined : outputFile,
});

const { prd, summary } = result;

// --- Summary ---
console.log(`\n${BOLD}Conversion Summary${NC}`);
console.log("──────────────────────────────────────");
console.log(`  Total stories:  ${BOLD}${summary.total}${NC}`);
console.log(`  Setup:          ${summary.setup}`);
console.log(`  Backend (TDD):  ${summary.backend}`);
console.log(`  Frontend (E2E): ${summary.frontend}`);

const otherCount = summary.total - summary.setup - summary.backend - summary.frontend;
if (otherCount > 0) console.log(`  Other:          ${otherCount}`);
console.log("");

// Pipeline gates
const testLockConfig = !Array.isArray(prd.pipelines["backend-tdd"])
  ? (prd.pipelines["backend-tdd"] as any)?.test_lock
  : null;

if (testLockConfig) {
  console.log(`  ${BOLD}Pipeline gates (backend-tdd):${NC}`);
  console.log(`    test_cmd:        ${testLockConfig.test_cmd}`);
  if (testLockConfig.test_cmd_file) console.log(`    test_cmd_file:   ${testLockConfig.test_cmd_file}`);
  console.log(`    file_pattern:    ${testLockConfig.file_pattern}`);
  console.log(`    verify_red:      ${testLockConfig.verify_red ?? false}`);
  console.log(`    verify_green:    ${testLockConfig.verify_green ?? false}`);
  console.log(`    flow:            test -> ${YELLOW}[verify_red]${NC} -> work -> ${YELLOW}[test_lock + verify_green]${NC} -> review`);
}

for (const name of ["frontend", "frontend-e2e"]) {
  const fp = prd.pipelines[name];
  if (fp && !Array.isArray(fp)) {
    const e2eConfig = (fp as any).e2e;
    if (e2eConfig) {
      const steps = (fp as any).steps as string[];
      console.log(`  ${BOLD}Pipeline gates (${name}):${NC}`);
      console.log(`    e2e test_cmd:    ${e2eConfig.test_cmd}`);
      console.log(`    flow:            ${steps.join(" -> ").replace("work", `work -> ${YELLOW}[verify_e2e]${NC}`)}`);
    }
  }
}
console.log("");

if (prd.checkpoints && Object.keys(prd.checkpoints).length > 0) {
  console.log(`  ${BOLD}Checkpoints (standard order):${NC}`);
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

// Story table
console.log(`${BOLD}Stories:${NC}\n`);
const header = (s: string, w: number) => s.padEnd(w);
console.log(`  ${header("ID", 12)} ${header("TITLE", 45)} ${header("PIPELINE", 15)} PRI`);
console.log(`  ${"─".repeat(12)} ${"─".repeat(45)} ${"─".repeat(15)} ${"─".repeat(3)}`);

for (const story of prd.stories) {
  const title = story.title.length > 43 ? story.title.slice(0, 40) + "..." : story.title;
  console.log(`  ${header(story.id, 12)} ${header(title, 45)} ${header(story.pipeline, 15)} ${story.priority}`);
}

console.log("");

if (preview) {
  console.log(`${CYAN}[plan-to-gyro]${NC} Preview mode -- not writing to disk`);
  console.log(`${BOLD}Generated prd.json:${NC}`);
  console.log(JSON.stringify(prd, null, 2));
} else {
  console.log(`  Next steps:`);
  console.log(`    ${CYAN}npx tsx src/index.ts --dry-run${NC}    # Review the execution plan`);
  console.log(`    ${CYAN}npx tsx src/index.ts${NC}              # Run it`);
}
