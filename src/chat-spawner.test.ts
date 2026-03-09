import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatSpawner, buildSystemPrompt } from "./chat-spawner.js";
import type { DbProject, DbEpic, DbProjectConfig } from "./db.js";

describe("buildSystemPrompt", () => {
  const project: DbProject = {
    id: "p1", name: "My App", status: "created", dir: "/tmp/app",
    tech: "node", default_pipeline: "setup",
    created_at: "", updated_at: "", error: null,
  };

  const epic: DbEpic = {
    id: "epic-01", project_id: "p1", title: "Auth system",
    description: "Build OAuth login", status: "backlog",
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
      models: null, checkpoints: null, env: null, work_branches: 0,
    };
    const prompt = buildSystemPrompt(project, epic, config);
    expect(prompt).toContain("setup, backend-tdd");
  });
});

describe("ChatSpawner", () => {
  let spawner: ChatSpawner;

  beforeEach(() => {
    spawner = new ChatSpawner();
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

  it("abort returns true and kills active process", () => {
    const killFn = vi.fn();
    (spawner as any).active.set("sess-1", {
      proc: { kill: killFn },
      sessionId: "sess-1",
    });

    expect(spawner.abort("sess-1")).toBe(true);
    expect(killFn).toHaveBeenCalledWith("SIGTERM");
    expect(spawner.isActive("sess-1")).toBe(false);
  });
});
