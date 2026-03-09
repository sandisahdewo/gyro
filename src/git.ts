import { execSync } from "child_process";

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function runSafe(cmd: string): string {
  try {
    return run(cmd);
  } catch {
    return "";
  }
}

export function isGitRepo(): boolean {
  try {
    run("git rev-parse --git-dir");
    return true;
  } catch {
    return false;
  }
}

export function initRepo() {
  execSync("git init", { stdio: "inherit" });
}

export function gitAdd() {
  execSync("git add -A", { stdio: "inherit" });
}

export function gitCommit(message: string): boolean {
  try {
    execSync(`git commit -m ${JSON.stringify(message)}`, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

export function hasChanges(): boolean {
  const diffResult = runSafe("git diff --quiet HEAD");
  const untrackedResult = runSafe("git ls-files --others --exclude-standard");
  // git diff --quiet returns non-zero if there are changes
  try {
    execSync("git diff --quiet HEAD", { stdio: "ignore" });
    return untrackedResult.length > 0;
  } catch {
    return true;
  }
}

export function currentBranch(): string {
  return run("git branch --show-current");
}

export function checkoutBranch(name: string, create: boolean = false) {
  if (create) {
    execSync(`git checkout -b ${name}`, { stdio: "inherit" });
  } else {
    execSync(`git checkout ${name}`, { stdio: "inherit" });
  }
}

export function branchExists(name: string): boolean {
  try {
    run(`git show-ref --verify --quiet refs/heads/${name}`);
    return true;
  } catch {
    return false;
  }
}

// --- Tags ---

export function getLatestCheckpointTag(checkpointName: string): string | undefined {
  const result = runSafe(
    `git tag -l "gyro-cp-${checkpointName}-*" --sort=-version:refname`
  );
  if (!result) return undefined;
  return result.split("\n")[0] || undefined;
}

export function createCheckpointTag(checkpointName: string): string {
  const latest = getLatestCheckpointTag(checkpointName);
  let num = 1;
  if (latest) {
    const parts = latest.split("-");
    num = parseInt(parts[parts.length - 1], 10) + 1;
  }
  const tag = `gyro-cp-${checkpointName}-${num}`;
  execSync(`git tag ${tag}`, { stdio: "inherit" });
  return tag;
}

export function countChangedFilesSince(tag: string): number {
  const result = runSafe(`git diff --name-only ${tag}..HEAD`);
  if (!result) return 0;
  return result.split("\n").filter(Boolean).length;
}
