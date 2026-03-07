import type Database from "better-sqlite3";
import type { Story, PipelineConfig, PipelineObject, TestLock, E2eConfig, Checkpoint, EnvConfig } from "./types.js";
import * as db from "./db.js";

/**
 * Adapts the SQLite DB to match the PrdFile interface used by the engine.
 * This lets the engine run tasks from DB without changes to its core logic.
 */
export class DbTaskSource {
  private database: Database.Database;
  private projectId: string;
  private config: db.DbProjectConfig | undefined;

  constructor(database: Database.Database, projectId: string) {
    this.database = database;
    this.projectId = projectId;
    this.config = db.getProjectConfig(database, projectId);
  }

  // Re-read config from DB (in case it changed)
  private ensureConfig(): db.DbProjectConfig {
    if (!this.config) {
      this.config = db.getProjectConfig(this.database, this.projectId);
    }
    if (!this.config) {
      throw new Error(`No config found for project ${this.projectId}`);
    }
    return this.config;
  }

  private taskToStory(task: db.DbTask): Story {
    return {
      id: task.id,
      title: task.title,
      pipeline: task.pipeline,
      plan_ref: task.plan_ref ?? undefined,
      acceptance_criteria: task.acceptance_criteria,
      passes: task.status === "shipped",
      priority: task.priority,
    };
  }

  // --- PRD-compatible data property ---

  get data() {
    const config = this.ensureConfig();
    const tasks = db.listTasks(this.database, this.projectId);
    return {
      project: this.projectId,
      pipelines: config.pipelines,
      models: config.models ?? undefined,
      checkpoints: config.checkpoints ?? undefined,
      env: config.env ?? undefined,
      work_branches: config.work_branches ? true : undefined,
      stories: tasks.map((t) => this.taskToStory(t)),
    };
  }

  // --- Stories (tasks) ---

  get stories(): Story[] {
    return db.listTasks(this.database, this.projectId).map((t) => this.taskToStory(t));
  }

  sortedStories(): Story[] {
    return this.stories.sort((a, b) => a.priority - b.priority);
  }

  getNextStory(): Story | undefined {
    const tasks = db.listTasks(this.database, this.projectId);
    const pending = tasks
      .filter((t) => t.status === "pending")
      .sort((a, b) => a.priority - b.priority);
    return pending.length > 0 ? this.taskToStory(pending[0]) : undefined;
  }

  getStory(id: string): Story | undefined {
    const task = db.getTask(this.database, this.projectId, id);
    return task ? this.taskToStory(task) : undefined;
  }

  markStoryPassed(id: string) {
    db.markTaskShipped(this.database, this.projectId, id);
    // Check if parent epic is now complete
    const task = db.getTask(this.database, this.projectId, id);
    if (task?.epic_id) {
      db.checkEpicCompletion(this.database, this.projectId, task.epic_id);
    }
  }

  countStories(): number {
    return db.getTaskProgress(this.database, this.projectId).total;
  }

  countPassed(): number {
    return db.getTaskProgress(this.database, this.projectId).shipped;
  }

  countRemaining(): number {
    const p = db.getTaskProgress(this.database, this.projectId);
    return p.pending + p.running;
  }

  // Save is a no-op for DB source
  save() {}

  // --- Pipelines ---

  getPipelineConfig(name: string): PipelineConfig | undefined {
    return this.ensureConfig().pipelines[name];
  }

  getPipelineSteps(pipelineName: string): string[] {
    const config = this.ensureConfig().pipelines[pipelineName];
    if (!config) return [];
    if (Array.isArray(config)) return config;
    return (config as PipelineObject).steps;
  }

  getStoryPipelineSteps(storyId: string): string[] {
    const story = this.getStory(storyId);
    if (!story) return [];
    return this.getPipelineSteps(story.pipeline);
  }

  getTestLock(pipelineName: string): TestLock | undefined {
    const config = this.ensureConfig().pipelines[pipelineName];
    if (!config || Array.isArray(config)) return undefined;
    return (config as PipelineObject).test_lock;
  }

  hasTestLock(storyId: string): boolean {
    const story = this.getStory(storyId);
    if (!story) return false;
    return !!this.getTestLock(story.pipeline);
  }

  getStoryTestLock(storyId: string): TestLock | undefined {
    const story = this.getStory(storyId);
    if (!story) return undefined;
    return this.getTestLock(story.pipeline);
  }

  getE2e(pipelineName: string): E2eConfig | undefined {
    const config = this.ensureConfig().pipelines[pipelineName];
    if (!config || Array.isArray(config)) return undefined;
    return (config as PipelineObject).e2e;
  }

  getStoryE2e(storyId: string): E2eConfig | undefined {
    const story = this.getStory(storyId);
    if (!story) return undefined;
    return this.getE2e(story.pipeline);
  }

  // --- Models ---

  getModelConfig(stepName: string): string | undefined {
    return this.ensureConfig().models?.[stepName] ?? undefined;
  }

  // --- Checkpoints ---

  static readonly CHECKPOINT_ORDER = [
    "lint", "simplify", "test-all", "type-check", "build",
  ];

  get checkpoints(): Record<string, Checkpoint> {
    return this.ensureConfig().checkpoints ?? {};
  }

  hasCheckpoints(): boolean {
    const cp = this.ensureConfig().checkpoints;
    return !!cp && Object.keys(cp).length > 0;
  }

  getCheckpointNames(): string[] {
    const configured = this.checkpoints;
    const ordered = DbTaskSource.CHECKPOINT_ORDER.filter((name) => name in configured);
    const custom = Object.keys(configured).filter(
      (name) => !DbTaskSource.CHECKPOINT_ORDER.includes(name)
    );
    return [...ordered, ...custom];
  }

  shouldRunCheckpointAfter(storyId: string, checkpointName: string): boolean {
    const cp = this.checkpoints[checkpointName];
    if (!cp?.after) return false;
    if (cp.after === "each") return true;
    return cp.after.includes(storyId);
  }

  getOnCompleteCheckpoints(): string[] {
    return this.getCheckpointNames().filter(
      (name) => !!this.checkpoints[name]?.on_complete
    );
  }

  isStandalone(checkpointName: string): boolean {
    return !!this.checkpoints[checkpointName]?.standalone;
  }

  // --- Environment ---

  getEnv(): EnvConfig | undefined {
    return this.ensureConfig().env ?? undefined;
  }

  hasEnv(): boolean {
    return !!this.ensureConfig().env;
  }

  // --- Work branches ---

  useWorkBranches(): boolean {
    return !!this.ensureConfig().work_branches;
  }
}
