# Notes CRUD

## Overview
Users can create, read, update, delete, and search text notes through a REST API and web frontend.

## Requirements

### Data Model
- Each note has: id, title, body, created_at, updated_at
- Title is required (non-empty string)
- Body is optional (defaults to empty string)
- Timestamps are set automatically by the database

### API Endpoints
- `POST /notes` — create a note, returns 201
- `GET /notes` — list all notes, newest first
- `GET /notes?q=term` — search notes by title or body (case-insensitive)
- `GET /notes/:id` — get a single note by ID
- `PUT /notes/:id` — update a note's title and/or body, returns 200
- `DELETE /notes/:id` — delete a note, returns 204

### Validation
- Creating or updating with empty title returns 400
- Operations on non-existent IDs return 404
- Search with no matches returns empty array, not an error

### Frontend
- Lists all notes with title, truncated body, and date
- Form for creating and editing notes
- Delete with confirmation prompt
- Live search with 300ms debounce

## Edge Cases
- Very long note titles display correctly in the list
- Note body longer than 100 characters is truncated with "..." in the list view
- Rapid typing in search only triggers one API call per 300ms window
- Deleting a note while editing it clears the form
- Empty database shows a friendly "No notes yet" message
