import { readFileSync, writeFileSync, existsSync } from "fs";
import type { PipelineConfig, PipelineObject, TestLock, E2eConfig, Checkpoint, EnvConfig } from "./types.js";
import { PrdFile } from "./prd.js";

export interface ProjectConfigData {
  pipelines: Record<string, PipelineConfig>;
  models?: Record<string, string>;
  checkpoints?: Record<string, Checkpoint>;
  env?: EnvConfig;
}

export class ProjectConfig {
  data: ProjectConfigData;
  private path: string | null;

  constructor(data: ProjectConfigData, path?: string) {
    this.data = data;
    this.path = path ?? null;
  }

  static fromFile(path: string): ProjectConfig {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return new ProjectConfig(raw, path);
  }

  static fromPrd(prd: PrdFile): ProjectConfig {
    return new ProjectConfig({
      pipelines: prd.data.pipelines,
      models: prd.data.models,
      checkpoints: prd.data.checkpoints,
      env: prd.data.env,
    });
  }

  save() {
    if (this.path) {
      writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n");
    }
  }

  // --- Pipelines ---

  getPipelineConfig(name: string): PipelineConfig | undefined {
    return this.data.pipelines[name];
  }

  getPipelineSteps(pipelineName: string): string[] {
    const config = this.data.pipelines[pipelineName];
    if (!config) return [];
    if (Array.isArray(config)) return config;
    return (config as PipelineObject).steps;
  }

  getTestLock(pipelineName: string): TestLock | undefined {
    const config = this.data.pipelines[pipelineName];
    if (!config || Array.isArray(config)) return undefined;
    return (config as PipelineObject).test_lock;
  }

  getE2e(pipelineName: string): E2eConfig | undefined {
    const config = this.data.pipelines[pipelineName];
    if (!config || Array.isArray(config)) return undefined;
    return (config as PipelineObject).e2e;
  }

  // --- Models ---

  getModelConfig(stepName: string): string | undefined {
    return this.data.models?.[stepName];
  }

  // --- Checkpoints ---

  static readonly CHECKPOINT_ORDER = PrdFile.CHECKPOINT_ORDER;

  get checkpoints(): Record<string, Checkpoint> {
    return this.data.checkpoints ?? {};
  }

  hasCheckpoints(): boolean {
    return !!this.data.checkpoints && Object.keys(this.data.checkpoints).length > 0;
  }

  getCheckpointNames(): string[] {
    const configured = this.checkpoints;
    const ordered = ProjectConfig.CHECKPOINT_ORDER.filter((name) => name in configured);
    const custom = Object.keys(configured).filter(
      (name) => !ProjectConfig.CHECKPOINT_ORDER.includes(name)
    );
    return [...ordered, ...custom];
  }

  shouldRunCheckpointAfter(storyId: string, checkpointName: string): boolean {
    const cp = this.checkpoints[checkpointName];
    if (!cp?.after) return false;
    if (cp.after === "each") return true;
    return cp.after.includes(storyId);
  }

  getBeforeCheckpoints(): string[] {
    return this.getCheckpointNames().filter(
      (name) => !!this.checkpoints[name]?.before
    );
  }

  getOnCompleteCheckpoints(): string[] {
    return this.getCheckpointNames().filter(
      (name) => !!this.checkpoints[name]?.on_complete
    );
  }

  isStandalone(checkpointName: string): boolean {
    return !!this.checkpoints[checkpointName]?.standalone;
  }

  // --- Environment ---

  getEnv(): EnvConfig | undefined {
    return this.data.env;
  }

  hasEnv(): boolean {
    return !!this.data.env;
  }

}
