import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { spawn } from "child_process";
import { ChatSpawner, buildSystemPrompt, parseChatModel } from "./chat-spawner.js";
import type { DbProject, DbEpic, DbProjectConfig } from "./db.js";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.kill = vi.fn();
  return proc;
}

describe("buildSystemPrompt", () => {
  const project: DbProject = {
    id: "p1", name: "My App", status: "created", dir: "/tmp/app",
    tech: "node", default_pipeline: "setup",
    created_at: "", updated_at: "", error: null,
  };

  const epic: DbEpic = {
    id: "epic-01", project_id: "p1", title: "Auth system",
    description: "Build OAuth login", plan: null, status: "backlog",
    created_at: "", updated_at: "",
  };

  it("includes project and epic details", () => {
    const prompt = buildSystemPrompt(project, epic, undefined);
    expect(prompt).toContain("My App");
    expect(prompt).toContain("Auth system");
    expect(prompt).toContain("Build OAuth login");
    expect(prompt).toContain("node");
  });

  it("includes pipeline names from config", () => {
    const config: DbProjectConfig = {
      project_id: "p1",
      pipelines: { setup: { steps: ["work"] } as any, "backend-tdd": { steps: ["test", "work"] } as any },
      models: null, checkpoints: null, env: null,
    };
    const prompt = buildSystemPrompt(project, epic, config);
    expect(prompt).toContain("setup, backend-tdd");
  });
});

describe("parseChatModel", () => {
  it("defaults to claude opus 4.6 when undefined", () => {
    const m = parseChatModel(undefined);
    expect(m.agent).toBe("claude");
    expect(m.model).toBe("claude-opus-4-6");
    expect(m.label).toBe("claude");
  });

  it("parses 'claude' as opus 4.6", () => {
    const m = parseChatModel("claude");
    expect(m.agent).toBe("claude");
    expect(m.model).toBe("claude-opus-4-6");
  });

  it("parses 'codex' as gpt-5.3-codex", () => {
    const m = parseChatModel("codex");
    expect(m.agent).toBe("codex");
    expect(m.model).toBe("gpt-5.3-codex");
  });

  it("parses 'gpt-5.4' as codex-backed gpt-5.4", () => {
    const m = parseChatModel("gpt-5.4");
    expect(m.agent).toBe("codex");
    expect(m.model).toBe("gpt-5.4");
    expect(m.label).toBe("gpt-5.4");
  });

  it("rejects unknown models", () => {
    expect(() => parseChatModel("gemini")).toThrow("Invalid chat model");
    expect(() => parseChatModel("claude:sonnet")).toThrow("Invalid chat model");
  });
});

describe("ChatSpawner", () => {
  let spawner: ChatSpawner;

  beforeEach(() => {
    spawner = new ChatSpawner();
    vi.mocked(spawn).mockReset();
  });

  it("tracks active state", () => {
    expect(spawner.isActive("sess-1")).toBe(false);
  });

  it("rejects concurrent messages on same session", () => {
    // We can't easily spawn a real process in unit tests,
    // but we can verify the guard by mocking the active map
    (spawner as any).active.set("sess-1", { proc: {}, sessionId: "sess-1" });

    expect(() => {
      spawner.send("sess-1", "hello", { isResume: false });
    }).toThrow("Session already has an in-flight message");
  });

  it("hasActiveAmong returns the active session id", () => {
    expect(spawner.hasActiveAmong(["a", "b"])).toBeUndefined();

    (spawner as any).active.set("b", { proc: {}, sessionId: "b" });
    expect(spawner.hasActiveAmong(["a", "b"])).toBe("b");
    expect(spawner.hasActiveAmong(["a", "c"])).toBeUndefined();
  });

  it("abort returns false for non-existent session", () => {
    expect(spawner.abort("nonexistent")).toBe(false);
  });

  it("buffers split codex JSONL output and captures the external thread id", () => {
    const proc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc as any);

    spawner.send("sess-1", "hello", {
      isResume: false,
      agent: "codex",
      model: "gpt-5.3-codex",
    });

    proc.stdout.write('{"type":"thread.started","thread_id":"thread-');
    proc.stdout.write('123"}\n{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}\n');
    proc.emit("close", 0);

    const result = spawner.getResult("sess-1");
    expect(result).toBeDefined();
    expect(result!.chunks).toEqual([
      '{"type":"thread.started","thread_id":"thread-123"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"hello"}}',
    ]);
    expect(result!.externalSessionId).toBe("thread-123");
    expect(result!.agent).toBe("codex");
  });

  it("uses the provider resume id for codex resumes", () => {
    const proc = createFakeProcess();
    vi.mocked(spawn).mockReturnValue(proc as any);

    spawner.send("sess-1", "continue", {
      isResume: true,
      agent: "codex",
      model: "gpt-5.3-codex",
      resumeSessionId: "thread-123",
    });

    expect(spawn).toHaveBeenCalledWith(
      "codex",
      ["exec", "resume", "thread-123", "-", "--json", "-s", "read-only", "-m", "gpt-5.3-codex"],
      expect.any(Object),
    );
  });

  it("abort returns true, signals the process, and keeps the session active until close", () => {
    const proc = createFakeProcess();
    (spawner as any).active.set("sess-1", {
      proc,
      sessionId: "sess-1",
    });

    expect(spawner.abort("sess-1")).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
    expect(spawner.isActive("sess-1")).toBe(true);
  });
});
