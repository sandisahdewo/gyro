import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDb, createProject, setProjectConfig, createTask, createEpic, updateEpicStatus, markTaskShipped, getEpic } from "./db.js";
import { DbTaskSource } from "./db-task-source.js";
import type { TemplateConfig } from "./templates.js";

const TEMPLATE: TemplateConfig = {
  pipelines: {
    setup: ["work", "review"],
    "backend-tdd": {
      steps: ["test", "work", "review"],
      test_lock: { test_cmd: "npm test", file_pattern: "*.test.ts", verify_red: true, verify_green: true },
    },
  },
  models: { work: "claude:sonnet", review: "claude:opus" },
  checkpoints: { "test-all": { cmd: "npm test", after: "each", on_complete: true } },
  default_pipeline: "backend-tdd",
};

describe("DbTaskSource", () => {
  let db: Database.Database;
  let source: DbTaskSource;

  beforeEach(() => {
    db = openDb(":memory:");
    createProject(db, "p1", "P1", "/tmp/p1", "node");
    setProjectConfig(db, "p1", TEMPLATE);
    source = new DbTaskSource(db, "p1");
  });

  it("returns sorted stories from tasks", () => {
    createTask(db, "p1", { id: "task-02", title: "Second", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2 });
    createTask(db, "p1", { id: "task-01", title: "First", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1 });

    const sorted = source.sortedStories();
    expect(sorted[0].id).toBe("task-01");
    expect(sorted[1].id).toBe("task-02");
  });

  it("getNextStory returns highest priority pending", () => {
    createTask(db, "p1", { id: "task-01", title: "First", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1 });
    createTask(db, "p1", { id: "task-02", title: "Second", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2 });

    markTaskShipped(db, "p1", "task-01");
    const next = source.getNextStory();
    expect(next?.id).toBe("task-02");
  });

  it("markStoryPassed marks task as shipped", () => {
    createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1 });
    source.markStoryPassed("task-01");
    const story = source.getStory("task-01");
    expect(story?.passes).toBe(true);
  });

  it("getPipelineSteps returns correct steps", () => {
    expect(source.getPipelineSteps("setup")).toEqual(["work", "review"]);
    expect(source.getPipelineSteps("backend-tdd")).toEqual(["test", "work", "review"]);
  });

  it("getTestLock returns test lock config", () => {
    const tl = source.getTestLock("backend-tdd");
    expect(tl?.test_cmd).toBe("npm test");
    expect(tl?.verify_red).toBe(true);
  });

  it("getModelConfig returns model", () => {
    expect(source.getModelConfig("work")).toBe("claude:sonnet");
    expect(source.getModelConfig("nonexistent")).toBeUndefined();
  });

  it("checkpoint methods work", () => {
    expect(source.hasCheckpoints()).toBe(true);
    expect(source.getCheckpointNames()).toContain("test-all");
    expect(source.shouldRunCheckpointAfter("task-01", "test-all")).toBe(true);
    expect(source.getOnCompleteCheckpoints()).toContain("test-all");
  });

  it("countStories and countPassed", () => {
    createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1 });
    createTask(db, "p1", { id: "task-02", title: "T2", pipeline: "setup", acceptance_criteria: ["ok"], priority: 2 });

    expect(source.countStories()).toBe(2);
    expect(source.countPassed()).toBe(0);

    markTaskShipped(db, "p1", "task-01");
    expect(source.countPassed()).toBe(1);
    expect(source.countRemaining()).toBe(1);
  });

  it("checks epic completion on markStoryPassed", () => {
    createEpic(db, "p1", "Auth", "Auth desc");
    updateEpicStatus(db, "p1", "epic-01", "implementing");
    createTask(db, "p1", { id: "task-01", title: "T1", pipeline: "setup", acceptance_criteria: ["ok"], priority: 1, epic_id: "epic-01" });

    source.markStoryPassed("task-01");
    const epic = getEpic(db, "p1", "epic-01");
    expect(epic?.status).toBe("done");
  });
});
