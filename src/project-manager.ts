import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from "fs";
import { join, resolve } from "path";
import type Database from "better-sqlite3";
import type { DbProject } from "./db.js";
import * as db from "./db.js";
import { getTemplate } from "./templates.js";

export interface Project {
  id: string;
  name: string;
  status: "created" | "converting" | "running" | "completed" | "failed" | "stopped";
  dir: string;
  tech?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  progress?: { passed: number; total: number };
  currentStory?: string;
}

function dbToProject(row: DbProject): Project {
  return {
    id: row.id,
    name: row.name,
    status: row.status as Project["status"],
    dir: row.dir,
    tech: row.tech ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error ?? undefined,
  };
}

export class ProjectManager {
  private database: Database.Database;

  constructor(database: Database.Database) {
    this.database = database;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  createProject(name: string, dir: string, tech?: string, templateOverride?: string): Project {
    const id = this.slugify(name);
    if (db.getProject(this.database, id)) {
      throw new Error(`Project "${id}" already exists`);
    }

    const template = getTemplate(tech, templateOverride);
    const resolvedDir = resolve(dir);

    mkdirSync(resolvedDir, { recursive: true });

    // Copy default prompts
    this.copyPrompts(resolvedDir);

    const project = db.createProject(this.database, id, name, resolvedDir, tech, template.default_pipeline);
    db.setProjectConfig(this.database, id, template);

    return dbToProject(project);
  }

  registerProject(name: string, dir: string, opts?: { tech?: string; templateOverride?: string }): Project {
    const resolvedDir = resolve(dir);
    if (!existsSync(resolvedDir)) {
      throw new Error(`Directory not found: ${resolvedDir}`);
    }

    const id = this.slugify(name);
    if (db.getProject(this.database, id)) {
      throw new Error(`Project "${id}" already exists`);
    }

    // Copy prompts only if .gyro/prompts doesn't exist yet
    const promptsDir = join(resolvedDir, ".gyro", "prompts");
    if (!existsSync(promptsDir)) {
      this.copyPrompts(resolvedDir);
    }

    const template = getTemplate(opts?.tech, opts?.templateOverride);
    const project = db.createProject(this.database, id, name, resolvedDir, opts?.tech, template.default_pipeline);
    db.setProjectConfig(this.database, id, template);

    return dbToProject(project);
  }

  private copyPrompts(projectDir: string) {
    const promptsDir = join(projectDir, ".gyro", "prompts");
    mkdirSync(promptsDir, { recursive: true });

    // Copy from brain's own prompts as defaults
    const brainPrompts = resolve(".gyro/prompts");
    if (existsSync(brainPrompts)) {
      const files = readdirSync(brainPrompts).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const src = join(brainPrompts, file);
        const dst = join(promptsDir, file);
        if (!existsSync(dst)) {
          cpSync(src, dst);
        }
      }
    }
  }

  getProject(id: string): Project | undefined {
    const row = db.getProject(this.database, id);
    if (!row) return undefined;
    const project = dbToProject(row);

    // Add progress from tasks
    const progress = db.getTaskProgress(this.database, id);
    if (progress.total > 0) {
      project.progress = { passed: progress.shipped, total: progress.total };
    }

    return project;
  }

  listProjects(): Project[] {
    return db.listProjects(this.database).map((row) => {
      const project = dbToProject(row);
      const progress = db.getTaskProgress(this.database, row.id);
      if (progress.total > 0) {
        project.progress = { passed: progress.shipped, total: progress.total };
      }
      return project;
    });
  }

  updateProject(id: string, updates: Partial<Pick<Project, "status" | "error" | "name">>) {
    db.updateProject(this.database, id, updates as any);
  }

  refreshProgress(id: string): { passed: number; total: number; currentStory?: string } | undefined {
    const project = db.getProject(this.database, id);
    if (!project) return undefined;

    const progress = db.getTaskProgress(this.database, id);
    if (progress.total === 0) return undefined;

    return { passed: progress.shipped, total: progress.total };
  }
}
