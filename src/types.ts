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
