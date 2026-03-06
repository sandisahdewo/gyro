# Pomodoro Timer — Implementation Plan

Single-file HTML/CSS/JS pomodoro timer. No build tools, no dependencies.

## Stories

### Story 1: Base HTML structure with timer display
Create `index.html` with centered layout, h1 title, timer display showing "25:00",
and Start/Pause + Reset buttons. Clean CSS with a modern, minimal look.

### Story 2: Countdown timer logic
Wire up the Start/Pause button to begin a 25-minute countdown that updates
the display every second. Pause preserves remaining time. Reset returns to
25:00 and stops. Timer stops at 00:00.

### Story 3: Session tracking and notifications
Add a completed-sessions counter. When the timer reaches 00:00, increment the
count and flash the document title. After a work session, switch to a 5-minute
break timer automatically.

### Story 4: LocalStorage persistence and settings
Persist the session count across page reloads. Add input fields for custom
work/break durations (in minutes). Persist custom durations in localStorage.
Reset button only resets the current timer, not saved settings.

## Tech Stack
- Single `index.html` file (inline CSS + JS)
- No frameworks, no build tools
- LocalStorage for persistence
