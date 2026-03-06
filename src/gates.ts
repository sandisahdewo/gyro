import { execSync } from "child_process";
import { readFileSync } from "fs";
import type { TestLock, E2eConfig } from "./types.js";
import { State } from "./state.js";
import { log, ok, warn, CYAN, BOLD, NC } from "./log.js";

function findTestFiles(filePattern: string): string[] {
  const patterns = filePattern.split(",").map((p) => p.trim());
  const nameArgs = patterns
    .map((p, i) => (i > 0 ? `-o -name "${p}"` : `-name "${p}"`))
    .join(" ");

  const cmd = `find . \\( ${nameArgs} \\) -not -path "./.gyro/*" -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./.venv/*" -not -path "./__pycache__/*"`;

  try {
    const result = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return result.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function checksumFiles(files: string[]): Map<string, string> {
  const checksums = new Map<string, string>();
  if (files.length === 0) return checksums;

  try {
    const result = execSync(`md5sum ${files.map((f) => `"${f}"`).join(" ")}`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    for (const line of result.trim().split("\n")) {
      const [hash, file] = line.trim().split(/\s+/, 2);
      if (hash && file) checksums.set(file, hash);
    }
  } catch {}

  return checksums;
}

function serializeChecksums(checksums: Map<string, string>): string {
  return [...checksums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, hash]) => `${hash}  ${file}`)
    .join("\n");
}

export function snapshotTestFiles(state: State, testLock: TestLock) {
  const files = findTestFiles(testLock.file_pattern);
  const checksums = checksumFiles(files);
  state.write("test-checksums.txt", serializeChecksums(checksums));
  state.write("test-files.txt", files.join("\n"));
  log(`  ${CYAN}[gate]${NC} Snapshotted ${BOLD}${checksums.size}${NC} test file(s)`);
}

function getScopedTestCmd(state: State, testLock: TestLock): string {
  if (!testLock.test_cmd_file) return testLock.test_cmd;

  const fileList = state.read("test-files.txt");
  if (!fileList) return testLock.test_cmd;

  const files = fileList.trim().split("\n").filter(Boolean);
  if (files.length === 0) return testLock.test_cmd;

  return testLock.test_cmd_file.replace("{files}", files.join(" "));
}

export function gateVerifyRed(state: State, testLock: TestLock): boolean {
  if (!testLock.test_cmd) return true;
  if (!testLock.verify_red) return true;

  const cmd = getScopedTestCmd(state, testLock);
  log(`  ${CYAN}[gate]${NC} Verifying tests fail (red phase)...`);

  try {
    execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Tests passed — this is bad in red phase
    warn("  [gate] Tests PASS after test step -- expected them to FAIL");
    state.setReviewFeedback(
      "GATE_FAIL (verify-red): Tests passed when they should fail.\n" +
        "The test step wrote tests that pass without new implementation.\n" +
        "Fix: write tests that assert on behavior that does NOT yet exist."
    );
    return false;
  } catch {
    // Tests failed — this is expected
    ok("  [gate] Red phase confirmed -- tests correctly fail");
    return true;
  }
}

export function gateVerifyTestLock(state: State, testLock: TestLock): boolean {
  const beforeRaw = state.read("test-checksums.txt");
  if (!beforeRaw) {
    warn("  [gate] No test checksums found -- skipping test-lock check");
    return true;
  }

  const files = findTestFiles(testLock.file_pattern);
  const afterChecksums = checksumFiles(files);
  const afterRaw = serializeChecksums(afterChecksums);

  if (beforeRaw.trim() !== afterRaw.trim()) {
    warn("  [gate] FAIL -- Test files were modified by the work step!");
    state.setReviewFeedback(
      `GATE_FAIL (test-lock): Test files were modified by the work step.\n` +
        `The work step MUST NOT modify test files (${testLock.file_pattern}).\n` +
        `Only write implementation/production code to make the existing tests pass.`
    );
    return false;
  }

  ok("  [gate] Test lock verified -- test files unchanged");
  return true;
}

export function gateVerifyGreen(state: State, testLock: TestLock): boolean {
  if (!testLock.test_cmd) return true;
  if (!testLock.verify_green) return true;

  const cmd = getScopedTestCmd(state, testLock);
  log(`  ${CYAN}[gate]${NC} Verifying tests pass (green phase)...`);

  try {
    execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    ok("  [gate] Green phase confirmed -- tests pass");
    return true;
  } catch {
    warn("  [gate] Tests FAIL after work step -- expected them to PASS");
    state.setReviewFeedback(
      "GATE_FAIL (verify-green): Tests still fail after the work step.\n" +
        "The implementation does not make the tests pass.\n" +
        "Fix: ensure the implementation satisfies all existing tests."
    );
    return false;
  }
}

function findChangedE2eFiles(e2e: E2eConfig): string[] {
  // Find e2e test files that were added or modified (unstaged changes)
  const patterns = e2e.file_pattern.split(",").map((p) => p.trim());
  const allFiles = findTestFiles(e2e.file_pattern);

  try {
    // Get files changed since last commit (new or modified)
    const diffOutput = execSync("git diff --name-only HEAD 2>/dev/null || git diff --name-only", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const untrackedOutput = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const changedFiles = new Set([
      ...diffOutput.trim().split("\n").filter(Boolean),
      ...untrackedOutput.trim().split("\n").filter(Boolean),
    ]);

    // Filter to only e2e test files that were changed
    const matched = allFiles.filter((f) => {
      const normalized = f.startsWith("./") ? f.slice(2) : f;
      return changedFiles.has(normalized) || changedFiles.has(`./${normalized}`);
    });

    return matched.length > 0 ? matched : allFiles;
  } catch {
    return allFiles;
  }
}

function getScopedE2eCmd(e2e: E2eConfig, files: string[]): string {
  if (!e2e.test_cmd_file || files.length === 0) return e2e.test_cmd;
  return e2e.test_cmd_file.replace("{files}", files.join(" "));
}

export function gateVerifyE2e(state: State, e2e: E2eConfig): boolean {
  const files = findChangedE2eFiles(e2e);
  const cmd = getScopedE2eCmd(e2e, files);

  log(`  ${CYAN}[gate]${NC} Running e2e tests (${BOLD}${files.length}${NC} file(s))...`);

  try {
    execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    ok("  [gate] E2e tests pass");
    return true;
  } catch (err) {
    const parts: string[] = [];
    if (err instanceof Error && "stdout" in err) {
      const stdout = (err as { stdout: string }).stdout?.trim();
      if (stdout) parts.push(stdout);
    }
    if (err instanceof Error && "stderr" in err) {
      const stderr = (err as { stderr: string }).stderr?.trim();
      if (stderr) parts.push(stderr);
    }
    const output = parts.join("\n") || "E2e tests failed with no output";
    const tail = output.split("\n").slice(-20).join("\n");

    warn("  [gate] E2e tests FAIL after work step");
    state.setReviewFeedback(
      "GATE_FAIL (verify-e2e): E2e tests fail after the work step.\n" +
        "Fix the implementation or the e2e tests to make them pass.\n\n" +
        tail
    );
    return false;
  }
}

export function runPostStepGate(
  state: State,
  testLock: TestLock | undefined,
  e2e: E2eConfig | undefined,
  step: string
): boolean {
  switch (step) {
    case "test":
      if (!testLock) return true;
      snapshotTestFiles(state, testLock);
      return gateVerifyRed(state, testLock);
    case "work": {
      // Backend TDD gates
      if (testLock) {
        if (!gateVerifyTestLock(state, testLock)) return false;
        if (!gateVerifyGreen(state, testLock)) return false;
      }
      // Frontend e2e gate
      if (e2e) {
        if (!gateVerifyE2e(state, e2e)) return false;
      }
      return true;
    }
    default:
      return true;
  }
}
