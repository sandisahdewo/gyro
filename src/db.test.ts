import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  openDb, createProject, getProject, listProjects, updateProject,
  setProjectConfig, getProjectConfig,
  createEpic, getEpic, listEpics, updateEpicStatus,
  createTask, getTask, listTasks, listTasksByEpic, getNextPendingTask,
  updateTaskStatus, incrementTaskAttempt, markTaskShipped, markTaskFailed,
  checkEpicCompletion, getTaskProgress, getEpicProgress,
  logEvent,
  createChatSession, getChatSession, getChatSessionByEpic, getLatestChatSessionByEpic,
  listChatSessionsByEpic, finishChatSession, reactivateChatSession, deleteChatSession,
  addChatMessage, listChatMessages,
} from "./db.js";
import type { TemplateConfig } from "./templates.js";

const TEMPLATE: TemplateConfig = {
  pipelines: { setup: ["work", "review"], "backend-tdd": { steps: ["test", "work", "review"], test_lock: { test_cmd: "npm test", file_pattern: "*.test.ts", verify_red: true, verify_green: true } } },
  models: { work: "claude:sonnet" },
  checkpoints: {},
  default_pipeline: "backend-tdd",
};

function freshDb(): Database.Database {
  return openDb(":memory:");
}

describe("db", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  describe("projects", () => {
    it("creates and gets a project", () => {
      const p = createProject(db, "test", "Test Project", "/tmp/test", "node");
      expect(p.id).toBe("test");
      expect(p.name).toBe("Test Project");
      expect(p.status).toBe("created");
      expect(p.dir).toBe("/tmp/test");
      expect(p.tech).toBe("node");

      const got = getProject(db, "test");
      expect(got).toEqual(p);
    });

    it("lists projects", () => {
      createProject(db, "a", "A", "/tmp/a");
      createProject(db, "b", "B", "/tmp/b");
      const list = listProjects(db);
      expect(list).toHaveLength(2);
    });

    it("updates project", () => {
      createProject(db, "test", "Test", "/tmp/test");
      updateProject(db, "test", { status: "running" });
      const p = getProject(db, "test")!;
      expect(p.status).toBe("running");
    });
  });

  describe("project_config", () => {
    it("sets and gets config", () => {
      createProject(db, "test", "Test", "/tmp/test");
      setProjectConfig(db, "test", TEMPLATE);
      const config = getProjectConfig(db, "test")!;
      expect(config.pipelines).toEqual(TEMPLATE.pipelines);
      expect(config.models).toEqual(TEMPLATE.models);
    });
  });

  describe("epics", () => {
    beforeEach(() => {
      createProject(db, "p1", "P1", "/tmp/p1");
    });

    it("creates and lists epics", () => {
      const e = createEpic(db, "p1", "Auth system", "Build auth with OAuth");
      expect(e.id).toBe("epic-01");
      expect(e.status).toBe("backlog");

      const e2 = createEpic(db, "p1", "Dashboard", "Build dashboard");
      expect(e2.id).toBe("epic-02");

      const list = listEpics(db, "p1");
      expect(list).toHaveLength(2);
    });

    it("updates epic status", () => {
      createEpic(db, "p1", "Auth", "Auth desc");
      updateEpicStatus(db, "p1", "epic-01", "implementing");
      const e = getEpic(db, "p1", "epic-01")!;
      expect(e.status).toBe("implementing");
    });
  });

  describe("tasks", () => {
    beforeEach(() => {
      createProject(db, "p1", "P1", "/tmp/p1");
      setProjectConfig(db, "p1", TEMPLATE);
    });

    it("creates and gets tasks", () => {
      const t = createTask(db, "p1", {
        id: "task-01",
        title: "Setup project",
        pipeline: "setup",
        acceptance_criteria: ["project builds"],
        priority: 1,
      });
      expect(t.id).toBe("task-01");
      expect(t.status).toBe("pending");
      expect(t.acceptance_criteria).toEqual(["project builds"]);
    });

    it("gets next pending task by priority", () => {
      createTask(db, "p1", { id: "task-02", title: "Second", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2 });
      createTask(db, "p1", { id: "task-01", title: "First", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1 });

      const next = getNextPendingTask(db)!;
      expect(next.id).toBe("task-01");
    });

    it("marks tasks shipped and failed", () => {
      createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1 });
      markTaskShipped(db, "p1", "task-01");
      expect(getTask(db, "p1", "task-01")!.status).toBe("shipped");

      createTask(db, "p1", { id: "task-02", title: "T2", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2 });
      markTaskFailed(db, "p1", "task-02", "some error");
      const t2 = getTask(db, "p1", "task-02")!;
      expect(t2.status).toBe("failed");
      expect(t2.error).toBe("some error");
    });

    it("increments attempt", () => {
      createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1 });
      incrementTaskAttempt(db, "p1", "task-01");
      incrementTaskAttempt(db, "p1", "task-01");
      expect(getTask(db, "p1", "task-01")!.attempt).toBe(2);
    });

    it("lists tasks by epic", () => {
      createEpic(db, "p1", "Auth", "Auth desc");
      createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1, epic_id: "epic-01" });
      createTask(db, "p1", { id: "task-02", title: "T2", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2 });

      const epicTasks = listTasksByEpic(db, "p1", "epic-01");
      expect(epicTasks).toHaveLength(1);
      expect(epicTasks[0].id).toBe("task-01");
    });

    it("computes task progress", () => {
      createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1 });
      createTask(db, "p1", { id: "task-02", title: "T2", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2 });
      markTaskShipped(db, "p1", "task-01");

      const progress = getTaskProgress(db, "p1");
      expect(progress.total).toBe(2);
      expect(progress.shipped).toBe(1);
      expect(progress.pending).toBe(1);
    });
  });

  describe("epic completion", () => {
    beforeEach(() => {
      createProject(db, "p1", "P1", "/tmp/p1");
      setProjectConfig(db, "p1", TEMPLATE);
      createEpic(db, "p1", "Auth", "Auth desc");
      updateEpicStatus(db, "p1", "epic-01", "implementing");
    });

    it("marks epic done when all tasks shipped", () => {
      createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1, epic_id: "epic-01" });
      createTask(db, "p1", { id: "task-02", title: "T2", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2, epic_id: "epic-01" });

      markTaskShipped(db, "p1", "task-01");
      expect(checkEpicCompletion(db, "p1", "epic-01")).toBe(false);

      markTaskShipped(db, "p1", "task-02");
      expect(checkEpicCompletion(db, "p1", "epic-01")).toBe(true);
      expect(getEpic(db, "p1", "epic-01")!.status).toBe("done");
    });

    it("marks epic failed when some tasks fail and rest are done", () => {
      createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1, epic_id: "epic-01" });
      createTask(db, "p1", { id: "task-02", title: "T2", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2, epic_id: "epic-01" });

      markTaskShipped(db, "p1", "task-01");
      markTaskFailed(db, "p1", "task-02", "oops");
      checkEpicCompletion(db, "p1", "epic-01");
      expect(getEpic(db, "p1", "epic-01")!.status).toBe("failed");
    });
  });

  describe("events", () => {
    it("logs events", () => {
      createProject(db, "p1", "P1", "/tmp/p1");
      logEvent(db, { project_id: "p1", type: "test", payload: { foo: "bar" } });
      const events = db.prepare("SELECT * FROM events WHERE project_id = ?").all("p1") as any[];
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].payload)).toEqual({ foo: "bar" });
    });
  });

  describe("chat sessions", () => {
    beforeEach(() => {
      createProject(db, "p1", "P1", "/tmp/p1");
      createEpic(db, "p1", "Auth", "Auth desc");
    });

    it("creates and retrieves a chat session", () => {
      const session = createChatSession(db, "sess-1", "p1", "epic-01");
      expect(session.id).toBe("sess-1");
      expect(session.project_id).toBe("p1");
      expect(session.epic_id).toBe("epic-01");
      expect(session.status).toBe("active");

      const found = getChatSessionByEpic(db, "p1", "epic-01");
      expect(found).toBeDefined();
      expect(found!.id).toBe("sess-1");
    });

    it("returns undefined when no active session exists", () => {
      const found = getChatSessionByEpic(db, "p1", "epic-01");
      expect(found).toBeUndefined();
    });

    it("finishes a session and excludes it from active lookup", () => {
      createChatSession(db, "sess-1", "p1", "epic-01");
      finishChatSession(db, "sess-1");

      const found = getChatSessionByEpic(db, "p1", "epic-01");
      expect(found).toBeUndefined();
    });

    it("returns the latest active session when multiple exist", () => {
      createChatSession(db, "sess-1", "p1", "epic-01");
      finishChatSession(db, "sess-1");
      createChatSession(db, "sess-2", "p1", "epic-01");

      const found = getChatSessionByEpic(db, "p1", "epic-01");
      expect(found!.id).toBe("sess-2");
    });

    it("getLatestChatSessionByEpic finds finished sessions", () => {
      createChatSession(db, "sess-1", "p1", "epic-01");
      finishChatSession(db, "sess-1");

      expect(getChatSessionByEpic(db, "p1", "epic-01")).toBeUndefined();

      const found = getLatestChatSessionByEpic(db, "p1", "epic-01");
      expect(found).toBeDefined();
      expect(found!.id).toBe("sess-1");
      expect(found!.status).toBe("finished");
    });

    it("getChatSession retrieves by id", () => {
      createChatSession(db, "sess-1", "p1", "epic-01");
      const found = getChatSession(db, "sess-1");
      expect(found).toBeDefined();
      expect(found!.id).toBe("sess-1");
      expect(getChatSession(db, "nonexistent")).toBeUndefined();
    });

    it("listChatSessionsByEpic returns all sessions", () => {
      createChatSession(db, "sess-1", "p1", "epic-01");
      createChatSession(db, "sess-2", "p1", "epic-01");
      finishChatSession(db, "sess-1");

      const list = listChatSessionsByEpic(db, "p1", "epic-01");
      expect(list).toHaveLength(2);
      const ids = list.map((s) => s.id).sort();
      expect(ids).toEqual(["sess-1", "sess-2"]);
      // One active, one finished
      expect(list.find((s) => s.id === "sess-1")!.status).toBe("finished");
      expect(list.find((s) => s.id === "sess-2")!.status).toBe("active");
    });

    it("reactivateChatSession sets status back to active", () => {
      createChatSession(db, "sess-1", "p1", "epic-01");
      finishChatSession(db, "sess-1");
      expect(getChatSession(db, "sess-1")!.status).toBe("finished");

      reactivateChatSession(db, "sess-1");
      expect(getChatSession(db, "sess-1")!.status).toBe("active");
    });

    it("deleteChatSession removes session and its messages", () => {
      createChatSession(db, "sess-1", "p1", "epic-01");
      addChatMessage(db, "sess-1", "user", "hello");
      addChatMessage(db, "sess-1", "assistant", "hi");

      deleteChatSession(db, "sess-1");
      expect(getChatSession(db, "sess-1")).toBeUndefined();
      expect(listChatMessages(db, "sess-1")).toEqual([]);
    });
  });

  describe("chat messages", () => {
    beforeEach(() => {
      createProject(db, "p1", "P1", "/tmp/p1");
      createEpic(db, "p1", "Auth", "Auth desc");
      createChatSession(db, "sess-1", "p1", "epic-01");
    });

    it("adds and lists messages in order", () => {
      addChatMessage(db, "sess-1", "user", "How should we build auth?");
      addChatMessage(db, "sess-1", "assistant", "Let me suggest an approach...");
      addChatMessage(db, "sess-1", "user", "Sounds good, what about OAuth?");

      const messages = listChatMessages(db, "sess-1");
      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("How should we build auth?");
      expect(messages[1].role).toBe("assistant");
      expect(messages[2].role).toBe("user");
    });

    it("returns the created message with id", () => {
      const msg = addChatMessage(db, "sess-1", "user", "Hello");
      expect(msg.id).toBeGreaterThan(0);
      expect(msg.session_id).toBe("sess-1");
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("Hello");
    });

    it("returns empty array for session with no messages", () => {
      const messages = listChatMessages(db, "sess-1");
      expect(messages).toEqual([]);
    });
  });
});
