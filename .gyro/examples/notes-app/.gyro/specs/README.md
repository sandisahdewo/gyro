# Specs Directory

This directory contains requirement specifications — the source of truth for what the project should do.

## Convention

- **One file per topic of concern** (e.g., `authentication.md`, `todo-crud.md`, `filtering.md`)
- **Scope test**: each file's topic should be describable in one sentence without using "and"
- **Behavioral outcomes**, not implementation details — describe what the user sees/experiences, not how the code works
- **Markdown format** with clear sections and testable criteria

## Example Structure

```markdown
# Topic Name

## Overview
One-paragraph description of this feature area.

## Requirements
- Requirement 1: specific, testable behavior
- Requirement 2: specific, testable behavior

## Edge Cases
- What happens when X?
- What happens when Y?
```

## How Specs Are Used

1. **Planning** (`./gyro.sh --plan`): The planner reads all specs to do gap analysis against current code
2. **Work**: The worker reads relevant specs for detailed requirements context beyond prd.json acceptance criteria
3. **Review**: The reviewer checks implementation against specs to verify correctness
4. **Simplify**: The simplifier reads specs to ensure simplifications don't violate requirements

Specs complement `prd.json` — specs are the richer requirements docs, prd.json stories are the execution units derived from them.
