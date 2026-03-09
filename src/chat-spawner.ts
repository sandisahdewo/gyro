import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentType } from "./types.js";
import type { DbProject, DbEpic, DbProjectConfig } from "./db.js";

export interface ChatSpawnerEvents {
  chunk: (sessionId: string, line: string) => void;
  done: (sessionId: string, code: number | null) => void;
  spawn_error: (sessionId: string, err: Error) => void;
}

interface ActiveProcess {
  proc: ChildProcess;
  sessionId: string;
}

export interface SessionResult {
  code: number | null;
  error?: string;
  chunks: string[];
  agent: AgentType;
  externalSessionId?: string;
}

export interface ChatModel {
  agent: AgentType;
  model: string;
  label: string;
}

const CHAT_MODELS: Record<string, ChatModel> = {
  claude: { agent: "claude", model: "claude-opus-4-6", label: "claude" },
  codex:  { agent: "codex",  model: "gpt-5.3-codex",   label: "codex" },
  "gpt-5.4": { agent: "codex", model: "gpt-5.4", label: "gpt-5.4" },
};

/** Parse a model string for planning chat sessions. */
export function parseChatModel(modelStr: string | undefined): ChatModel {
  const key = modelStr ?? "claude";
  const found = CHAT_MODELS[key];
  if (!found) {
    const allowed = Object.keys(CHAT_MODELS).join(", ");
    throw new Error(`Invalid chat model: "${modelStr}". Allowed: ${allowed}`);
  }
  return found;
}

export function buildSystemPrompt(project: DbProject, epic: DbEpic, config: DbProjectConfig | undefined): string {
  const pipelines = config ? Object.keys(config.pipelines).join(", ") : "none configured";

  const lines = [
    `You are helping plan an epic for the project "${project.name}".`,
    `Tech stack: ${project.tech ?? "not specified"}`,
    "",
    `Epic: ${epic.title}`,
    `Description: ${epic.description}`,
    "",
    `Available pipelines: ${pipelines}`,
    "",
    "Your job is to help refine this epic into a solid implementation plan.",
    "Ask clarifying questions when the requirements are ambiguous.",
    "Consider edge cases, architecture decisions, and testing strategy.",
    "When the user is satisfied, produce a clear plan summary with actionable tasks.",
    "",
    "CRITICAL RULES — NEVER VIOLATE:",
    `- Your working directory is ${project.dir}. This is the ONLY project you are working on.`,
    "- NEVER read, reference, or explore files outside this directory.",
    "- NEVER access parent directories (../) or any other project.",
    "- Use ONLY relative paths when reading files (e.g. 'src/index.ts').",
    "- If you see references to other projects in environment info, IGNORE them — they are not relevant.",
  ];

  // Include the target project's CLAUDE.md if it exists
  const claudeMdPath = join(project.dir, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    try {
      const content = readFileSync(claudeMdPath, "utf-8");
      lines.push("", "--- Project Instructions (CLAUDE.md) ---", content);
    } catch {
      // ignore read errors
    }
  }

  return lines.join("\n");
}

function buildClaudeArgs(sessionId: string, isResume: boolean, systemPrompt: string | undefined, model: string): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format", "stream-json",
    "--max-turns", "1",
    "--permission-mode", "plan",
    "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch",
    "--setting-sources", "user,local",
  ];

  if (model) {
    args.push("--model", model);
  }

  if (isResume) {
    args.push("--resume", sessionId);
  } else {
    args.push("--session-id", sessionId);
  }

  if (systemPrompt && !isResume) {
    args.push("--append-system-prompt", systemPrompt);
  }

  return args;
}

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractChunkError(chunks: string[]): string | undefined {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const parsed = parseJsonLine(chunks[i]);
    if (parsed?.type === "error" && typeof parsed.message === "string") {
      return parsed.message;
    }
  }
  return undefined;
}

function buildCodexArgs(sessionId: string | undefined, isResume: boolean, _systemPrompt: string | undefined, model: string): string[] {
  if (isResume) {
    if (!sessionId) {
      throw new Error("Codex resume requires an external session id");
    }
    // codex exec resume <sessionId> <prompt> -- prompt is written to stdin
    const args = [
      "exec", "resume", sessionId,
      "-",  // read prompt from stdin
      "--json",
      "-s", "read-only",
    ];
    if (model) {
      args.push("-m", model);
    }
    return args;
  }

  const args = [
    "exec",
    "-",  // read prompt from stdin
    "--json",
    "-s", "read-only",
  ];

  if (model) {
    args.push("-m", model);
  }

  return args;
}

export class ChatSpawner extends EventEmitter {
  private active = new Map<string, ActiveProcess>();
  private results = new Map<string, SessionResult>();

  isActive(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Check if any of the given session IDs has an in-flight process */
  hasActiveAmong(sessionIds: string[]): string | undefined {
    for (const id of sessionIds) {
      if (this.active.has(id)) return id;
    }
    return undefined;
  }

  getResult(sessionId: string): SessionResult | undefined {
    return this.results.get(sessionId);
  }

  clearResult(sessionId: string): void {
    this.results.delete(sessionId);
  }

  send(sessionId: string, message: string, opts: {
    isResume: boolean;
    systemPrompt?: string;
    projectDir?: string;
    agent?: AgentType;
    model?: string;
    resumeSessionId?: string;
  }): void {
    if (this.active.has(sessionId)) {
      throw new Error("Session already has an in-flight message");
    }

    // Clear any previous result for this session
    this.results.delete(sessionId);

    const agent = opts.agent ?? "claude";
    const model = opts.model ?? "";

    let command: string;
    let args: string[];

    if (agent === "codex") {
      command = "codex";
      args = buildCodexArgs(opts.resumeSessionId, opts.isResume, opts.systemPrompt, model);
    } else {
      command = "claude";
      args = buildClaudeArgs(opts.resumeSessionId ?? sessionId, opts.isResume, opts.systemPrompt, model);
    }

    const proc = spawn(command, args, {
      cwd: opts.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.active.set(sessionId, { proc, sessionId });

    let stderrBuf = "";
    let stdoutBuf = "";
    const chunks: string[] = [];
    let externalSessionId = agent === "claude" ? sessionId : undefined;

    const pushChunk = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      chunks.push(trimmed);
      if (agent === "codex") {
        const parsed = parseJsonLine(trimmed);
        if (parsed?.type === "thread.started" && typeof parsed.thread_id === "string") {
          externalSessionId = parsed.thread_id;
        }
      }
      this.emit("chunk", sessionId, trimmed);
    };

    const flushStdout = () => {
      const trimmed = stdoutBuf.trim();
      if (trimmed) {
        pushChunk(trimmed);
      }
      stdoutBuf = "";
    };

    proc.stdout!.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      let newlineIdx = stdoutBuf.indexOf("\n");
      while (newlineIdx >= 0) {
        const line = stdoutBuf.slice(0, newlineIdx);
        stdoutBuf = stdoutBuf.slice(newlineIdx + 1);
        pushChunk(line);
        newlineIdx = stdoutBuf.indexOf("\n");
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
    });

    proc.on("close", (code) => {
      flushStdout();
      if (this.active.get(sessionId)?.proc === proc) {
        this.active.delete(sessionId);
      }
      const result: SessionResult = { code, chunks, agent, externalSessionId };
      if (code !== 0) {
        result.error = stderrBuf.trim() || extractChunkError(chunks);
      }
      if (result.error) {
        this.emit("spawn_error", sessionId, new Error(`${agent} exited ${code}: ${result.error}`));
      }
      this.results.set(sessionId, result);
      this.emit("done", sessionId, code);
    });

    proc.on("error", (err) => {
      if (this.active.get(sessionId)?.proc === proc) {
        this.active.delete(sessionId);
      }
      this.results.set(sessionId, { code: null, error: err.message, chunks, agent, externalSessionId });
      this.emit("spawn_error", sessionId, err);
      this.emit("done", sessionId, null);
    });

    // Build the message to send via stdin
    let stdinMessage = message;
    if (opts.projectDir) {
      stdinMessage = `[Project: ${opts.projectDir} — only access files within this directory, use relative paths only]\n\n${message}`;
    }
    // For codex new sessions, prepend system prompt since codex doesn't have --append-system-prompt
    if (agent === "codex" && opts.systemPrompt && !opts.isResume) {
      stdinMessage = `${opts.systemPrompt}\n\n---\n\n${stdinMessage}`;
    }

    proc.stdin!.write(stdinMessage);
    proc.stdin!.end();
  }

  abort(sessionId: string): boolean {
    const entry = this.active.get(sessionId);
    if (!entry) return false;
    entry.proc.kill("SIGTERM");
    return true;
  }
}
