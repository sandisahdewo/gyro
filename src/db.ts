import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { PipelineConfig, Checkpoint, EnvConfig } from "./types.js";
import type { TemplateConfig } from "./templates.js";

export type ProjectStatus = "created" | "converting" | "running" | "completed" | "failed" | "stopped";
export type EpicStatus = "backlog" | "planning" | "ready" | "implementing" | "done" | "failed";
export type TaskStatus = "pending" | "running" | "shipped" | "failed";

export interface DbProject {
  id: string;
  name: string;
  status: ProjectStatus;
  dir: string;
  tech: string | null;
  default_pipeline: string;
  created_at: string;
  updated_at: string;
  error: string | null;
}

export interface DbProjectConfig {
  project_id: string;
  pipelines: Record<string, PipelineConfig>;
  models: Record<string, string> | null;
  checkpoints: Record<string, Checkpoint> | null;
  env: EnvConfig | null;
  work_branches: number;
}

export interface DbEpic {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: EpicStatus;
  created_at: string;
  updated_at: string;
}

export interface DbTask {
  id: string;
  project_id: string;
  epic_id: string | null;
  title: string;
  pipeline: string;
  plan_ref: string | null;
  acceptance_criteria: string[];
  status: TaskStatus;
  priority: number;
  attempt: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface DbEvent {
  id: number;
  project_id: string;
  task_id: string | null;
  epic_id: string | null;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  dir TEXT NOT NULL,
  tech TEXT,
  default_pipeline TEXT NOT NULL DEFAULT 'setup',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS project_config (
  project_id TEXT PRIMARY KEY,
  pipelines TEXT NOT NULL,
  models TEXT,
  checkpoints TEXT,
  env TEXT,
  work_branches INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS epics (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'backlog',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, project_id),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  epic_id TEXT,
  title TEXT NOT NULL,
  pipeline TEXT NOT NULL,
  plan_ref TEXT,
  acceptance_criteria TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, project_id),
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (epic_id, project_id) REFERENCES epics(id, project_id)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  task_id TEXT,
  epic_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(dbPath: string = "data/brain.db"): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// --- Projects ---

export function createProject(
  db: Database.Database,
  id: string,
  name: string,
  dir: string,
  tech?: string,
  defaultPipeline: string = "setup"
): DbProject {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO projects (id, name, status, dir, tech, default_pipeline, created_at, updated_at)
     VALUES (?, ?, 'created', ?, ?, ?, ?, ?)`
  ).run(id, name, dir, tech ?? null, defaultPipeline, now, now);
  return getProject(db, id)!;
}

export function getProject(db: Database.Database, id: string): DbProject | undefined {
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as DbProject | undefined;
}

export function listProjects(db: Database.Database): DbProject[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as DbProject[];
}

export function updateProject(db: Database.Database, id: string, updates: Partial<Pick<DbProject, "status" | "error" | "name" | "tech">>): void {
  const now = new Date().toISOString();
  const sets: string[] = ["updated_at = ?"];
  const values: unknown[] = [now];

  for (const [key, val] of Object.entries(updates)) {
    sets.push(`${key} = ?`);
    values.push(val ?? null);
  }
  values.push(id);
  db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

// --- Project Config ---

export function setProjectConfig(db: Database.Database, projectId: string, config: TemplateConfig, env?: EnvConfig, workBranches?: boolean): void {
  db.prepare(
    `INSERT OR REPLACE INTO project_config (project_id, pipelines, models, checkpoints, env, work_branches)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    projectId,
    JSON.stringify(config.pipelines),
    JSON.stringify(config.models),
    JSON.stringify(config.checkpoints),
    env ? JSON.stringify(env) : null,
    workBranches ? 1 : 0
  );
}

export function getProjectConfig(db: Database.Database, projectId: string): DbProjectConfig | undefined {
  const row = db.prepare("SELECT * FROM project_config WHERE project_id = ?").get(projectId) as any;
  if (!row) return undefined;
  return {
    project_id: row.project_id,
    pipelines: JSON.parse(row.pipelines),
    models: row.models ? JSON.parse(row.models) : null,
    checkpoints: row.checkpoints ? JSON.parse(row.checkpoints) : null,
    env: row.env ? JSON.parse(row.env) : null,
    work_branches: row.work_branches,
  };
}

// --- Epics ---

export function createEpic(db: Database.Database, projectId: string, title: string, description: string): DbEpic {
  const now = new Date().toISOString();
  // Generate epic id
  const count = (db.prepare("SELECT COUNT(*) as c FROM epics WHERE project_id = ?").get(projectId) as any).c;
  const id = `epic-${String(count + 1).padStart(2, "0")}`;

  db.prepare(
    `INSERT INTO epics (id, project_id, title, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'backlog', ?, ?)`
  ).run(id, projectId, title, description, now, now);
  return getEpic(db, projectId, id)!;
}

export function getEpic(db: Database.Database, projectId: string, epicId: string): DbEpic | undefined {
  return db.prepare("SELECT * FROM epics WHERE project_id = ? AND id = ?").get(projectId, epicId) as DbEpic | undefined;
}

export function listEpics(db: Database.Database, projectId: string): DbEpic[] {
  return db.prepare("SELECT * FROM epics WHERE project_id = ? ORDER BY created_at").all(projectId) as DbEpic[];
}

export function updateEpicStatus(db: Database.Database, projectId: string, epicId: string, status: EpicStatus): void {
  const now = new Date().toISOString();
  db.prepare("UPDATE epics SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?").run(status, now, projectId, epicId);
}

// --- Tasks ---

export function createTask(
  db: Database.Database,
  projectId: string,
  task: { id: string; title: string; pipeline: string; acceptance_criteria: string[]; priority: number; epic_id?: string; plan_ref?: string }
): DbTask {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO tasks (id, project_id, epic_id, title, pipeline, plan_ref, acceptance_criteria, status, priority, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?)`
  ).run(
    task.id, projectId, task.epic_id ?? null, task.title, task.pipeline,
    task.plan_ref ?? null, JSON.stringify(task.acceptance_criteria),
    task.priority, now, now
  );
  return getTask(db, projectId, task.id)!;
}

export function getTask(db: Database.Database, projectId: string, taskId: string): DbTask | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId) as any;
  if (!row) return undefined;
  return { ...row, acceptance_criteria: JSON.parse(row.acceptance_criteria) };
}

export function listTasks(db: Database.Database, projectId: string): DbTask[] {
  const rows = db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY priority").all(projectId) as any[];
  return rows.map((r) => ({ ...r, acceptance_criteria: JSON.parse(r.acceptance_criteria) }));
}

export function listTasksByEpic(db: Database.Database, projectId: string, epicId: string): DbTask[] {
  const rows = db.prepare("SELECT * FROM tasks WHERE project_id = ? AND epic_id = ? ORDER BY priority").all(projectId, epicId) as any[];
  return rows.map((r) => ({ ...r, acceptance_criteria: JSON.parse(r.acceptance_criteria) }));
}

export function getNextPendingTask(db: Database.Database): DbTask | undefined {
  const row = db.prepare(
    `SELECT * FROM tasks WHERE status = 'pending' ORDER BY priority ASC LIMIT 1`
  ).get() as any;
  if (!row) return undefined;
  return { ...row, acceptance_criteria: JSON.parse(row.acceptance_criteria) };
}

export function updateTaskStatus(db: Database.Database, projectId: string, taskId: string, status: TaskStatus, error?: string): void {
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE tasks SET status = ?, error = ?, updated_at = ? WHERE project_id = ? AND id = ?"
  ).run(status, error ?? null, now, projectId, taskId);
}

export function incrementTaskAttempt(db: Database.Database, projectId: string, taskId: string): void {
  db.prepare("UPDATE tasks SET attempt = attempt + 1 WHERE project_id = ? AND id = ?").run(projectId, taskId);
}

export function markTaskShipped(db: Database.Database, projectId: string, taskId: string): void {
  updateTaskStatus(db, projectId, taskId, "shipped");
}

export function markTaskFailed(db: Database.Database, projectId: string, taskId: string, error: string): void {
  updateTaskStatus(db, projectId, taskId, "failed", error);
}

export function checkEpicCompletion(db: Database.Database, projectId: string, epicId: string): boolean {
  const stats = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) as shipped,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM tasks WHERE project_id = ? AND epic_id = ?`
  ).get(projectId, epicId) as any;

  if (stats.total === 0) return false;

  if (stats.shipped === stats.total) {
    updateEpicStatus(db, projectId, epicId, "done");
    return true;
  }
  if (stats.failed > 0 && stats.shipped + stats.failed === stats.total) {
    updateEpicStatus(db, projectId, epicId, "failed");
  }
  return false;
}

export function getTaskProgress(db: Database.Database, projectId: string): { total: number; shipped: number; pending: number; running: number; failed: number } {
  const row = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) as shipped,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM tasks WHERE project_id = ?`
  ).get(projectId) as any;
  return { total: row.total, shipped: row.shipped, pending: row.pending, running: row.running, failed: row.failed };
}

export function getEpicProgress(db: Database.Database, projectId: string, epicId: string): { total: number; shipped: number; pending: number; failed: number } {
  const row = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) as shipped,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
     FROM tasks WHERE project_id = ? AND epic_id = ?`
  ).get(projectId, epicId) as any;
  return { total: row.total, shipped: row.shipped, pending: row.pending, failed: row.failed };
}

// --- Events ---

export function logEvent(db: Database.Database, event: { project_id: string; task_id?: string; epic_id?: string; type: string; payload: Record<string, unknown> }): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO events (project_id, task_id, epic_id, type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(event.project_id, event.task_id ?? null, event.epic_id ?? null, event.type, JSON.stringify(event.payload), now);
}
