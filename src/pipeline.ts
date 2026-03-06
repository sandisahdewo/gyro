import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import type { AgentType, TokenUsage } from "./types.js";
import { PrdFile } from "./prd.js";
import { State } from "./state.js";
import { resolveModel, buildCommand } from "./agents/resolve.js";
import { runPostStepGate } from "./gates.js";
import { log, warn, ok, formatDuration, formatTokens, BOLD, DIM, NC } from "./log.js";
import { ProgressTracker } from "./progress.js";

export interface StepOutcome {
  success: boolean;
  usage?: TokenUsage;
}

function parseClaudeUsage(logPath: string): TokenUsage | undefined {
  try {
    const content = readFileSync(logPath, "utf-8");
    const data = JSON.parse(content);
    if (!data.usage) return undefined;
    return {
      inputTokens: data.usage.input_tokens ?? 0,
      outputTokens: data.usage.output_tokens ?? 0,
      cacheRead: data.usage.cache_read_input_tokens ?? 0,
    };
  } catch {
    return undefined;
  }
}

export function runStep(
  stepName: string,
  prd: PrdFile,
  state: State,
  defaultAgent: AgentType,
  tracker: ProgressTracker
): StepOutcome {
  const promptFile = `.gyro/prompts/${stepName}.md`;
  if (!existsSync(promptFile)) {
    throw new Error(`Prompt not found: ${promptFile}`);
  }

  const modelConfig = prd.getModelConfig(stepName);
  const resolved = resolveModel(modelConfig, defaultAgent);
  const cmd = buildCommand(resolved.agent, resolved.model);

  log(`  [${BOLD}${stepName}${NC}] Running (${resolved.label})...`);

  const stepLog = state.getStepLogPath(stepName);
  const stepStderr = state.getStepStderrPath(stepName);

  try {
    execSync(`${cmd} < "${promptFile}" > "${stepLog}" 2>"${stepStderr}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: "/bin/bash",
    });

    if (resolved.agent === "claude") {
      const usage = parseClaudeUsage(stepLog);
      if (usage) {
        tracker.addUsage(usage);
        const total = usage.inputTokens + usage.outputTokens;
        log(
          `  ${DIM}[${stepName}] ${formatTokens(usage.inputTokens)} in / ` +
            `${formatTokens(usage.outputTokens)} out (${formatTokens(total)} total)${NC}`
        );
      }
    }

    log(`  [${stepName}] Completed`);
    return { success: true };
  } catch {
    if (resolved.agent === "claude") {
      const usage = parseClaudeUsage(stepLog);
      if (usage) tracker.addUsage(usage);
    }

    warn(`  [${stepName}] Exited with non-zero status`);

    // Show tail of output for debugging
    try {
      if (resolved.agent === "claude" && existsSync(stepLog)) {
        const data = JSON.parse(readFileSync(stepLog, "utf-8"));
        if (data.result) {
          const lines = data.result.split("\n").slice(-20);
          console.log(`${DIM}${lines.join("\n")}${NC}`);
        }
      } else if (existsSync(stepLog)) {
        const content = readFileSync(stepLog, "utf-8");
        const lines = content.split("\n").slice(-20);
        console.log(`${DIM}${lines.join("\n")}${NC}`);
      }
    } catch {}

    try {
      if (existsSync(stepStderr)) {
        const stderr = readFileSync(stepStderr, "utf-8");
        const lines = stderr.split("\n").slice(-5);
        if (lines.some((l: string) => l.trim())) {
          console.log(`${DIM}${lines.join("\n")}${NC}`);
        }
      }
    } catch {}

    return { success: false };
  }
}

export interface PipelineResult {
  shipped: boolean;
}

export function runStoryPipeline(
  storyId: string,
  prd: PrdFile,
  state: State,
  defaultAgent: AgentType,
  tracker: ProgressTracker,
  maxRetries: number
): PipelineResult {
  const story = prd.getStory(storyId)!;
  const steps = prd.getStoryPipelineSteps(storyId);
  const testLock = prd.getStoryTestLock(storyId);
  const e2e = prd.getStoryE2e(storyId);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    log(`Attempt ${attempt}/${maxRetries}`);

    // Clear state for this attempt
    state.clearAttemptState();
    if (attempt === 1) {
      state.clearFirstAttemptState(storyId);
    }
    state.cleanStaleStepLogs(storyId);

    let stepFailed = false;

    for (const step of steps) {
      // Skip completed steps (crash-retry)
      if (state.isStepCompleted(storyId, step)) {
        log(`  [${step}] Already completed -- skipping`);
        continue;
      }

      const stepStart = Date.now();
      const outcome = runStep(step, prd, state, defaultAgent, tracker);
      const stepElapsed = Math.floor((Date.now() - stepStart) / 1000);

      if (!outcome.success) {
        warn(`  [${step}] Step crashed -- treating as REVISE (${formatDuration(stepElapsed)})`);
        stepFailed = true;
        break;
      }

      log(`  [${step}] Done (${formatDuration(stepElapsed)})`);

      // Run post-step gates
      if (!runPostStepGate(state, testLock, e2e, step)) {
        warn(`  [${step}] Gate failed -- treating as REVISE`);
        const feedback = state.getReviewFeedback();
        if (feedback) {
          console.log(`${DIM}${feedback.split("\n").slice(0, 20).join("\n")}${NC}`);
        }
        stepFailed = true;
        state.clearCompletedSteps(storyId);
        break;
      }

      state.markStepCompleted(storyId, step);

      // Check review result
      const result = state.getReviewResult();
      if (result === "REVISE") {
        warn(`  [${step}] -> REVISE`);
        const feedback = state.getReviewFeedback();
        if (feedback) {
          console.log(`${DIM}${feedback.split("\n").slice(0, 20).join("\n")}${NC}`);
        }
        stepFailed = true;
        state.clearCompletedSteps(storyId);
        break;
      }

      if (result === "SHIP") {
        state.clearReviewResult();
      }
    }

    if (!stepFailed) {
      return { shipped: true };
    }

    if (attempt === maxRetries) {
      return { shipped: false };
    }
  }

  return { shipped: false };
}
