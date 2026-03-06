# Brain - AI Task Execution Engine

## Big Picture

We're building a Kanban board (like Asana/Trello) with AI-powered planning and autonomous implementation.

**Flow:** Backlog → Plan → Implement → Done

- **Plan phase:** User brainstorms with AI (Opus 4.6) which understands the codebase, breaking work into actionable tasks
- **Implement phase:** This engine (brain) picks up tasks and executes them autonomously

The product has two parts: a **Kanban web app** (UI + planning) and **brain** (execution engine). This repo is brain.

## This Repo's Role

Brain is the autonomous execution engine. It:

- Picks up tasks from the Implement queue one by one
- Runs configurable pipelines (work → review → retry loop)
- Reports progress back (step 1/5, failed, done)

Brain does NOT handle the UI, brainstorming, or board management — that's the web app's job.

## Configuration

Pipeline config is per-project and customizable:

- **Backend projects:** TDD method (test-first)
- **Frontend projects:** E2E or integration tests
- **Monolith/other:** Configurable — not all projects split backend/frontend
- Pipeline steps are fully customizable per project

## Current State

- `gyro.sh` — the autonomous loop engine
- `plan-to-gyro.sh` — converts plans to task format (prd.json)
- Prompt templates in `.gyro/prompts/`

## Next Steps

- API or interface for the Kanban web app to submit tasks and receive progress updates
- Configurable pipeline setup per project
- Progress reporting mechanism (status updates back to the board)
