import type { TokenUsage } from "./types.js";
import { formatTokens, log, DIM, NC, BOLD, GREEN } from "./log.js";

export class ProgressTracker {
  total: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0 };
  story: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheRead: 0 };

  resetStory() {
    this.story = { inputTokens: 0, outputTokens: 0, cacheRead: 0 };
  }

  addUsage(usage: TokenUsage) {
    this.total.inputTokens += usage.inputTokens;
    this.total.outputTokens += usage.outputTokens;
    this.total.cacheRead += usage.cacheRead;
    this.story.inputTokens += usage.inputTokens;
    this.story.outputTokens += usage.outputTokens;
    this.story.cacheRead += usage.cacheRead;
  }

  showUsage(label: string, usage: TokenUsage) {
    const total = usage.inputTokens + usage.outputTokens;
    log(
      `${DIM}${label}: ${formatTokens(usage.inputTokens)} in / ` +
        `${formatTokens(usage.outputTokens)} out (${formatTokens(total)} total)${NC}`
    );
  }

  showStoryUsage() {
    this.showUsage("Story tokens", this.story);
  }

  showTotalUsage() {
    this.showUsage("Total tokens", this.total);
    if (this.total.cacheRead > 0) {
      log(`${DIM}Cache read: ${formatTokens(this.total.cacheRead)}${NC}`);
    }
  }

  showProgressBar(passed: number, total: number) {
    const remaining = total - passed;
    const pct = total > 0 ? Math.floor((passed * 100) / total) : 0;
    const barLen = 30;
    const filled = Math.floor((pct * barLen) / 100);
    const empty = barLen - filled;

    const bar =
      `${GREEN}${"█".repeat(filled)}${DIM}${"░".repeat(empty)}${NC}`;
    console.log(
      `\n  ${bar} ${BOLD}${pct}%${NC} (${passed}/${total} stories, ${remaining} remaining)\n`
    );
  }
}
