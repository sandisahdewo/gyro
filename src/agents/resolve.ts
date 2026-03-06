import { execSync } from "child_process";
import type { AgentType, ResolvedModel } from "../types.js";

const MODEL_ALIASES: Record<AgentType, Record<string, string>> = {
  claude: {
    opus: "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5-20251001",
  },
  codex: {
    opus: "gpt-5.3-codex",
    sonnet: "gpt-5.3-codex",
    haiku: "gpt-5.3-codex",
  },
};

function expandModelAlias(agent: AgentType, alias: string): string {
  return MODEL_ALIASES[agent]?.[alias] ?? alias;
}

function isAgentAvailable(agent: string): boolean {
  try {
    execSync(`which ${agent}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function requireAgent(agent: AgentType) {
  if (!isAgentAvailable(agent)) {
    const installHint =
      agent === "claude"
        ? "npm i -g @anthropic-ai/claude-code"
        : "npm i -g @openai/codex";
    throw new Error(`${agent} CLI not found. Install: ${installHint}`);
  }
}

export function resolveDefaultAgent(preference: string): AgentType {
  if (preference === "claude" || preference === "codex") {
    requireAgent(preference);
    return preference;
  }
  if (preference === "auto") {
    if (isAgentAvailable("claude")) return "claude";
    if (isAgentAvailable("codex")) return "codex";
    throw new Error(
      "No AI CLI found. Install one of:\n" +
        "  Claude Code: npm i -g @anthropic-ai/claude-code\n" +
        "  Codex CLI:   npm i -g @openai/codex"
    );
  }
  throw new Error(`Unknown agent: ${preference} (expected: claude, codex, auto)`);
}

export function resolveModel(
  config: string | undefined,
  defaultAgent: AgentType
): ResolvedModel {
  if (!config) {
    return { agent: defaultAgent, model: "", label: defaultAgent };
  }

  let agent: AgentType;
  let modelAlias: string;

  if (config.includes(":")) {
    const [a, m] = config.split(":", 2);
    agent = a as AgentType;
    modelAlias = m;
  } else {
    agent = defaultAgent;
    modelAlias = config;
  }

  requireAgent(agent);
  const model = expandModelAlias(agent, modelAlias);
  const label = `${agent}:${modelAlias}`;

  return { agent, model, label };
}

export function buildCommand(agent: AgentType, model: string): string {
  switch (agent) {
    case "codex":
      return `codex exec -s danger-full-access${model ? ` -m ${model}` : ""}`;
    case "claude":
      return `claude -p --dangerously-skip-permissions --output-format json${model ? ` --model ${model}` : ""}`;
    default:
      throw new Error(`Unknown agent: ${agent}`);
  }
}
