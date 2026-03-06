import { appendFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import type { AgentType, EnvConfig } from "./types.js";
import { PrdFile } from "./prd.js";
import { State } from "./state.js";
import { ProgressTracker } from "./progress.js";
import { runStep, runStoryPipeline } from "./pipeline.js";
import { runCheckpoint } from "./checkpoint.js";
import * as git from "./git.js";
import { log, ok, warn, fail, hr, formatDuration, BOLD, DIM, CYAN, YELLOW, GREEN, NC } from "./log.js";

function envUp(env: EnvConfig) {
  log(`Starting environment: ${DIM}${env.up}${NC}`);
  try {
    execSync(env.up, { stdio: "inherit", shell: "/bin/bash" });
    ok("Environment is up");
  } catch {
    fail("Failed to start environment");
    fail(`Command: ${env.up}`);
    process.exit(1);
  }
}

function envDown(env: EnvConfig) {
  log(`Stopping environment: ${DIM}${env.down}${NC}`);
  try {
    execSync(env.down, { stdio: "inherit", shell: "/bin/bash" });
    ok("Environment stopped");
  } catch {
    warn("Failed to stop environment cleanly");
  }
}

export interface EngineConfig {
  maxRetries: number;
  baseBranch: string;
  defaultAgent: AgentType;
  prdPath: string;
  progressFile: string;
}

export function dryRun(prd: PrdFile, config: EngineConfig, tracker: ProgressTracker) {
  console.log(`\n${BOLD}Gyro Loop -- Execution Plan${NC}\n`);
  console.log(`  ${CYAN}Default agent: ${config.defaultAgent}${NC}`);

  if (prd.useWorkBranches()) {
    console.log(`  ${CYAN}Work branches: enabled${NC} (base: ${config.baseBranch})`);
  }

  if (prd.hasEnv()) {
    const env = prd.getEnv()!;
    console.log(`  ${CYAN}Environment:${NC}`);
    console.log(`    ${DIM}up:   ${env.up}${NC}`);
    console.log(`    ${DIM}down: ${env.down}${NC}`);
  }

  // Show pipeline gates
  for (const [name, config_] of Object.entries(prd.data.pipelines)) {
    if (Array.isArray(config_)) continue;
    const obj = config_ as any;
    if (obj.test_lock) {
      const tl = obj.test_lock;
      const gates: string[] = [];
      if (tl.verify_red) gates.push("verify_red");
      if (tl.verify_green) gates.push("verify_green");
      gates.push("test_lock");
      console.log(`  ${CYAN}${name} gates: ${gates.join(", ")}${NC}`);
      if (tl.test_cmd_file) console.log(`  ${DIM}scoped tests: ${tl.test_cmd_file}${NC}`);
    }
    if (obj.e2e) {
      console.log(`  ${CYAN}${name} gates: verify_e2e (${obj.e2e.test_cmd})${NC}`);
    }
  }

  console.log("");

  for (const story of prd.sortedStories()) {
    const status = story.passes ? `${GREEN}OK${NC}` : "[ ]";
    const steps = prd.getPipelineSteps(story.pipeline);
    const testLock = prd.getTestLock(story.pipeline);
    const e2e = prd.getE2e(story.pipeline);
    const branchStr = prd.useWorkBranches() ? ` ${DIM}-> gyro/${story.id}${NC}` : "";

    // Build step display with gates inline
    const stepParts: string[] = [];
    for (const step of steps) {
      stepParts.push(step);
      if (testLock && step === "test") {
        const gates: string[] = [];
        if (testLock.verify_red) gates.push("verify_red");
        if (gates.length) stepParts.push(`${YELLOW}[${gates.join(" + ")}]${NC}`);
      }
      if (step === "work") {
        const gates: string[] = [];
        if (testLock) {
          gates.push("test_lock");
          if (testLock.verify_green) gates.push("verify_green");
        }
        if (e2e) gates.push("verify_e2e");
        if (gates.length) stepParts.push(`${YELLOW}[${gates.join(" + ")}]${NC}`);
      }
    }

    console.log(`  ${status} ${BOLD}${story.id}${NC}: ${story.title}${branchStr}`);
    console.log(`    ${DIM}${stepParts.join(" -> ")}${NC}`);

    if (prd.hasCheckpoints()) {
      for (const cpName of prd.getCheckpointNames()) {
        if (prd.shouldRunCheckpointAfter(story.id, cpName)) {
          const cp = prd.checkpoints[cpName];
          const label = cp.cmd ? `${cpName} (${cp.cmd})` : cpName;
          console.log(`    ${YELLOW}-> ${label}${NC}`);
        }
      }
    }
  }

  const onComplete = prd.getOnCompleteCheckpoints();
  if (onComplete.length > 0) {
    console.log("");
    console.log(`  ${BOLD}On complete:${NC}`);
    for (const cpName of onComplete) {
      const cp = prd.checkpoints[cpName];
      const label = cp.cmd ? `${cpName} (${cp.cmd})` : cpName;
      console.log(`  ${YELLOW}-> ${label}${NC}`);
    }
  }

  console.log("");
  tracker.showProgressBar(prd.countPassed(), prd.countStories());
}

export function runPlanMode(
  prd: PrdFile,
  state: State,
  config: EngineConfig,
  tracker: ProgressTracker
) {
  log("Running planning mode...");
  runStep("plan", prd, state, config.defaultAgent, tracker);
  ok("Planning complete. Review PLAN.md, then run: npx tsx src/convert.ts PLAN.md");
}

export function resumeFrom(storyId: string, prd: PrdFile) {
  log(`Resuming from ${storyId} -- marking prior stories as passed`);
  for (const story of prd.sortedStories()) {
    if (story.id === storyId) break;
    prd.markStoryPassed(story.id);
  }
}

export function initGitIfNeeded() {
  if (!git.isGitRepo()) {
    log("Initializing git repository");
    git.initRepo();

    if (!existsSync(".gitignore")) {
      log("Creating default .gitignore");
      writeFileSync(
        ".gitignore",
        [
          "# Dependencies",
          "node_modules/",
          "vendor/",
          ".venv/",
          "__pycache__/",
          "",
          "# Environment",
          ".env",
          ".env.*",
          "!.env.example",
          "",
          "# Build output",
          "dist/",
          "build/",
          "out/",
          "",
          "# OS / IDE",
          ".DS_Store",
          "Thumbs.db",
          "*.swp",
          "*.swo",
          ".idea/",
          ".vscode/",
          "",
          "# Gyro state",
          ".gyro/state/",
          ".gyro/gyro.log",
          "",
        ].join("\n")
      );
    }

    git.gitAdd();
    git.gitCommit("initial: gyro loop setup");
  }
}

export function runEngine(prd: PrdFile, state: State, config: EngineConfig) {
  const tracker = new ProgressTracker();

  // Banner
  console.log("");
  console.log(`${BOLD}  +==================================+${NC}`);
  console.log(`${BOLD}  |          Gyro Loop               |${NC}`);
  console.log(`${BOLD}  +==================================+${NC}`);
  console.log(`  ${DIM}Default agent: ${config.defaultAgent}${NC}`);
  tracker.showProgressBar(prd.countPassed(), prd.countStories());
  hr();

  // Start environment if configured
  const env = prd.getEnv();
  if (env) {
    envUp(env);
  }

  const startTime = Date.now();

  // Main loop
  while (true) {
    const story = prd.getNextStory();

    if (!story) {
      hr();

      // Run on_complete checkpoints
      for (const cpName of prd.getOnCompleteCheckpoints()) {
        runCheckpoint(cpName, prd, state, config.defaultAgent, tracker, config.maxRetries, config.progressFile);
      }

      // Stop environment
      if (env) envDown(env);

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      console.log("");
      ok(`${BOLD}All stories pass! Project complete.${NC} (${formatDuration(elapsed)})`);
      tracker.showProgressBar(prd.countPassed(), prd.countStories());
      tracker.showTotalUsage();
      console.log(`${DIM}Log: .gyro/gyro.log${NC}`);
      console.log(`${DIM}Progress: ${config.progressFile}${NC}`);
      return;
    }

    const steps = prd.getStoryPipelineSteps(story.id);
    const stepList = steps.join(" ");

    hr();
    log(`${BOLD}${story.id}${NC}: ${story.title}`);
    log(`Pipeline: ${stepList}`);
    tracker.showProgressBar(prd.countPassed(), prd.countStories());

    state.setCurrentStory(story.id);
    tracker.resetStory();

    const storyStart = Date.now();
    const result = runStoryPipeline(
      story.id,
      prd,
      state,
      config.defaultAgent,
      tracker,
      config.maxRetries
    );

    const storyElapsed = Math.floor((Date.now() - storyStart) / 1000);

    if (result.shipped) {
      // Commit
      if (prd.useWorkBranches()) {
        git.createStoryBranch(story.id);
      }
      const summary = state.getWorkSummary()?.split("\n")[0] ?? "";
      git.gitAdd();
      git.gitCommit(`feat(${story.id}): ${summary || "implementation complete"}`);
      log(`  Committed on ${git.currentBranch()}`);

      ok(`${story.id} SHIPPED on attempt (${formatDuration(storyElapsed)})`);
      tracker.showStoryUsage();
      prd.markStoryPassed(story.id);

      // Append to progress
      appendFileSync(
        config.progressFile,
        `---\n[${story.id}] Completed on ${new Date().toISOString()}\n` +
          `${state.getWorkSummary() ?? ""}\n\n`
      );

      // Run checkpoints after this story
      if (prd.hasCheckpoints()) {
        for (const cpName of prd.getCheckpointNames()) {
          if (prd.shouldRunCheckpointAfter(story.id, cpName)) {
            runCheckpoint(cpName, prd, state, config.defaultAgent, tracker, config.maxRetries, config.progressFile);
          }
        }
      }
    } else {
      const totalElapsed = Math.floor((Date.now() - startTime) / 1000);
      fail(`${story.id} FAILED after ${config.maxRetries} attempts (${formatDuration(storyElapsed)})`);
      tracker.showStoryUsage();
      tracker.showTotalUsage();
      fail("Last review feedback:");
      console.log(state.getReviewFeedback() ?? "(none)");
      console.log("");
      // Stop environment
      if (env) envDown(env);

      fail(`Stopping. Fix the issue and run: npx tsx src/index.ts --from ${story.id}`);
      fail(`Total time: ${formatDuration(totalElapsed)}`);
      process.exit(1);
    }
  }
}
