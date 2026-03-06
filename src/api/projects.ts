import { Router, type Request, type Response } from "express";
import { existsSync } from "fs";
import { join } from "path";
import type { ProjectManager } from "../project-manager.js";
import type { ExecutionQueue } from "../queue.js";
import type { EventBus } from "../event-bus.js";
import type { ProgressEvent, Story } from "../types.js";
import { PrdFile } from "../prd.js";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

export function createProjectRouter(pm: ProjectManager, queue: ExecutionQueue, eventBus?: EventBus): Router {
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

  // Register an existing project directory
  router.post("/register", (req: Request, res: Response) => {
    const { name, dir, plan, tech } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!dir || typeof dir !== "string") {
      res.status(400).json({ error: "dir is required (absolute path to existing project)" });
      return;
    }

    try {
      const project = pm.registerProject(name, dir, { plan, tech });
      res.status(201).json({
        id: project.id,
        name: project.name,
        status: project.status,
        dir: project.dir,
        progress: project.progress,
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

  // SSE event stream
  router.get("/:id/events", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    if (!eventBus) {
      res.status(501).json({ error: "event streaming not available" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send buffered events (catch-up)
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const recent = eventBus.getRecentEvents(projectId, lastEventId);
    for (const event of recent) {
      res.write(`id: ${event.timestamp}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }

    // Stream new events
    const onProgress = (event: ProgressEvent) => {
      if (event.projectId === projectId) {
        res.write(`id: ${event.timestamp}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };

    eventBus.on("progress", onProgress);

    req.on("close", () => {
      eventBus.removeListener("progress", onProgress);
    });
  });

  // Add a task (story) to an existing project
  router.post("/:id/tasks", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const prdPath = join(project.dir, ".gyro", "prd.json");
    if (!existsSync(prdPath)) {
      res.status(409).json({ error: "project has no prd.json yet — run the project first so the plan gets converted" });
      return;
    }

    const { title, pipeline, acceptance_criteria, plan_ref } = req.body;

    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (!acceptance_criteria || !Array.isArray(acceptance_criteria) || acceptance_criteria.length === 0) {
      res.status(400).json({ error: "acceptance_criteria is required (non-empty array)" });
      return;
    }

    try {
      const prd = new PrdFile(prdPath);

      // Auto-generate id and priority
      const maxPriority = prd.stories.reduce((max, s) => Math.max(max, s.priority), 0);
      const storyNum = prd.stories.length + 1;
      const id = `story-${String(storyNum).padStart(2, "0")}`;

      // Avoid id collision
      let finalId = id;
      let counter = storyNum;
      while (prd.getStory(finalId)) {
        counter++;
        finalId = `story-${String(counter).padStart(2, "0")}`;
      }

      const story: Story = {
        id: finalId,
        title,
        pipeline: pipeline || "setup",
        acceptance_criteria,
        passes: false,
        priority: maxPriority + 1,
      };
      if (plan_ref) story.plan_ref = plan_ref;

      prd.data.stories.push(story);
      prd.save();

      // Update project progress
      pm.refreshProgress(projectId);

      res.status(201).json(story);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Execution status snapshot
  router.get("/:id/status", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const liveStatus = eventBus?.getStatus(projectId);
    if (liveStatus) {
      res.json(liveStatus);
      return;
    }

    // Fallback to ProjectManager data
    const progress = pm.refreshProgress(projectId);
    res.json({
      projectId,
      running: project.status === "running" || project.status === "converting",
      progress: progress ?? project.progress,
      storyId: progress?.currentStory ?? project.currentStory,
    });
  });

  return router;
}
