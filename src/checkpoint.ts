import { appendFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import type { AgentType } from "./types.js";
import { PrdFile } from "./prd.js";
import { State } from "./state.js";
import { ProgressTracker } from "./progress.js";
import { runStep } from "./pipeline.js";
import * as git from "./git.js";
import { log, ok, warn, fail, hr, BOLD, DIM, CYAN, NC } from "./log.js";

export function runCheckpoint(
  checkpointName: string,
  prd: PrdFile,
  state: State,
  defaultAgent: AgentType,
  tracker: ProgressTracker,
  maxRetries: number,
  progressFile: string
) {
  const checkpoint = prd.checkpoints[checkpointName];

  // Command checkpoint — run the command, auto-fix if it fails
  if (checkpoint?.cmd) {
    runCommandCheckpoint(checkpointName, checkpoint.cmd, prd, state, defaultAgent, tracker, maxRetries, progressFile);
    return;
  }

  const promptFile = `.gyro/prompts/${checkpointName}.md`;
  if (!existsSync(promptFile)) {
    warn(`Checkpoint prompt not found: ${promptFile} -- skipping`);
    return;
  }

  hr();
  log(`${BOLD}CHECKPOINT: ${checkpointName}${NC}`);
  hr();

  // Write scope info
  writeCheckpointScope(checkpointName, state);

  state.remove("work-summary.txt");
  state.clearReviewResult();
  state.clearReviewFeedback();

  const isStandalone = prd.isStandalone(checkpointName);

  if (isStandalone) {
    runStandaloneCheckpoint(checkpointName, prd, state, defaultAgent, tracker, progressFile);
    return;
  }

  runReviewedCheckpoint(checkpointName, prd, state, defaultAgent, tracker, maxRetries, progressFile);
}

function runCommand(cmd: string): { success: boolean; output: string } {
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { success: true, output: stdout };
  } catch (err) {
    const parts: string[] = [];
    if (err instanceof Error && "stdout" in err) {
      const stdout = (err as { stdout: string }).stdout?.trim();
      if (stdout) parts.push(stdout);
    }
    if (err instanceof Error && "stderr" in err) {
      const stderr = (err as { stderr: string }).stderr?.trim();
      if (stderr) parts.push(stderr);
    }
    return { success: false, output: parts.join("\n") || "Command failed with no output" };
  }
}

function runCommandCheckpoint(
  checkpointName: string,
  cmd: string,
  prd: PrdFile,
  state: State,
  defaultAgent: AgentType,
  tracker: ProgressTracker,
  maxRetries: number,
  progressFile: string
) {
  hr();
  log(`${BOLD}CHECKPOINT: ${checkpointName}${NC} ${DIM}(${cmd})${NC}`);

  // First attempt — maybe it already passes
  const first = runCommand(cmd);
  if (first.success) {
    ok(`  ${CYAN}[${checkpointName}]${NC} Passed`);
    appendFileSync(
      progressFile,
      `---\n[checkpoint:${checkpointName}] Passed on ${new Date().toISOString()}\n\n`
    );
    return;
  }

  // Failed — enter fix loop
  const errorTail = first.output.split("\n").slice(-20).join("\n");
  warn(`  [${checkpointName}] FAILED -- entering fix loop`);
  console.log(`${DIM}${errorTail}${NC}`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`  [${checkpointName}] Fix attempt ${attempt}/${maxRetries}`);

    // Feed build error as review feedback so the work step knows what to fix
    state.setReviewFeedback(
      `CHECKPOINT_FAIL (${checkpointName}): \`${cmd}\` failed.\n` +
        `Fix the errors below and ensure the command passes.\n\n${errorTail}`
    );

    // Run fix step (fall back to work if fix prompt doesn't exist)
    const fixStep = existsSync(".gyro/prompts/fix.md") ? "fix" : "work";
    const fixOutcome = runStep(fixStep, prd, state, defaultAgent, tracker);
    if (!fixOutcome.success) {
      warn(`  [${checkpointName}] ${fixStep} step crashed -- retrying`);
      continue;
    }

    // Re-run the command
    const retry = runCommand(cmd);
    if (retry.success) {
      // Commit the fix
      if (git.hasChanges()) {
        git.gitAdd();
        git.gitCommit(`fix(${checkpointName}): resolve ${checkpointName} failure`);
        log(`  [${checkpointName}] Fix committed`);
      }

      ok(`  ${CYAN}[${checkpointName}]${NC} Passed on fix attempt ${attempt}`);
      appendFileSync(
        progressFile,
        `---\n[checkpoint:${checkpointName}] Passed on ${new Date().toISOString()} (after ${attempt} fix attempt(s))\n\n`
      );
      state.clearReviewFeedback();
      return;
    }

    // Still failing — update error for next attempt
    const newErrorTail = retry.output.split("\n").slice(-20).join("\n");
    warn(`  [${checkpointName}] Still failing after fix attempt ${attempt}`);
    console.log(`${DIM}${newErrorTail}${NC}`);
  }

  warn(`[${checkpointName}] Max retries reached. Continuing anyway.`);
  state.clearReviewFeedback();
}

function writeCheckpointScope(checkpointName: string, state: State) {
  const latestTag = git.getLatestCheckpointTag(checkpointName);
  if (!latestTag) {
    state.setCheckpointScope("");
    log(`  [${checkpointName}] Scope: full codebase (first run)`);
  } else {
    state.setCheckpointScope(latestTag);
    const count = git.countChangedFilesSince(latestTag);
    log(`  [${checkpointName}] Scope: ${count} files changed since ${latestTag}`);
  }
}

function appendProgress(progressFile: string, content: string) {
  appendFileSync(progressFile, content);
}

function commitCheckpoint(checkpointName: string, summary: string) {
  if (git.hasChanges()) {
    git.gitAdd();
    git.gitCommit(`${checkpointName}: ${summary || "checkpoint complete"}`);
    log(`  [${checkpointName}] Committed`);
  }
}

function runStandaloneCheckpoint(
  checkpointName: string,
  prd: PrdFile,
  state: State,
  defaultAgent: AgentType,
  tracker: ProgressTracker,
  progressFile: string
) {
  const outcome = runStep(checkpointName, prd, state, defaultAgent, tracker);
  if (!outcome.success) {
    warn(`  [${checkpointName}] Standalone checkpoint crashed`);
    return;
  }

  commitCheckpoint(checkpointName, "standalone checkpoint");
  ok(`  [${checkpointName}] Completed`);
  const tag = git.createCheckpointTag(checkpointName);
  log(`  Tagged: ${tag}`);

  appendProgress(
    progressFile,
    `---\n[checkpoint:${checkpointName}] Completed on ${new Date().toISOString()}\n` +
      `${state.getWorkSummary() ?? ""}\n\n`
  );
}

function runReviewedCheckpoint(
  checkpointName: string,
  prd: PrdFile,
  state: State,
  defaultAgent: AgentType,
  tracker: ProgressTracker,
  maxRetries: number,
  progressFile: string
) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`  [${checkpointName}] Attempt ${attempt}/${maxRetries}`);

    const outcome = runStep(checkpointName, prd, state, defaultAgent, tracker);
    if (!outcome.success) {
      warn(`  [${checkpointName}] Step crashed -- retrying`);
      continue;
    }

    if (state.isNoChanges()) {
      ok(`  [${checkpointName}] No changes needed -- code is clean`);
      const tag = git.createCheckpointTag(checkpointName);
      log(`  Tagged: ${tag}`);
      return;
    }

    // Run review
    const reviewOutcome = runStep("review", prd, state, defaultAgent, tracker);
    if (!reviewOutcome.success) {
      warn(`  [review] Step crashed -- retrying`);
      continue;
    }

    const result = state.getReviewResult();
    if (result === "SHIP") {
      const summary = state.getWorkSummary()?.split("\n")[0] ?? "";
      commitCheckpoint(checkpointName, summary);
      ok(`  [${checkpointName}] SHIPPED on attempt ${attempt}`);
      const tag = git.createCheckpointTag(checkpointName);
      log(`  Tagged: ${tag}`);

      appendProgress(
        progressFile,
        `---\n[checkpoint:${checkpointName}] Completed on ${new Date().toISOString()}\n` +
          `${state.getWorkSummary() ?? ""}\n\n`
      );
      return;
    }

    warn(`  [${checkpointName}] REVISE -- retrying`);
    const feedback = state.getReviewFeedback();
    if (feedback) {
      console.log(`${DIM}${feedback.split("\n").slice(0, 20).join("\n")}${NC}`);
    }
  }

  warn(`[${checkpointName}] Max retries reached. Continuing anyway.`);
}
