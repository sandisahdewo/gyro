export interface TestLock {
  test_cmd: string;
  test_cmd_file?: string;
  file_pattern: string;
  verify_red?: boolean;
  verify_green?: boolean;
}

export interface E2eConfig {
  test_cmd: string;
  test_cmd_file?: string;
  file_pattern: string;
}

export interface PipelineObject {
  steps: string[];
  test_lock?: TestLock;
  e2e?: E2eConfig;
}

export type PipelineConfig = string[] | PipelineObject;

export interface Checkpoint {
  after?: string[] | "each";
  on_complete?: boolean;
  standalone?: boolean;
  cmd?: string;
}

export interface Story {
  id: string;
  title: string;
  pipeline: string;
  plan_ref?: string;
  acceptance_criteria: string[];
  passes: boolean;
  priority: number;
}

export interface EnvConfig {
  up: string;
  down: string;
}

export interface PRD {
  project: string;
  work_branches?: boolean;
  env?: EnvConfig;
  models?: Record<string, string>;
  pipelines: Record<string, PipelineConfig>;
  checkpoints?: Record<string, Checkpoint>;
  stories: Story[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
}

export interface StepResult {
  success: boolean;
  usage?: TokenUsage;
}

export type AgentType = "claude" | "codex";

export interface ResolvedModel {
  agent: AgentType;
  model: string;
  label: string;
}

// --- Progress Events ---

interface BaseEvent {
  projectId: string;
  timestamp: string;
}

export interface StoryStartEvent extends BaseEvent {
  type: "story_start";
  storyId: string;
  title: string;
  attempt: number;
  maxRetries: number;
  steps: string[];
  progress: { passed: number; total: number };
}

export interface StepStartEvent extends BaseEvent {
  type: "step_start";
  storyId: string;
  step: string;
  attempt: number;
}

export interface StepCompleteEvent extends BaseEvent {
  type: "step_complete";
  storyId: string;
  step: string;
  duration: number;
  usage?: TokenUsage;
}

export interface GateResultEvent extends BaseEvent {
  type: "gate_result";
  storyId: string;
  gate: string;
  passed: boolean;
  message?: string;
}

export interface StoryShipEvent extends BaseEvent {
  type: "story_ship";
  storyId: string;
  attempt: number;
  duration: number;
  usage?: TokenUsage;
  progress: { passed: number; total: number };
}

export interface StoryFailEvent extends BaseEvent {
  type: "story_fail";
  storyId: string;
  error: string;
  attempts: number;
}

export interface CheckpointStartEvent extends BaseEvent {
  type: "checkpoint_start";
  checkpoint: string;
  storyId?: string;
}

export interface CheckpointCompleteEvent extends BaseEvent {
  type: "checkpoint_complete";
  checkpoint: string;
  passed: boolean;
}

export interface EngineCompleteEvent extends BaseEvent {
  type: "engine_complete";
  duration: number;
  totalUsage?: TokenUsage;
  progress: { passed: number; total: number };
}

export type ProgressEvent =
  | StoryStartEvent
  | StepStartEvent
  | StepCompleteEvent
  | GateResultEvent
  | StoryShipEvent
  | StoryFailEvent
  | CheckpointStartEvent
  | CheckpointCompleteEvent
  | EngineCompleteEvent;

type OmitDistributive<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export type ProgressEventPayload = OmitDistributive<ProgressEvent, "projectId" | "timestamp">;

export type OnEvent = (event: ProgressEventPayload) => void;

export interface ExecutionStatus {
  projectId: string;
  running: boolean;
  storyId?: string;
  storyTitle?: string;
  step?: string;
  attempt?: number;
  maxRetries?: number;
  progress?: { passed: number; total: number };
  startedAt?: string;
  lastEvent?: string;
}
