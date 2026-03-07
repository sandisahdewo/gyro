import type { PipelineConfig, Checkpoint } from "./types.js";

export interface TemplateConfig {
  pipelines: Record<string, PipelineConfig>;
  models: Record<string, string>;
  checkpoints: Record<string, Checkpoint>;
  default_pipeline: string;
}

const NODE_TDD: TemplateConfig = {
  pipelines: {
    setup: ["work", "review"],
    "backend-tdd": {
      steps: ["test", "work", "review"],
      test_lock: {
        test_cmd: "npm test",
        test_cmd_file: "npx vitest {files}",
        file_pattern: "*.test.ts,*.spec.ts",
        verify_red: true,
        verify_green: true,
      },
    },
  },
  models: {
    test: "claude:sonnet",
    work: "claude:sonnet",
    review: "claude:opus",
    fix: "claude:sonnet",
    lint: "claude:haiku",
    simplify: "claude:sonnet",
  },
  checkpoints: {
    "test-all": { cmd: "npm test", after: "each", on_complete: true },
    "type-check": { cmd: "npx tsc --noEmit", after: "each", on_complete: true },
    build: { cmd: "npm run build", after: "each", on_complete: true },
    lint: { after: "each", on_complete: true, standalone: true },
    simplify: { on_complete: true },
  },
  default_pipeline: "backend-tdd",
};

const GO_TDD: TemplateConfig = {
  pipelines: {
    setup: ["work", "review"],
    "backend-tdd": {
      steps: ["test", "work", "review"],
      test_lock: {
        test_cmd: "go test ./...",
        test_cmd_file: "go test {files}",
        file_pattern: "*_test.go",
        verify_red: true,
        verify_green: true,
      },
    },
  },
  models: {
    test: "claude:sonnet",
    work: "claude:sonnet",
    review: "claude:opus",
    fix: "claude:sonnet",
    lint: "claude:haiku",
    simplify: "claude:sonnet",
  },
  checkpoints: {
    "test-all": { cmd: "go test ./...", after: "each", on_complete: true },
    "type-check": { cmd: "go vet ./...", after: "each", on_complete: true },
    build: { cmd: "go build ./...", after: "each", on_complete: true },
    lint: { after: "each", on_complete: true, standalone: true },
    simplify: { on_complete: true },
  },
  default_pipeline: "backend-tdd",
};

const PYTHON_TDD: TemplateConfig = {
  pipelines: {
    setup: ["work", "review"],
    "backend-tdd": {
      steps: ["test", "work", "review"],
      test_lock: {
        test_cmd: "pytest",
        test_cmd_file: "pytest {files}",
        file_pattern: "test_*.py,*_test.py",
        verify_red: true,
        verify_green: true,
      },
    },
  },
  models: {
    test: "claude:sonnet",
    work: "claude:sonnet",
    review: "claude:opus",
    fix: "claude:sonnet",
    lint: "claude:haiku",
    simplify: "claude:sonnet",
  },
  checkpoints: {
    "test-all": { cmd: "pytest", after: "each", on_complete: true },
    lint: { after: "each", on_complete: true, standalone: true },
    simplify: { on_complete: true },
  },
  default_pipeline: "backend-tdd",
};

const FRONTEND: TemplateConfig = {
  pipelines: {
    setup: ["work", "review"],
    frontend: {
      steps: ["work", "review"],
      e2e: {
        test_cmd: "npx playwright test",
        test_cmd_file: "npx playwright test {files}",
        file_pattern: "*.spec.ts,*.e2e.ts",
      },
    },
  },
  models: {
    work: "claude:sonnet",
    review: "claude:opus",
    fix: "claude:sonnet",
    lint: "claude:haiku",
    simplify: "claude:sonnet",
  },
  checkpoints: {
    "test-all": { cmd: "npx playwright test", after: "each", on_complete: true },
    lint: { after: "each", on_complete: true, standalone: true },
    simplify: { on_complete: true },
  },
  default_pipeline: "frontend",
};

const SETUP_ONLY: TemplateConfig = {
  pipelines: {
    setup: ["work", "review"],
  },
  models: {
    work: "claude:sonnet",
    review: "claude:opus",
    fix: "claude:sonnet",
  },
  checkpoints: {},
  default_pipeline: "setup",
};

const TEMPLATES: Record<string, TemplateConfig> = {
  "node-tdd": NODE_TDD,
  "go-tdd": GO_TDD,
  "python-tdd": PYTHON_TDD,
  frontend: FRONTEND,
  setup: SETUP_ONLY,
};

const TECH_TO_TEMPLATE: Record<string, string> = {
  node: "node-tdd",
  typescript: "node-tdd",
  ts: "node-tdd",
  go: "go-tdd",
  golang: "go-tdd",
  python: "python-tdd",
  py: "python-tdd",
  frontend: "frontend",
  react: "frontend",
  vue: "frontend",
  svelte: "frontend",
};

export function getTemplate(tech?: string, templateOverride?: string): TemplateConfig {
  if (templateOverride && TEMPLATES[templateOverride]) {
    return TEMPLATES[templateOverride];
  }

  if (tech) {
    const key = tech.toLowerCase();
    const templateName = TECH_TO_TEMPLATE[key];
    if (templateName && TEMPLATES[templateName]) {
      return TEMPLATES[templateName];
    }
  }

  return SETUP_ONLY;
}
