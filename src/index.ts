#!/usr/bin/env node

import { existsSync, mkdirSync } from "fs";
import { PrdFile } from "./prd.js";
import { State } from "./state.js";
import { ProgressTracker } from "./progress.js";
import { resolveDefaultAgent } from "./agents/resolve.js";
import { dryRun, runPlanMode, resumeFrom, initGitIfNeeded, runEngine } from "./engine.js";
import type { EngineConfig } from "./engine.js";
import { fail, setLogFile } from "./log.js";

// --- Parse CLI args ---
const args = process.argv.slice(2);
let dryRunMode = false;
let planMode = false;
let resumeFromId = "";

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case "--dry-run":
      dryRunMode = true;
      break;
    case "--plan":
      planMode = true;
      break;
    case "--from":
      resumeFromId = args[++i];
      break;
    default:
      console.error(`Unknown option: ${args[i]}`);
      process.exit(1);
  }
}

// --- Config from env ---
const prdPath = process.env.GYRO_PRD ?? ".gyro/prd.json";
const maxRetries = parseInt(process.env.GYRO_MAX_RETRIES ?? "5", 10);
const baseBranch = process.env.GYRO_BASE_BRANCH ?? "main";
const agentPref = process.env.GYRO_DEFAULT_AGENT ?? "auto";
const progressFile = ".gyro/progress.txt";
const logFile = ".gyro/gyro.log";

// --- Preflight ---
if (!existsSync(prdPath)) {
  fail(`PRD not found at ${prdPath}`);
  process.exit(1);
}

// Ensure directories exist
mkdirSync(".gyro/state", { recursive: true });

// Touch progress and log files
const { writeFileSync } = await import("fs");
if (!existsSync(progressFile)) writeFileSync(progressFile, "");
if (!existsSync(logFile)) writeFileSync(logFile, "");

setLogFile(logFile);

// --- Resolve default agent ---
let defaultAgent: "claude" | "codex";
try {
  defaultAgent = resolveDefaultAgent(agentPref);
} catch (err: any) {
  fail(err.message);
  process.exit(1);
}

console.log(`[gyro] Default agent: ${defaultAgent}`);

// --- Load PRD ---
const prd = new PrdFile(prdPath);
const state = new State(".gyro/state");
const tracker = new ProgressTracker();

const config: EngineConfig = {
  maxRetries,
  baseBranch,
  defaultAgent,
  prdPath,
  progressFile,
};

// --- Init git ---
initGitIfNeeded();

// --- Modes ---
if (dryRunMode) {
  dryRun(prd, config, tracker);
  process.exit(0);
}

if (planMode) {
  runPlanMode(prd, state, config, tracker);
  process.exit(0);
}

if (resumeFromId) {
  resumeFrom(resumeFromId, prd);
}

// --- Run ---
runEngine(prd, state, config);
