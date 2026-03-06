# Todo List App — Go + HTMX + JSON File Storage + Docker

## Context

Build a todo list web application using Go for the backend and HTMX for the frontend. Data is persisted to a JSON file (no database). The app runs via Docker and Docker Compose.

## Project Structure

```
todolist/src/
├── main.go                 # Entry point, HTTP server, routes, handlers
├── todo.go                 # Todo model, JSON file read/write logic
├── go.mod                  # Go module
├── templates/
│   └── index.html          # Single HTML template with HTMX
├── data/
│   └── todos.json          # JSON file for persistence (created at runtime)
├── Dockerfile              # Multi-stage build
└── docker-compose.yml      # Compose config with volume for data/
```

## Features

- **Add** a todo (text input + submit)
- **Toggle** complete/incomplete
- **Delete** a todo
- All changes persist to `data/todos.json`
- Page loads with existing todos from the JSON file

## Implementation Plan

### Step 1: Go module and Todo model (`go.mod`, `todo.go`)

- `go mod init todolist`
- Define `Todo` struct: `ID string`, `Title string`, `Completed bool`
- `LoadTodos(filePath) ([]Todo, error)` — reads JSON file, returns slice (returns empty slice if file doesn't exist)
- `SaveTodos(filePath, []Todo) error` — writes slice to JSON file with indentation
- Use `sync.Mutex` in a `TodoStore` struct to handle concurrent access safely
- `TodoStore` methods: `All()`, `Add(title)`, `Toggle(id)`, `Delete(id)`
- Generate IDs with `strconv.FormatInt(time.Now().UnixNano(), 36)`

### Step 2: HTTP server and handlers (`main.go`)

- Create `TodoStore` with file path from env var `DATA_FILE` (default: `data/todos.json`)
- Ensure `data/` directory exists on startup
- Parse templates from `templates/` directory
- Routes (using `net/http` stdlib):
  - `GET /` — render full page with all todos
  - `POST /todos` — add todo, return updated todo list partial (HTMX swap)
  - `PUT /todos/{id}/toggle` — toggle completion, return updated todo list partial
  - `DELETE /todos/{id}` — delete todo, return updated todo list partial
- Each mutation handler calls `SaveTodos` after modifying state
- Serve on port `8080`

### Step 3: HTML template with HTMX (`templates/index.html`)

- Single page with embedded HTMX (CDN link)
- Form with text input + "Add" button
  - `hx-post="/todos"` `hx-target="#todo-list"` `hx-swap="innerHTML"`
- Todo list container (`#todo-list`) with a Go template partial
- Each todo item shows:
  - Checkbox/button to toggle: `hx-put="/todos/{{.ID}}/toggle"` `hx-target="#todo-list"`
  - Title (with strikethrough if completed)
  - Delete button: `hx-delete="/todos/{{.ID}}"` `hx-target="#todo-list"`
- **Tailwind CSS via CDN** (`<script src="https://cdn.tailwindcss.com">`) for all styling
- Clean, consistent design:
  - Centered card layout with max-width container, white card on gray background
  - Rounded input + button form row with consistent spacing
  - Each todo item in a row: checkbox, title text, delete button
  - Completed todos get muted text color + line-through
  - Hover/focus states on interactive elements
  - Responsive — works on mobile and desktop

### Step 4: Dockerfile (multi-stage)

```dockerfile
# Build stage
FROM golang:1.23-alpine AS builder
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o todolist .

# Run stage
FROM alpine:3.19
WORKDIR /app
COPY --from=builder /app/todolist .
COPY --from=builder /app/templates ./templates
EXPOSE 8080
CMD ["./todolist"]
```

### Step 5: Docker Compose (`docker-compose.yml`)

```yaml
services:
  app:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - todo-data:/app/data
    environment:
      - DATA_FILE=/app/data/todos.json

volumes:
  todo-data:
```

- Named volume `todo-data` ensures JSON file persists across container restarts

## Files to Create

| File | Purpose |
|------|---------|
| `go.mod` | Go module definition |
| `todo.go` | Todo model + JSON file store |
| `main.go` | HTTP server, routes, handlers |
| `templates/index.html` | HTMX-powered UI |
| `Dockerfile` | Multi-stage container build |
| `docker-compose.yml` | Orchestration with persistent volume |

## Verification

1. `docker compose up --build`
2. Open `http://localhost:8080`
3. Add a few todos — verify they appear
4. Toggle completion — verify strikethrough toggles
5. Delete a todo — verify it disappears
6. `docker compose down && docker compose up` — verify todos persist
