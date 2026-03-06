import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync } from "fs";
import { join, resolve } from "path";
import type { PRD } from "./types.js";

export interface Project {
  id: string;
  name: string;
  status: "created" | "converting" | "running" | "completed" | "failed" | "stopped";
  dir: string;
  plan?: string;
  tech?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  progress?: { passed: number; total: number };
  currentStory?: string;
}

const PROJECTS_FILE = "projects.json";

export class ProjectManager {
  private baseDir: string;
  private projects: Map<string, Project> = new Map();

  constructor(baseDir: string = "projects") {
    this.baseDir = resolve(baseDir);
    mkdirSync(this.baseDir, { recursive: true });
    this.load();
  }

  private stateFile(): string {
    return join(this.baseDir, PROJECTS_FILE);
  }

  private load() {
    const file = this.stateFile();
    if (existsSync(file)) {
      const data: Project[] = JSON.parse(readFileSync(file, "utf-8"));
      for (const p of data) this.projects.set(p.id, p);
    }
  }

  private save() {
    writeFileSync(this.stateFile(), JSON.stringify([...this.projects.values()], null, 2) + "\n");
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  createProject(name: string, plan: string, tech?: string): Project {
    const id = this.slugify(name);
    if (this.projects.has(id)) {
      throw new Error(`Project "${id}" already exists`);
    }

    const dir = join(this.baseDir, id);
    mkdirSync(dir, { recursive: true });

    // Save plan
    writeFileSync(join(dir, "plan.md"), plan);

    // Copy default prompts
    this.copyPrompts(dir);

    const now = new Date().toISOString();
    const project: Project = {
      id,
      name,
      status: "created",
      dir,
      plan,
      tech,
      createdAt: now,
      updatedAt: now,
    };

    this.projects.set(id, project);
    this.save();
    return project;
  }

  /**
   * Register an existing project directory.
   * The directory must exist. If it has a prd.json, progress is read from it.
   * If it has a plan.md but no prd.json, conversion will happen on /run.
   * If plan is provided, it overwrites the existing plan.md (useful for adding new stories).
   */
  registerProject(name: string, dir: string, opts?: { plan?: string; tech?: string }): Project {
    const resolvedDir = resolve(dir);
    if (!existsSync(resolvedDir)) {
      throw new Error(`Directory not found: ${resolvedDir}`);
    }

    const id = this.slugify(name);
    if (this.projects.has(id)) {
      throw new Error(`Project "${id}" already exists`);
    }

    // Write plan if provided
    if (opts?.plan) {
      writeFileSync(join(resolvedDir, "plan.md"), opts.plan);
    }

    // Copy prompts only if .gyro/prompts doesn't exist yet
    const promptsDir = join(resolvedDir, ".gyro", "prompts");
    if (!existsSync(promptsDir)) {
      this.copyPrompts(resolvedDir);
    }

    // Determine initial status from existing state
    const prdPath = join(resolvedDir, ".gyro", "prd.json");
    const hasPrd = existsSync(prdPath);
    const hasPlan = existsSync(join(resolvedDir, "plan.md"));
    let status: Project["status"] = "created";
    let progress: { passed: number; total: number } | undefined;

    if (hasPrd) {
      try {
        const prd: PRD = JSON.parse(readFileSync(prdPath, "utf-8"));
        const total = prd.stories.length;
        const passed = prd.stories.filter((s) => s.passes).length;
        progress = { passed, total };
        // If all passed, mark as completed
        status = passed === total ? "completed" : "created";
      } catch {}
    }

    if (!hasPrd && !hasPlan && !opts?.plan) {
      throw new Error(`Directory has no plan.md or .gyro/prd.json: ${resolvedDir}`);
    }

    const now = new Date().toISOString();
    const project: Project = {
      id,
      name,
      status,
      dir: resolvedDir,
      tech: opts?.tech,
      createdAt: now,
      updatedAt: now,
      progress,
    };

    this.projects.set(id, project);
    this.save();
    return project;
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
    return this.projects.get(id);
  }

  listProjects(): Project[] {
    return [...this.projects.values()];
  }

  updateProject(id: string, updates: Partial<Project>) {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project "${id}" not found`);
    Object.assign(project, updates, { updatedAt: new Date().toISOString() });
    this.save();
  }

  /** Read current progress from the project's prd.json */
  refreshProgress(id: string): { passed: number; total: number; currentStory?: string } | undefined {
    const project = this.projects.get(id);
    if (!project) return undefined;

    const prdPath = join(project.dir, ".gyro", "prd.json");
    if (!existsSync(prdPath)) return undefined;

    try {
      const prd: PRD = JSON.parse(readFileSync(prdPath, "utf-8"));
      const total = prd.stories.length;
      const passed = prd.stories.filter((s) => s.passes).length;

      // Read current story from state
      const storyFile = join(project.dir, ".gyro", "state", "current-story.txt");
      const currentStory = existsSync(storyFile)
        ? readFileSync(storyFile, "utf-8").trim()
        : undefined;

      this.updateProject(id, { progress: { passed, total }, currentStory });
      return { passed, total, currentStory };
    } catch {
      return undefined;
    }
  }
}
