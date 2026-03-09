import { readFileSync, writeFileSync } from "fs";
import type { PRD, Story, PipelineConfig, PipelineObject, TestLock, E2eConfig, Checkpoint, EnvConfig } from "./types.js";

export class PrdFile {
  data: PRD;
  private path: string;

  constructor(path: string) {
    this.path = path;
    this.data = JSON.parse(readFileSync(path, "utf-8"));
  }

  save() {
    writeFileSync(this.path, JSON.stringify(this.data, null, 2) + "\n");
  }

  // --- Stories ---

  get stories(): Story[] {
    return this.data.stories;
  }

  sortedStories(): Story[] {
    return [...this.data.stories].sort((a, b) => a.priority - b.priority);
  }

  getNextStory(): Story | undefined {
    return this.sortedStories().find((s) => !s.passes);
  }

  getStory(id: string): Story | undefined {
    return this.data.stories.find((s) => s.id === id);
  }

  markStoryPassed(id: string) {
    const story = this.getStory(id);
    if (story) {
      story.passes = true;
      this.save();
    }
  }

  countStories(): number {
    return this.data.stories.length;
  }

  countPassed(): number {
    return this.data.stories.filter((s) => s.passes).length;
  }

  countRemaining(): number {
    return this.data.stories.filter((s) => !s.passes).length;
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

  getStoryPipelineSteps(storyId: string): string[] {
    const story = this.getStory(storyId);
    if (!story) return [];
    return this.getPipelineSteps(story.pipeline);
  }

  getTestLock(pipelineName: string): TestLock | undefined {
    const config = this.data.pipelines[pipelineName];
    if (!config || Array.isArray(config)) return undefined;
    return (config as PipelineObject).test_lock;
  }

  hasTestLock(storyId: string): boolean {
    const story = this.getStory(storyId);
    if (!story) return false;
    return !!this.getTestLock(story.pipeline);
  }

  getStoryTestLock(storyId: string): TestLock | undefined {
    const story = this.getStory(storyId);
    if (!story) return undefined;
    return this.getTestLock(story.pipeline);
  }

  getE2e(pipelineName: string): E2eConfig | undefined {
    const config = this.data.pipelines[pipelineName];
    if (!config || Array.isArray(config)) return undefined;
    return (config as PipelineObject).e2e;
  }

  getStoryE2e(storyId: string): E2eConfig | undefined {
    const story = this.getStory(storyId);
    if (!story) return undefined;
    return this.getE2e(story.pipeline);
  }

  // --- Models ---

  getModelConfig(stepName: string): string | undefined {
    return this.data.models?.[stepName];
  }

  // --- Checkpoints ---

  // Standard order: AI steps that change code first, then verification commands
  static readonly CHECKPOINT_ORDER = [
    "lint",
    "simplify",
    "test-all",
    "type-check",
    "build",
  ];

  get checkpoints(): Record<string, Checkpoint> {
    return this.data.checkpoints ?? {};
  }

  hasCheckpoints(): boolean {
    return !!this.data.checkpoints && Object.keys(this.data.checkpoints).length > 0;
  }

  /** Returns configured checkpoint names in standard order, skipping unconfigured ones */
  getCheckpointNames(): string[] {
    const configured = this.checkpoints;
    const ordered = PrdFile.CHECKPOINT_ORDER.filter((name) => name in configured);
    // Append any custom checkpoints not in the standard order
    const custom = Object.keys(configured).filter(
      (name) => !PrdFile.CHECKPOINT_ORDER.includes(name)
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
