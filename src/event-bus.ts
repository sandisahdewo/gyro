import { EventEmitter } from "events";
import type { ProgressEvent, ExecutionStatus } from "./types.js";

const MAX_BUFFER = 200;

export class EventBus extends EventEmitter {
  private buffer: ProgressEvent[] = [];
  private statusMap = new Map<string, ExecutionStatus>();

  publish(event: ProgressEvent) {
    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
    this.updateStatus(event);
    this.emit("progress", event);
  }

  getRecentEvents(projectId?: string, since?: string): ProgressEvent[] {
    let events = this.buffer;
    if (projectId) {
      events = events.filter((e) => e.projectId === projectId);
    }
    if (since) {
      events = events.filter((e) => e.timestamp > since);
    }
    return events;
  }

  getStatus(projectId: string): ExecutionStatus | undefined {
    return this.statusMap.get(projectId);
  }

  private updateStatus(event: ProgressEvent) {
    const pid = event.projectId;
    const current = this.statusMap.get(pid) ?? {
      projectId: pid,
      running: false,
    };

    current.lastEvent = event.timestamp;

    switch (event.type) {
      case "story_start":
        current.running = true;
        current.storyId = event.storyId;
        current.storyTitle = event.title;
        current.attempt = event.attempt;
        current.maxRetries = event.maxRetries;
        current.progress = event.progress;
        current.startedAt = event.timestamp;
        current.step = undefined;
        break;
      case "step_start":
        current.step = event.step;
        current.attempt = event.attempt;
        break;
      case "step_complete":
        break;
      case "gate_result":
        break;
      case "story_ship":
        current.progress = event.progress;
        current.step = undefined;
        break;
      case "story_fail":
        current.step = undefined;
        break;
      case "engine_complete":
        current.running = false;
        current.progress = event.progress;
        current.storyId = undefined;
        current.step = undefined;
        break;
    }

    this.statusMap.set(pid, current);
  }
}
