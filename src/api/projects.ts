import { Router, type Request, type Response } from "express";
import type Database from "better-sqlite3";
import type { ProjectManager } from "../project-manager.js";
import type { EngineLoop } from "../engine-loop.js";
import type { EventBus } from "../event-bus.js";
import type { ProgressEvent } from "../types.js";
import * as db from "../db.js";
import { decompose } from "../decomposer.js";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

function paramEpicId(req: Request): string {
  const id = req.params.epicId;
  return Array.isArray(id) ? id[0] : id;
}

export function createProjectRouter(pm: ProjectManager, engineLoop: EngineLoop, eventBus: EventBus, database: Database.Database): Router {
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
    }));
    res.json({ projects });
  });

  // Create a project
  router.post("/", (req: Request, res: Response) => {
    const { name, dir, tech, template } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!dir || typeof dir !== "string") {
      res.status(400).json({ error: "dir is required (path to project directory)" });
      return;
    }

    try {
      const project = pm.createProject(name, dir, tech, template);
      const config = db.getProjectConfig(database, project.id);
      res.status(201).json({
        id: project.id,
        name: project.name,
        status: project.status,
        dir: project.dir,
        createdAt: project.createdAt,
        config: config ? {
          pipelines: Object.keys(config.pipelines),
          default_pipeline: project.status,
        } : undefined,
      });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // Register an existing project directory
  router.post("/register", (req: Request, res: Response) => {
    const { name, dir, tech, template } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!dir || typeof dir !== "string") {
      res.status(400).json({ error: "dir is required (absolute path to existing project)" });
      return;
    }

    try {
      const project = pm.registerProject(name, dir, { tech, templateOverride: template });
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
      error: project.error,
    });
  });

  // Get project config
  router.get("/:id/config", (req: Request, res: Response) => {
    const projectId = paramId(req);
    if (!pm.getProject(projectId)) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const config = db.getProjectConfig(database, projectId);
    if (!config) {
      res.status(404).json({ error: "no config found for project" });
      return;
    }

    res.json({
      project_id: config.project_id,
      pipelines: config.pipelines,
      models: config.models,
      checkpoints: config.checkpoints,
      env: config.env,
    });
  });

  // Update project config (partial merge)
  router.patch("/:id/config", (req: Request, res: Response) => {
    const projectId = paramId(req);
    if (!pm.getProject(projectId)) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const existing = db.getProjectConfig(database, projectId);
    if (!existing) {
      res.status(404).json({ error: "no config found for project" });
      return;
    }

    const { pipelines, models, checkpoints, env } = req.body;

    const merged = {
      pipelines: pipelines ?? existing.pipelines,
      models: models ?? existing.models ?? {},
      checkpoints: checkpoints ?? existing.checkpoints ?? {},
      default_pipeline: Object.keys(pipelines ?? existing.pipelines)[0] ?? "setup",
    };

    db.setProjectConfig(
      database,
      projectId,
      merged,
      env !== undefined ? env : existing.env ?? undefined,
    );

    const updated = db.getProjectConfig(database, projectId)!;
    res.json({
      project_id: updated.project_id,
      pipelines: updated.pipelines,
      models: updated.models,
      checkpoints: updated.checkpoints,
      env: updated.env,
    });
  });

  // --- Epics ---

  // Create epic
  router.post("/:id/epics", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const { title, description } = req.body;
    if (!title || typeof title !== "string") {
      res.status(400).json({ error: "title is required" });
      return;
    }
    if (!description || typeof description !== "string") {
      res.status(400).json({ error: "description is required" });
      return;
    }

    try {
      const epic = db.createEpic(database, projectId, title, description);
      res.status(201).json(epic);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List epics
  router.get("/:id/epics", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const epics = db.listEpics(database, projectId).map((epic) => {
      const progress = db.getEpicProgress(database, projectId, epic.id);
      return { ...epic, progress };
    });
    res.json({ epics });
  });

  // Update epic
  router.patch("/:id/epics/:epicId", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    const epic = db.getEpic(database, projectId, epicId);
    if (!epic) {
      res.status(404).json({ error: "epic not found" });
      return;
    }

    const { title, description, plan, status } = req.body;
    const updates: Partial<Pick<db.DbEpic, "title" | "description" | "plan" | "status">> = {};

    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (plan !== undefined) updates.plan = plan;
    if (status !== undefined) updates.status = status;

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "no fields to update" });
      return;
    }

    db.updateEpic(database, projectId, epicId, updates);

    const updated = db.getEpic(database, projectId, epicId);
    res.json(updated);
  });

  // Draft plan from chat sessions (AI-assisted merge)
  router.post("/:id/epics/:epicId/draft-plan", async (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const epic = db.getEpic(database, projectId, epicId);
    if (!epic) {
      res.status(404).json({ error: "epic not found" });
      return;
    }

    // Get sessions to include (optional filter, defaults to all)
    const { session_ids } = req.body;
    let sessions = db.listChatSessionsByEpic(database, projectId, epicId);
    if (Array.isArray(session_ids) && session_ids.length > 0) {
      const idSet = new Set(session_ids);
      sessions = sessions.filter((s) => idSet.has(s.id));
    }

    if (sessions.length === 0) {
      res.status(400).json({ error: "no chat sessions found for this epic" });
      return;
    }

    // Build conversation summary for each session
    const sessionSummaries = sessions.map((s) => {
      const messages = db.listChatMessages(database, s.id);
      const convo = messages.map((m) => `${m.role}: ${m.content}`).join("\n\n");
      return `### Session ${s.id} (${s.status})\n${convo}`;
    }).join("\n\n---\n\n");

    const prompt = `You are a technical planner. Given the chat sessions below about an epic, synthesize a clear, concise implementation plan.

## Epic
**Title:** ${epic.title}
**Description:** ${epic.description}

## Chat Sessions
${sessionSummaries}

## Instructions
- Extract the key decisions, architecture choices, and agreed approach from ALL sessions
- Resolve any contradictions (prefer the most recent session)
- Output a clear implementation plan with:
  - **Approach:** High-level technical approach
  - **Key Decisions:** Important choices made during planning
  - **Requirements:** What needs to be built (bullet points)
  - **Constraints:** Any limitations or rules agreed upon
- Be concise — this plan will be fed to a task decomposer
- Output ONLY the plan text, no preamble`;

    try {
      const { execSync } = await import("child_process");
      const result = execSync("claude -p --model haiku --max-turns 1", {
        input: prompt,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: 10 * 1024 * 1024,
      });

      res.json({ plan: result.trim() });
    } catch (err: any) {
      res.status(500).json({ error: `Failed to draft plan: ${err.message}` });
    }
  });

  // Approve plan → decompose into tasks (epic → ready, tasks visible but not executed)
  // User moves epic to "implementing" to start execution
  router.post("/:id/epics/:epicId/approve", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const epic = db.getEpic(database, projectId, epicId);
    if (!epic) {
      res.status(404).json({ error: "epic not found" });
      return;
    }

    if (!epic.plan) {
      res.status(400).json({ error: "epic has no plan — save a plan first before approving" });
      return;
    }

    const config = db.getProjectConfig(database, projectId);
    if (!config) {
      res.status(500).json({ error: "project has no config" });
      return;
    }

    try {
      // Decompose plan into tasks
      db.updateEpicStatus(database, projectId, epicId, "planning");
      const decomposed = decompose(epic.title, epic.description, config, epic.plan);

      // Get existing task count for id generation
      const existingTasks = db.listTasks(database, projectId);
      const maxNum = existingTasks.reduce((max, t) => {
        const match = t.id.match(/task-(\d+)/);
        return match ? Math.max(max, parseInt(match[1])) : max;
      }, 0);

      const createdTasks: db.DbTask[] = [];
      for (let i = 0; i < decomposed.length; i++) {
        const d = decomposed[i];
        const taskId = `task-${String(maxNum + i + 1).padStart(2, "0")}`;
        const task = db.createTask(database, projectId, {
          id: taskId,
          title: d.title,
          pipeline: d.pipeline,
          acceptance_criteria: d.acceptance_criteria,
          priority: d.priority,
          epic_id: epicId,
        });
        createdTasks.push(task);
      }

      db.updateEpicStatus(database, projectId, epicId, "ready");

      db.logEvent(database, {
        project_id: projectId,
        epic_id: epicId,
        type: "epic_approved",
        payload: { taskCount: createdTasks.length },
      });

      res.status(201).json({
        epic: db.getEpic(database, projectId, epicId),
        tasks: createdTasks,
      });
    } catch (err: any) {
      db.updateEpicStatus(database, projectId, epicId, "failed");
      res.status(500).json({ error: err.message });
    }
  });

  // List tasks for a specific epic
  router.get("/:id/epics/:epicId/tasks", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    if (!pm.getProject(projectId)) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const epic = db.getEpic(database, projectId, epicId);
    if (!epic) {
      res.status(404).json({ error: "epic not found" });
      return;
    }

    const tasks = db.listTasksByEpic(database, projectId, epicId);
    res.json({ tasks });
  });

  // --- Tasks ---

  // List tasks
  router.get("/:id/tasks", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const tasks = db.listTasks(database, projectId);
    res.json({ tasks });
  });

  // Retry a single failed task
  router.post("/:id/tasks/:taskId/retry", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const taskId = req.params.taskId;
    if (!pm.getProject(projectId)) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const task = db.getTask(database, projectId, Array.isArray(taskId) ? taskId[0] : taskId);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    if (task.status !== "failed") {
      res.status(409).json({ error: `task status is '${task.status}', only failed tasks can be retried` });
      return;
    }

    db.updateTaskStatus(database, projectId, task.id, "pending");
    res.json({ status: "retrying", task: db.getTask(database, projectId, task.id) });
  });

  // Retry all failed tasks in an epic
  router.post("/:id/epics/:epicId/retry", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);
    if (!pm.getProject(projectId)) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const epic = db.getEpic(database, projectId, epicId);
    if (!epic) {
      res.status(404).json({ error: "epic not found" });
      return;
    }

    const tasks = db.listTasksByEpic(database, projectId, epicId);
    const failed = tasks.filter((t) => t.status === "failed");
    if (failed.length === 0) {
      res.status(409).json({ error: "no failed tasks to retry" });
      return;
    }

    for (const task of failed) {
      db.updateTaskStatus(database, projectId, task.id, "pending");
    }
    db.updateEpicStatus(database, projectId, epicId, "implementing");

    res.json({ status: "retrying", retriedCount: failed.length, epicId });
  });

  // Stop a single task (cancel if running, or pull from pending)
  router.post("/:id/tasks/:taskId/stop", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const taskId = req.params.taskId;
    if (!pm.getProject(projectId)) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const tid = Array.isArray(taskId) ? taskId[0] : taskId;
    const task = db.getTask(database, projectId, tid);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }

    if (task.status === "shipped") {
      res.status(409).json({ error: "task already shipped" });
      return;
    }

    // Kill the worker if this task is currently running
    engineLoop.stopTask(projectId, tid);

    db.updateTaskStatus(database, projectId, tid, "failed", "stopped by user");
    res.json({ status: "stopped", task: db.getTask(database, projectId, tid) });
  });

  // Stop an epic (cancel running task if it belongs to this epic, mark remaining pending as failed)
  router.post("/:id/epics/:epicId/stop", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);
    if (!pm.getProject(projectId)) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const epic = db.getEpic(database, projectId, epicId);
    if (!epic) {
      res.status(404).json({ error: "epic not found" });
      return;
    }

    const tasks = db.listTasksByEpic(database, projectId, epicId);
    const active = tasks.filter((t) => t.status === "pending" || t.status === "running");
    if (active.length === 0) {
      res.status(409).json({ error: "no active tasks to stop" });
      return;
    }

    // Kill worker if it's running a task from this epic
    for (const task of active) {
      if (task.status === "running") {
        engineLoop.stopTask(projectId, task.id);
      }
    }

    let stoppedCount = 0;
    for (const task of active) {
      db.updateTaskStatus(database, projectId, task.id, "failed", "stopped by user");
      stoppedCount++;
    }

    db.updateEpicStatus(database, projectId, epicId, "failed");
    res.json({ status: "stopped", stoppedCount, epicId });
  });

  // --- Execution ---

  // Run project (priority boost for pending tasks)
  router.post("/:id/run", (req: Request, res: Response) => {
    const project = pm.getProject(paramId(req));
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    // Boost priority of this project's pending tasks to be picked up next
    const tasks = db.listTasks(database, project.id);
    const pending = tasks.filter((t) => t.status === "pending");
    if (pending.length === 0) {
      res.status(409).json({ error: "no pending tasks to run" });
      return;
    }

    // Set all pending tasks to priority 0 (highest)
    for (const task of pending) {
      database.prepare("UPDATE tasks SET priority = 0 WHERE project_id = ? AND id = ?").run(project.id, task.id);
    }

    res.json({ status: "boosted", projectId: project.id, pendingCount: pending.length });
  });

  // Stop project
  router.post("/:id/stop", (req: Request, res: Response) => {
    const project = pm.getProject(paramId(req));
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    engineLoop.stopProject(project.id);
    res.json({ status: "stopping", projectId: project.id });
  });

  // Queue/engine status
  router.get("/_queue", (_req: Request, res: Response) => {
    res.json(engineLoop.getStatus());
  });

  // SSE event stream
  router.get("/:id/events", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const writeEvent = (event: ProgressEvent) =>
      res.write(`id: ${event.timestamp}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

    // Send buffered events (catch-up)
    const lastEventId = req.headers["last-event-id"] as string | undefined;
    const recent = eventBus.getRecentEvents(projectId, lastEventId);
    for (const event of recent) writeEvent(event);

    // Stream new events
    const onProgress = (event: ProgressEvent) => {
      if (event.projectId === projectId) writeEvent(event);
    };

    eventBus.on("progress", onProgress);

    req.on("close", () => {
      eventBus.removeListener("progress", onProgress);
    });
  });

  // Execution status snapshot
  router.get("/:id/status", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const liveStatus = eventBus.getStatus(projectId);
    if (liveStatus) {
      res.json(liveStatus);
      return;
    }

    const progress = pm.refreshProgress(projectId);
    res.json({
      projectId,
      running: project.status === "running",
      progress: progress ?? project.progress,
    });
  });

  return router;
}
