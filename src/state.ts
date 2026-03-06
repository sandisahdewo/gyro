import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";

export class State {
  private dir: string;

  constructor(dir: string = ".gyro/state") {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private filePath(name: string): string {
    return join(this.dir, name);
  }

  // --- File helpers ---

  read(name: string): string | undefined {
    const p = this.filePath(name);
    if (!existsSync(p)) return undefined;
    return readFileSync(p, "utf-8");
  }

  write(name: string, content: string) {
    writeFileSync(this.filePath(name), content);
  }

  append(name: string, content: string) {
    appendFileSync(this.filePath(name), content);
  }

  remove(name: string) {
    const p = this.filePath(name);
    if (existsSync(p)) unlinkSync(p);
  }

  exists(name: string): boolean {
    return existsSync(this.filePath(name));
  }

  // --- Current story ---

  setCurrentStory(storyId: string) {
    this.write("current-story.txt", storyId);
  }

  getCurrentStory(): string | undefined {
    return this.read("current-story.txt")?.trim();
  }

  // --- Review result ---

  getReviewResult(): string | undefined {
    return this.read("review-result.txt")?.trim().toUpperCase();
  }

  clearReviewResult() {
    this.remove("review-result.txt");
  }

  // --- Review feedback ---

  getReviewFeedback(): string | undefined {
    return this.read("review-feedback.txt");
  }

  setReviewFeedback(feedback: string) {
    this.write("review-feedback.txt", feedback);
  }

  clearReviewFeedback() {
    this.remove("review-feedback.txt");
  }

  // --- Work summary ---

  getWorkSummary(): string | undefined {
    return this.read("work-summary.txt");
  }

  isNoChanges(): boolean {
    const summary = this.getWorkSummary();
    return !!summary && /NO_CHANGES/i.test(summary);
  }

  // --- Step completion tracking ---

  isStepCompleted(storyId: string, step: string): boolean {
    const content = this.read(`completed-steps-${storyId}.txt`);
    if (!content) return false;
    return content.split("\n").includes(step);
  }

  markStepCompleted(storyId: string, step: string) {
    this.append(`completed-steps-${storyId}.txt`, step + "\n");
  }

  clearCompletedSteps(storyId: string) {
    this.remove(`completed-steps-${storyId}.txt`);
  }

  // --- Checkpoint scope ---

  getCheckpointScope(): string | undefined {
    return this.read("checkpoint-scope.txt")?.trim();
  }

  setCheckpointScope(tag: string) {
    this.write("checkpoint-scope.txt", tag);
  }

  // --- Cleanup for new attempt ---

  clearAttemptState() {
    this.remove("work-summary.txt");
    this.remove("review-result.txt");
    this.remove("test-summary.txt");
    this.remove("test-checksums.txt");
    this.remove("test-checksums-after.txt");
    this.remove("test-files.txt");
    this.remove("gate-test-output.log");
  }

  clearFirstAttemptState(storyId: string) {
    this.clearReviewFeedback();
    this.clearCompletedSteps(storyId);
  }

  // --- Step log management ---

  getStepLogPath(stepName: string): string {
    return this.filePath(`${stepName}-output.log`);
  }

  getStepStderrPath(stepName: string): string {
    return this.filePath(`${stepName}-stderr.log`);
  }

  cleanStaleStepLogs(storyId: string) {
    try {
      const files = readdirSync(this.dir).filter((f: string) => f.endsWith("-output.log"));
      for (const file of files) {
        const stepName = basename(file, "-output.log");
        if (!this.isStepCompleted(storyId, stepName)) {
          this.remove(file);
        }
      }
    } catch {}
  }
}
