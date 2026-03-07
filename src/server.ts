#!/usr/bin/env node

import express from "express";
import { openDb } from "./db.js";
import { ProjectManager } from "./project-manager.js";
import { EngineLoop } from "./engine-loop.js";
import { EventBus } from "./event-bus.js";
import { createProjectRouter } from "./api/projects.js";
import { migrateFromJson } from "./migrate.js";

const PORT = parseInt(process.env.PORT ?? "7440", 10);
const DB_PATH = process.env.GYRO_DB_PATH ?? "data/brain.db";
const PROJECTS_DIR = process.env.GYRO_PROJECTS_DIR ?? "projects";

const app = express();
app.use(express.json({ limit: "10mb" }));

// --- Init ---
const db = openDb(DB_PATH);
const eventBus = new EventBus();
const pm = new ProjectManager(db);
const engineLoop = new EngineLoop(db, eventBus);

// Migrate legacy projects.json if DB is empty
migrateFromJson(db, PROJECTS_DIR);

// --- Routes ---
app.use("/projects", createProjectRouter(pm, engineLoop, eventBus, db));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", engine: engineLoop.getStatus() });
});

// --- Start ---
app.listen(PORT, () => {
  engineLoop.start(); // auto-start polling on boot

  console.log(`Brain API listening on http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  console.log("");
  console.log("Endpoints:");
  console.log(`  POST   /projects                              Create a new project`);
  console.log(`  POST   /projects/register                     Register existing project`);
  console.log(`  GET    /projects                              List all projects`);
  console.log(`  GET    /projects/:id                          Get project details`);
  console.log(`  GET    /projects/:id/config                   Get project config`);
  console.log(`  PATCH  /projects/:id/config                   Update project config`);
  console.log(`  POST   /projects/:id/epics                    Create an epic`);
  console.log(`  GET    /projects/:id/epics                    List epics with progress`);
  console.log(`  PATCH  /projects/:id/epics/:epicId            Update epic`);
  console.log(`  POST   /projects/:id/epics/:epicId/implement  Decompose & execute epic`);
  console.log(`  POST   /projects/:id/epics/:epicId/retry      Retry failed epic tasks`);
  console.log(`  POST   /projects/:id/epics/:epicId/stop       Stop epic tasks`);
  console.log(`  POST   /projects/:id/tasks                    Add a task directly`);
  console.log(`  GET    /projects/:id/tasks                    List tasks`);
  console.log(`  POST   /projects/:id/tasks/:taskId/retry      Retry a failed task`);
  console.log(`  POST   /projects/:id/tasks/:taskId/stop       Stop a task`);
  console.log(`  POST   /projects/:id/run                      Priority boost pending tasks`);
  console.log(`  POST   /projects/:id/stop                     Stop execution`);
  console.log(`  GET    /projects/:id/events                   SSE event stream`);
  console.log(`  GET    /projects/:id/status                   Execution status`);
  console.log(`  GET    /projects/_queue                       Engine status`);
  console.log(`  GET    /health                                Health check`);
  console.log("");
  console.log("Engine auto-polling for pending tasks...");
});
