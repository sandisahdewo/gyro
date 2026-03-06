import { execSync } from "child_process";
import { readFileSync } from "fs";
import type { TestLock } from "./types.js";
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

export function runPostStepGate(
  state: State,
  testLock: TestLock | undefined,
  step: string
): boolean {
  if (!testLock) return true;

  switch (step) {
    case "test":
      snapshotTestFiles(state, testLock);
      return gateVerifyRed(state, testLock);
    case "work":
      if (!gateVerifyTestLock(state, testLock)) return false;
      return gateVerifyGreen(state, testLock);
    default:
      return true;
  }
}
