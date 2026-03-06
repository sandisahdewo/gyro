# Project: Notes App

## Tech Stack
- Backend: Node.js, Express, better-sqlite3
- Frontend: Vanilla HTML/CSS/JS (served from `public/`)
- Testing: Vitest + Supertest

## Quality Gates (must ALL pass before committing)
```bash
npm test
```

## Rules
- Backend: TDD. Write failing test FIRST, then implement to make it pass.
- NEVER delete or skip existing tests.
- NEVER use hardcoded return values to pass tests.
- NEVER mock the database — use a real in-memory or temp-file SQLite DB in tests.
- API responses must use proper HTTP status codes (201 for create, 204 for delete, 400 for validation errors, 404 for not found).
- Frontend JS goes in `public/` directory — no bundler, no framework.
- Keep the SQLite schema simple: one `notes` table with id, title, body, created_at, updated_at.
