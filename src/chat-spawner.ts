import { EventEmitter } from "events";
import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
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
  }): void {
    if (this.active.has(sessionId)) {
      throw new Error("Session already has an in-flight message");
    }

    // Clear any previous result for this session
    this.results.delete(sessionId);

    const args = [
      "-p",
      "--verbose",
      "--output-format", "stream-json",
      "--max-turns", "1",
      "--permission-mode", "plan",
      "--allowedTools", "Read,Glob,Grep,WebSearch,WebFetch",
      "--setting-sources", "user,local",
    ];

    if (opts.isResume) {
      // Resume existing session by ID
      args.push("--resume", sessionId);
    } else {
      // New session with specific ID
      args.push("--session-id", sessionId);
    }

    if (opts.systemPrompt && !opts.isResume) {
      args.push("--append-system-prompt", opts.systemPrompt);
    }

    const proc = spawn("claude", args, {
      cwd: opts.projectDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.active.set(sessionId, { proc, sessionId });

    let stderrBuf = "";
    const chunks: string[] = [];

    proc.stdout!.on("data", (data: Buffer) => {
      const text = data.toString();
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          chunks.push(trimmed);
          this.emit("chunk", sessionId, trimmed);
        }
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
    });

    proc.on("close", (code) => {
      this.active.delete(sessionId);
      const result: SessionResult = { code, chunks };
      if (code !== 0 && stderrBuf) {
        result.error = stderrBuf.trim();
        this.emit("spawn_error", sessionId, new Error(`claude exited ${code}: ${stderrBuf.trim()}`));
      }
      this.results.set(sessionId, result);
      this.emit("done", sessionId, code);
    });

    proc.on("error", (err) => {
      this.active.delete(sessionId);
      this.results.set(sessionId, { code: null, error: err.message, chunks });
      this.emit("spawn_error", sessionId, err);
      this.emit("done", sessionId, null);
    });

    // Write the user message to stdin with a directory scope reminder
    const scopedMessage = opts.projectDir
      ? `[Project: ${opts.projectDir} — only access files within this directory, use relative paths only]\n\n${message}`
      : message;
    proc.stdin!.write(scopedMessage);
    proc.stdin!.end();
  }

  abort(sessionId: string): boolean {
    const entry = this.active.get(sessionId);
    if (!entry) return false;
    entry.proc.kill("SIGTERM");
    this.active.delete(sessionId);
    return true;
  }
}
