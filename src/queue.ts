import { fork, type ChildProcess } from "child_process";
import { join, resolve } from "path";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { ProjectManager } from "./project-manager.js";
import type { EventBus } from "./event-bus.js";

export interface QueueEntry {
  projectId: string;
  tech?: string;
}

export class ExecutionQueue {
  private running: { projectId: string; process: ChildProcess } | null = null;
  private queue: QueueEntry[] = [];
  private pm: ProjectManager;
  private eventBus?: EventBus;

  constructor(pm: ProjectManager, eventBus?: EventBus) {
    this.pm = pm;
    this.eventBus = eventBus;
  }

  enqueue(projectId: string, tech?: string): "running" | "queued" {
    if (this.running?.projectId === projectId) {
      throw new Error(`Project "${projectId}" is already running`);
    }
    if (this.queue.some((e) => e.projectId === projectId)) {
      throw new Error(`Project "${projectId}" is already queued`);
    }

    if (!this.running) {
      this.startProject(projectId, tech);
      return "running";
    }

    this.queue.push({ projectId, tech });
    return "queued";
  }

  stop(projectId: string): boolean {
    // Remove from queue if queued
    const idx = this.queue.findIndex((e) => e.projectId === projectId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.pm.updateProject(projectId, { status: "stopped" });
      return true;
    }

    // Stop running process
    if (this.running?.projectId === projectId) {
      // Write stop flag for graceful shutdown
      const project = this.pm.getProject(projectId);
      if (project) {
        const stopFlag = join(project.dir, ".gyro", "state", "stop-requested.txt");
        writeFileSync(stopFlag, new Date().toISOString());
      }
      // Also send SIGTERM as fallback
      this.running.process.kill("SIGTERM");
      return true;
    }

    return false;
  }

  getStatus(): { running: string | null; queued: string[] } {
    return {
      running: this.running?.projectId ?? null,
      queued: this.queue.map((e) => e.projectId),
    };
  }

  private startProject(projectId: string, tech?: string) {
    const project = this.pm.getProject(projectId);
    if (!project) throw new Error(`Project "${projectId}" not found`);

    // The worker script handles: convert plan → run engine
    const workerPath = resolve("src/worker.ts");

    const child = fork(workerPath, [], {
      cwd: project.dir,
      env: {
        ...process.env,
        GYRO_PROJECT_ID: projectId,
        GYRO_TECH_STACK: tech ?? project.tech ?? "",
        GYRO_BRAIN_DIR: resolve("."),
      },
      execArgv: ["--import", "tsx"],
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    this.running = { projectId, process: child };
    this.pm.updateProject(projectId, { status: "converting" });

    child.stdout?.on("data", (data: Buffer) => {
      process.stdout.write(`[${projectId}] ${data}`);
    });

    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[${projectId}] ${data}`);
    });

    child.on("message", (msg: any) => {
      if (msg.type === "status") {
        this.pm.updateProject(projectId, { status: msg.status });
      } else if (msg.type === "progress_event" && this.eventBus) {
        this.eventBus.publish(msg.event);
      }
    });

    child.on("exit", (code) => {
      const status = code === 0 ? "completed" : "failed";
      this.pm.updateProject(projectId, {
        status,
        error: code !== 0 ? `Worker exited with code ${code}` : undefined,
      });
      this.pm.refreshProgress(projectId);

      this.running = null;

      // Start next in queue
      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.startProject(next.projectId, next.tech);
      }
    });
  }
}
