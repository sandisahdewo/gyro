import { fork, type ChildProcess } from "child_process";
import { resolve } from "path";
import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import * as db from "./db.js";

export interface EngineLoopStatus {
  running: boolean;
  currentTask: { projectId: string; taskId: string; title: string } | null;
  polling: boolean;
}

export class EngineLoop {
  private database: Database.Database;
  private eventBus: EventBus;
  private pollInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentProcess: ChildProcess | null = null;
  private currentTask: { projectId: string; taskId: string; title: string } | null = null;
  private stopping = new Set<string>();
  private polling = false;

  constructor(database: Database.Database, eventBus: EventBus, pollInterval: number = 5000) {
    this.database = database;
    this.eventBus = eventBus;
    this.pollInterval = pollInterval;
  }

  start() {
    if (this.timer) return;
    console.log(`[engine-loop] Started polling every ${this.pollInterval / 1000}s`);
    this.polling = true;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollInterval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.polling = false;
    if (this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
    }
  }

  stopProject(projectId: string) {
    this.stopping.add(projectId);
    if (this.currentTask?.projectId === projectId && this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
      this.currentTask = null;
      db.updateProject(this.database, projectId, { status: "stopped" });
    }
  }

  /** Kill the worker if it's currently running the given task. Returns true if killed. */
  stopTask(projectId: string, taskId: string): boolean {
    if (this.currentTask?.projectId === projectId && this.currentTask?.taskId === taskId && this.currentProcess) {
      this.currentProcess.kill("SIGTERM");
      this.currentProcess = null;
      this.currentTask = null;
      return true;
    }
    return false;
  }

  getStatus(): EngineLoopStatus {
    return {
      running: !!this.currentProcess,
      currentTask: this.currentTask,
      polling: this.polling,
    };
  }

  private poll() {
    if (this.currentProcess) return;

    const task = db.getNextPendingTask(this.database);
    if (!task) return;

    if (this.stopping.has(task.project_id)) {
      this.stopping.delete(task.project_id);
      return;
    }

    this.runTask(task);
  }

  private runTask(task: db.DbTask) {
    const project = db.getProject(this.database, task.project_id);
    if (!project) return;

    console.log(`[engine-loop] Picked up task ${task.id} (${task.title}) for project ${task.project_id}`);

    db.updateTaskStatus(this.database, task.project_id, task.id, "running");
    db.incrementTaskAttempt(this.database, task.project_id, task.id);
    db.updateProject(this.database, task.project_id, { status: "running" });

    db.logEvent(this.database, {
      project_id: task.project_id,
      task_id: task.id,
      epic_id: task.epic_id ?? undefined,
      type: "task_start",
      payload: { title: task.title, pipeline: task.pipeline },
    });

    this.currentTask = { projectId: task.project_id, taskId: task.id, title: task.title };

    const workerPath = resolve(import.meta.dirname, "task-worker.ts");

    const child = fork(workerPath, [], {
      env: {
        ...process.env,
        GYRO_PROJECT_ID: task.project_id,
        GYRO_TASK_ID: task.id,
        GYRO_DB_PATH: this.database.name,
        GYRO_BRAIN_DIR: resolve("."),
      },
      execArgv: ["--import", "tsx"],
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    this.currentProcess = child;

    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[${task.project_id}/${task.id}] ${data}`);
    });

    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[${task.project_id}/${task.id}] ${data}`);
    });

    child.on("message", (msg: any) => {
      if (msg.type === "progress_event") {
        this.eventBus.publish(msg.event);
      }
    });

    child.on("exit", (code) => {
      const success = code === 0;

      if (success) {
        db.markTaskShipped(this.database, task.project_id, task.id);
        db.logEvent(this.database, {
          project_id: task.project_id,
          task_id: task.id,
          epic_id: task.epic_id ?? undefined,
          type: "task_shipped",
          payload: {},
        });

        if (task.epic_id) {
          db.checkEpicCompletion(this.database, task.project_id, task.epic_id);
        }
      } else {
        db.markTaskFailed(this.database, task.project_id, task.id, `Worker exited with code ${code}`);
        db.logEvent(this.database, {
          project_id: task.project_id,
          task_id: task.id,
          epic_id: task.epic_id ?? undefined,
          type: "task_failed",
          payload: { code },
        });
      }

      const progress = db.getTaskProgress(this.database, task.project_id);
      if (progress.pending === 0 && progress.running === 0) {
        const newStatus = progress.failed > 0 ? "failed" : "completed";
        db.updateProject(this.database, task.project_id, { status: newStatus as any });
      }

      this.currentProcess = null;
      this.currentTask = null;

      this.poll();
    });

    child.on("error", (err: Error) => {
      console.error(`[engine-loop] Worker error for task ${task.id}:`, err.message);
      db.markTaskFailed(this.database, task.project_id, task.id, err.message);
      this.currentProcess = null;
      this.currentTask = null;
    });
  }
}
