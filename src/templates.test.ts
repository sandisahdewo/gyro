import { describe, it, expect } from "vitest";
import { getTemplate } from "./templates.js";

describe("templates", () => {
  it("returns node-tdd for 'node' tech", () => {
    const t = getTemplate("node");
    expect(t.default_pipeline).toBe("backend-tdd");
    expect(t.pipelines["backend-tdd"]).toBeDefined();
    expect(t.pipelines["setup"]).toBeDefined();
  });

  it("returns node-tdd for 'typescript' tech", () => {
    const t = getTemplate("typescript");
    expect(t.default_pipeline).toBe("backend-tdd");
  });

  it("returns go-tdd for 'go' tech", () => {
    const t = getTemplate("go");
    expect(t.default_pipeline).toBe("backend-tdd");
    const pipeline = t.pipelines["backend-tdd"] as any;
    expect(pipeline.test_lock.test_cmd).toBe("go test ./...");
  });

  it("returns python-tdd for 'python' tech", () => {
    const t = getTemplate("python");
    expect(t.default_pipeline).toBe("backend-tdd");
    const pipeline = t.pipelines["backend-tdd"] as any;
    expect(pipeline.test_lock.test_cmd).toBe("pytest");
  });

  it("returns frontend for 'react' tech", () => {
    const t = getTemplate("react");
    expect(t.default_pipeline).toBe("frontend");
    expect(t.pipelines["frontend"]).toBeDefined();
  });

  it("returns setup for unknown tech", () => {
    const t = getTemplate("cobol");
    expect(t.default_pipeline).toBe("setup");
  });

  it("returns setup when no tech given", () => {
    const t = getTemplate();
    expect(t.default_pipeline).toBe("setup");
  });

  it("allows template override", () => {
    const t = getTemplate("node", "frontend");
    expect(t.default_pipeline).toBe("frontend");
  });

  it("ignores invalid override and falls back to tech", () => {
    const t = getTemplate("node", "nonexistent");
    expect(t.default_pipeline).toBe("backend-tdd");
  });
});
