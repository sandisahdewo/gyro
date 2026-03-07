import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type Database from "better-sqlite3";
import type { PRD } from "./types.js";
import * as db from "./db.js";
import type { TemplateConfig } from "./templates.js";

interface LegacyProject {
  id: string;
  name: string;
  status: string;
  dir: string;
  tech?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  progress?: { passed: number; total: number };
}

export function migrateFromJson(database: Database.Database, projectsDir: string = "projects"): number {
  const projectsFile = join(resolve(projectsDir), "projects.json");
  if (!existsSync(projectsFile)) return 0;

  // Check if DB already has projects
  const existing = db.listProjects(database);
  if (existing.length > 0) return 0;

  console.log("[migrate] Found projects.json, migrating to SQLite...");

  let migrated = 0;
  const projects: LegacyProject[] = JSON.parse(readFileSync(projectsFile, "utf-8"));

  for (const project of projects) {
    try {
      db.createProject(database, project.id, project.name, project.dir, project.tech);
      if (project.status !== "created") {
        db.updateProject(database, project.id, { status: project.status as any });
      }

      // Import prd.json if exists
      const prdPath = join(project.dir, ".gyro", "prd.json");
      if (existsSync(prdPath)) {
        const prd: PRD = JSON.parse(readFileSync(prdPath, "utf-8"));
        importPrdToDb(database, project.id, prd);
      }

      migrated++;
      console.log(`[migrate] Imported project: ${project.id}`);
    } catch (err: any) {
      console.warn(`[migrate] Failed to import ${project.id}: ${err.message}`);
    }
  }

  console.log(`[migrate] Done. Migrated ${migrated}/${projects.length} projects.`);
  return migrated;
}

export function importPrdToDb(database: Database.Database, projectId: string, prd: PRD): void {
  // Import config
  const templateConfig: TemplateConfig = {
    pipelines: prd.pipelines,
    models: prd.models ?? {},
    checkpoints: prd.checkpoints ?? {},
    default_pipeline: Object.keys(prd.pipelines)[0] ?? "setup",
  };
  db.setProjectConfig(database, projectId, templateConfig, prd.env, prd.work_branches);

  // Import stories as tasks
  for (const story of prd.stories) {
    db.createTask(database, projectId, {
      id: story.id,
      title: story.title,
      pipeline: story.pipeline,
      acceptance_criteria: story.acceptance_criteria,
      priority: story.priority,
      plan_ref: story.plan_ref,
    });

    if (story.passes) {
      db.markTaskShipped(database, projectId, story.id);
    }
  }
}
