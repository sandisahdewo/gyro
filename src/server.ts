#!/usr/bin/env node

import express from "express";
import { ProjectManager } from "./project-manager.js";
import { ExecutionQueue } from "./queue.js";
import { createProjectRouter } from "./api/projects.js";

const PORT = parseInt(process.env.PORT ?? "7440", 10);
const PROJECTS_DIR = process.env.GYRO_PROJECTS_DIR ?? "projects";

const app = express();
app.use(express.json({ limit: "10mb" }));

// --- Init ---
const pm = new ProjectManager(PROJECTS_DIR);
const queue = new ExecutionQueue(pm);

// --- Routes ---
app.use("/projects", createProjectRouter(pm, queue));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", queue: queue.getStatus() });
});

// --- Start ---
app.listen(PORT, () => {
  console.log(`Brain API listening on http://localhost:${PORT}`);
  console.log(`Projects directory: ${PROJECTS_DIR}`);
  console.log("");
  console.log("Endpoints:");
  console.log(`  POST   /projects              Create a new project (plan + name)`);
  console.log(`  POST   /projects/register     Register an existing project directory`);
  console.log(`  GET    /projects              List all projects`);
  console.log(`  GET    /projects/:id          Get project details + progress`);
  console.log(`  POST   /projects/:id/run      Start execution`);
  console.log(`  POST   /projects/:id/stop     Stop execution`);
  console.log(`  GET    /projects/_queue       Queue status`);
  console.log(`  GET    /health                Health check`);
});
