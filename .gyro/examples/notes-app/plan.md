# Notes App — Implementation Plan

Node.js + Express backend with SQLite. Vanilla JS frontend. Tests with Vitest + Supertest.

## Architecture
- **Backend**: Express REST API on port 3000, SQLite database (`notes.db`)
- **Frontend**: Static HTML/CSS/JS served by Express from `public/` directory
- **Testing**: Vitest + Supertest for API tests

## Stories

### Story 1: Initialize project (setup)
Create package.json with Express, better-sqlite3, vitest, supertest.
Set up Express server, SQLite DB with `notes` table (id, title, body, created_at, updated_at).
Verify `npm test` runs.

### Story 2: POST /notes — TDD
Write tests first: create note returns 201 with id/title/body/timestamps;
empty title returns 400 with error message. Then implement.

### Story 3: GET /notes + GET /notes/:id — TDD
Write tests first: empty DB returns []; after 2 POSTs returns length 2;
get by valid ID returns the note; get by invalid ID returns 404. Then implement.

### Story 4: PUT /notes/:id + DELETE /notes/:id — TDD
Write tests first: update title+body returns 200 with updated note;
delete returns 204; operations on missing ID return 404. Then implement.

### Story 5: Search notes GET /notes?q=term — TDD
Write tests first: search by title substring; search by body substring;
no match returns empty array. Then implement with SQLite LIKE queries.

**--- Checkpoint: simplify ---**

### Story 6: Frontend — list notes page
HTML page fetches GET /notes and renders a list. Each note shows title,
truncated body (100 chars), and formatted date. Empty state shows a
"No notes yet" message.

### Story 7: Frontend — create and edit notes
Form with title input + body textarea. Submit creates note via POST.
Click a note in the list to load it into the form for editing (PUT).
Cancel button clears the form.

### Story 8: Frontend — delete and search
Delete button on each note with window.confirm prompt. Search input
at top filters notes via GET /notes?q=. Results update as user types
with 300ms debounce.

**--- Final checkpoint: simplify ---**

## Tech Stack
- Node.js, Express
- better-sqlite3
- Vitest + Supertest
- Vanilla HTML/CSS/JS (no frameworks)
