import { execSync } from "child_process";
import type { DbProjectConfig } from "./db.js";

export interface DecomposedTask {
  title: string;
  acceptance_criteria: string[];
  pipeline: string;
  priority: number;
}

const DECOMPOSITION_PROMPT = `IMPORTANT: You are being used as a pure text converter. Do NOT use any tools.
Do NOT read files. Do NOT write files. Do NOT run commands.
Your ONLY job is to print raw JSON to stdout. Nothing else.

You are an AI task decomposer. Given an epic (a high-level feature description),
break it down into small, executable tasks that an AI coding agent can implement one at a time.

## Rules

### Task Sizing
- Each task should be completable in a single AI context window
- A task should touch at most 3-4 files
- Order tasks by dependency (earlier tasks first = lower priority number)

### Pipeline Classification
Classify each task's pipeline based on its content:
- "backend-tdd" — API endpoints, business logic, data access, server-side code
- "frontend" — UI components, pages, client-side code, styling
- "setup" — project scaffolding, config files, dependency setup, infrastructure

### Acceptance Criteria
- Must be specific and machine-verifiable
- Keep criteria terse — verifiable assertions only
- Do NOT include infrastructure criteria (tests pass, builds succeed, etc.)
- For backend tasks: describe endpoints, inputs, outputs, error cases
- For frontend tasks: describe UI elements and E2E test actions

### Output Format
CRITICAL: Your entire response must be ONLY the raw JSON array.
No markdown code fences. No explanation. Start with [ and end with ].

[
  {
    "title": "Short imperative title",
    "acceptance_criteria": ["criterion 1", "criterion 2"],
    "pipeline": "backend-tdd",
    "priority": 1
  }
]`;

function extractJsonArray(text: string): DecomposedTask[] {
  let cleaned = text.replace(/^```json?\s*$/gm, "").replace(/^```\s*$/gm, "");

  try { return JSON.parse(cleaned); } catch {}

  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try { return JSON.parse(cleaned.slice(firstBracket, lastBracket + 1)); } catch {}
  }

  throw new Error("Failed to parse decomposition output as JSON array");
}

export function decompose(
  epicTitle: string,
  epicDescription: string,
  config: DbProjectConfig
): DecomposedTask[] {
  const availablePipelines = Object.keys(config.pipelines).join(", ");

  const prompt = `${DECOMPOSITION_PROMPT}

## Available Pipelines
${availablePipelines}

## Epic to Decompose

**Title:** ${epicTitle}

**Description:**
${epicDescription}`;

  let rawResult: string;
  try {
    rawResult = execSync("claude -p --model haiku --max-turns 1", {
      input: prompt,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err: any) {
    throw new Error(`Claude CLI failed during decomposition: ${err.message}`);
  }

  const tasks = extractJsonArray(rawResult);

  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("Decomposition produced no tasks");
  }

  // Validate and fix pipelines
  const validPipelines = new Set(Object.keys(config.pipelines));
  for (const task of tasks) {
    if (!validPipelines.has(task.pipeline)) {
      task.pipeline = "setup"; // fallback
    }
    if (!Array.isArray(task.acceptance_criteria) || task.acceptance_criteria.length === 0) {
      task.acceptance_criteria = [task.title];
    }
  }

  // Ensure priorities are sequential
  tasks.sort((a, b) => a.priority - b.priority);
  tasks.forEach((t, i) => { t.priority = i + 1; });

  return tasks;
}
