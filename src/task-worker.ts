/**
 * Task worker process — runs a single task pipeline.
 * Spawned via child_process.fork() from engine-loop.
 * Receives config via env vars, opens its own SQLite connection.
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { DbTaskSource } from "./db-task-source.js";
import { State } from "./state.js";
import { resolveDefaultAgent } from "./agents/resolve.js";
import { initGitIfNeeded, runEngine } from "./engine.js";
import { setLogFile } from "./log.js";
import * as db from "./db.js";

const projectId = process.env.GYRO_PROJECT_ID!;
const taskId = process.env.GYRO_TASK_ID!;
const dbPath = process.env.GYRO_DB_PATH!;
const brainDir = process.env.GYRO_BRAIN_DIR!;

function sendEvent(event: Record<string, unknown>) {
  if (process.send) {
    process.send({
      type: "progress_event",
      event: { ...event, projectId, timestamp: new Date().toISOString() },
    });
  }
}

async function run() {
  const database = new Database(dbPath);
  database.pragma("journal_mode = WAL");

  const project = db.getProject(database, projectId);
  if (!project) {
    console.error(`[task-worker] Project ${projectId} not found`);
    process.exit(1);
  }

  const task = db.getTask(database, projectId, taskId);
  if (!task) {
    console.error(`[task-worker] Task ${taskId} not found`);
    process.exit(1);
  }

  const cwd = project.dir;
  console.log(`[task-worker] Running task ${taskId} (${task.title}) in ${cwd}`);

  const stateDir = join(cwd, ".gyro", "state");
  mkdirSync(stateDir, { recursive: true });

  const progressFile = join(cwd, ".gyro", "progress.txt");
  const logFile = join(cwd, ".gyro", "gyro.log");
  if (!existsSync(progressFile)) writeFileSync(progressFile, "");
  if (!existsSync(logFile)) writeFileSync(logFile, "");

  setLogFile(logFile);

  const taskSource = new DbTaskSource(database, projectId);
  const state = new State(stateDir);

  const defaultAgent = resolveDefaultAgent(process.env.GYRO_DEFAULT_AGENT ?? "auto");

  const checkpointContext = {
    epicId: task.epic_id ?? undefined,
    taskId: taskId,
    projectId: projectId,
  };

  process.chdir(cwd);

  initGitIfNeeded();
  runEngine(taskSource, state, {
    maxRetries: parseInt(process.env.GYRO_MAX_RETRIES ?? "5", 10),
    baseBranch: process.env.GYRO_BASE_BRANCH ?? "main",
    defaultAgent,
    prdPath: join(cwd, ".gyro", "prd.json"),
    progressFile,
    singleTask: taskId,
    checkpointContext,
  }, (event: Record<string, unknown>) => sendEvent(event));

  database.close();
}

run().catch((err) => {
  console.error(`[task-worker] Fatal error: ${err.message}`);
  process.exit(1);
});
