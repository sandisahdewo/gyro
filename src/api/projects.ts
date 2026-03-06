import { Router, type Request, type Response } from "express";
import type { ProjectManager } from "../project-manager.js";
import type { ExecutionQueue } from "../queue.js";

function paramId(req: Request): string {
  const id = paramId(req);
  return Array.isArray(id) ? id[0] : id;
}

export function createProjectRouter(pm: ProjectManager, queue: ExecutionQueue): Router {
  const router = Router();

  // List all projects
  router.get("/", (_req: Request, res: Response) => {
    const projects = pm.listProjects().map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      progress: p.progress,
      currentStory: p.currentStory,
    }));
    res.json({ projects });
  });

  // Create a project
  router.post("/", (req: Request, res: Response) => {
    const { name, plan, tech } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!plan || typeof plan !== "string") {
      res.status(400).json({ error: "plan is required (markdown content)" });
      return;
    }

    try {
      const project = pm.createProject(name, plan, tech);
      res.status(201).json({
        id: project.id,
        name: project.name,
        status: project.status,
        dir: project.dir,
        createdAt: project.createdAt,
      });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // Get project details
  router.get("/:id", (req: Request, res: Response) => {
    const project = pm.getProject(paramId(req));
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    // Refresh progress from disk
    const progress = pm.refreshProgress(project.id);

    res.json({
      id: project.id,
      name: project.name,
      status: project.status,
      dir: project.dir,
      tech: project.tech,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      progress: progress ?? project.progress,
      currentStory: progress?.currentStory ?? project.currentStory,
      error: project.error,
    });
  });

  // Start execution
  router.post("/:id/run", (req: Request, res: Response) => {
    const project = pm.getProject(paramId(req));
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    if (project.status === "running" || project.status === "converting") {
      res.status(409).json({ error: "project is already running" });
      return;
    }

    try {
      const result = queue.enqueue(project.id, project.tech);
      res.json({ status: result, projectId: project.id });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // Stop execution
  router.post("/:id/stop", (req: Request, res: Response) => {
    const project = pm.getProject(paramId(req));
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const stopped = queue.stop(project.id);
    if (!stopped) {
      res.status(409).json({ error: "project is not running or queued" });
      return;
    }

    res.json({ status: "stopping", projectId: project.id });
  });

  // Get queue status
  router.get("/_queue", (_req: Request, res: Response) => {
    res.json(queue.getStatus());
  });

  return router;
}
