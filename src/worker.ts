/**
 * Worker process — runs inside a project directory.
 * Handles: plan conversion → engine execution.
 * Communicates status back to parent via IPC.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

function sendStatus(status: string) {
  if (process.send) {
    process.send({ type: "status", status });
  }
}

function sendEvent(projectId: string, event: Record<string, unknown>) {
  if (process.send) {
    process.send({
      type: "progress_event",
      event: { ...event, projectId, timestamp: new Date().toISOString() },
    });
  }
}

async function run() {
  const projectId = process.env.GYRO_PROJECT_ID!;
  const techStack = process.env.GYRO_TECH_STACK ?? "";
  const brainDir = process.env.GYRO_BRAIN_DIR!;

  console.log(`[worker] Starting project: ${projectId}`);

  // Step 1: Convert plan.md → prd.json
  sendStatus("converting");

  const planPath = "plan.md";
  if (!existsSync(planPath)) {
    console.error("[worker] plan.md not found in project directory");
    process.exit(1);
  }

  const planContent = readFileSync(planPath, "utf-8");
  const prdPath = ".gyro/prd.json";

  // Only convert if prd.json doesn't exist yet
  if (!existsSync(prdPath)) {
    // Dynamic import of converter from brain directory
    const converterPath = resolve(brainDir, "src", "converter.ts");
    const { convertPlanToPrd } = await import(converterPath);

    try {
      const result = convertPlanToPrd({
        planContent,
        techStack,
        outputFile: prdPath,
      });
      console.log(`[worker] Converted plan: ${result.summary.total} stories`);
    } catch (err: any) {
      console.error(`[worker] Conversion failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    console.log("[worker] prd.json already exists, skipping conversion");
  }

  // Step 2: Run the engine
  sendStatus("running");

  const { PrdFile } = await import(resolve(brainDir, "src", "prd.ts"));
  const { State } = await import(resolve(brainDir, "src", "state.ts"));
  const { ProgressTracker } = await import(resolve(brainDir, "src", "progress.ts"));
  const { resolveDefaultAgent } = await import(resolve(brainDir, "src", "agents", "resolve.ts"));
  const { initGitIfNeeded, runEngine } = await import(resolve(brainDir, "src", "engine.ts"));
  const { setLogFile } = await import(resolve(brainDir, "src", "log.ts"));
  const { mkdirSync, writeFileSync } = await import("fs");

  // Ensure state directories exist
  mkdirSync(".gyro/state", { recursive: true });
  const progressFile = ".gyro/progress.txt";
  const logFile = ".gyro/gyro.log";
  if (!existsSync(progressFile)) writeFileSync(progressFile, "");
  if (!existsSync(logFile)) writeFileSync(logFile, "");

  setLogFile(logFile);

  const defaultAgent = resolveDefaultAgent(process.env.GYRO_DEFAULT_AGENT ?? "auto");
  const prd = new PrdFile(prdPath);
  const state = new State(".gyro/state");

  initGitIfNeeded();
  runEngine(prd, state, {
    maxRetries: parseInt(process.env.GYRO_MAX_RETRIES ?? "5", 10),
    baseBranch: process.env.GYRO_BASE_BRANCH ?? "main",
    defaultAgent,
    prdPath,
    progressFile,
  }, (event: Record<string, unknown>) => sendEvent(projectId, event));
}

run().catch((err) => {
  console.error(`[worker] Fatal error: ${err.message}`);
  process.exit(1);
});
