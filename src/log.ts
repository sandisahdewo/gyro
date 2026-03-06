import { appendFileSync } from "fs";

const GREEN = "\x1b[0;32m";
const RED = "\x1b[0;31m";
const YELLOW = "\x1b[1;33m";
const CYAN = "\x1b[0;36m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const NC = "\x1b[0m";

export { GREEN, RED, YELLOW, CYAN, BOLD, DIM, NC };

let logFile = ".gyro/gyro.log";

export function setLogFile(path: string) {
  logFile = path;
}

function appendLog(msg: string) {
  try {
    appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export function log(msg: string) {
  console.log(`${CYAN}[gyro]${NC} ${msg}`);
  appendLog(msg);
}

export function ok(msg: string) {
  console.log(`${GREEN}[gyro] OK${NC} ${msg}`);
  appendLog(`OK: ${msg}`);
}

export function warn(msg: string) {
  console.log(`${YELLOW}[gyro] !${NC} ${msg}`);
  appendLog(`WARN: ${msg}`);
}

export function fail(msg: string) {
  console.log(`${RED}[gyro] X${NC} ${msg}`);
  appendLog(`FAIL: ${msg}`);
}

export function hr() {
  console.log(`${DIM}${"─".repeat(60)}${NC}`);
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}
