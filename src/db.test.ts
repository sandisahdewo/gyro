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
});
