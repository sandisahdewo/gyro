# Frontend Implementation Notes

## Epic Planning UI

### Kanban Columns & Epic Status Mapping

| Column | Epic Status | What happens |
|--------|-------------|--------------|
| Backlog | `backlog` | Epic exists with title + description |
| Plan | `planning` | User chats, curates plan, approves → `ready` |
| Implement | `implementing` | Engine executes tasks automatically |
| Done | `done` | All tasks shipped |

### Flow

```
Backlog          Plan                          Implement         Done
  |                |                              |               |
  |  drag →    planning                           |               |
  |            chat sessions                      |               |
  |            curate final plan                  |               |
  |            [Approve Plan]                     |               |
  |                ↓                              |               |
  |            ready (tasks visible)              |               |
  |                |       drag →           implementing          |
  |                |                        engine runs tasks     |
  |                |                              |        →    done
```

### Plan Phase UI

The Plan phase has three components:

#### 1. Chat Sessions (left/bottom panel)
- Multiple sessions per epic (one per agent/conversation)
- Each session is a brainstorm/research thread
- Can use different agents: Claude, Codex, Gemini, etc.
- Session list with agent label, date, status (active/finished)
- Click session to view conversation history
- Can continue/resume active sessions
- Can delete old sessions

#### 2. Final Plan Editor (main panel)
- Rich text editor for the curated plan
- This is the **source of truth** that gets passed to the decomposer
- User writes/edits this by pulling from whichever sessions they want
- Stored as `epic.plan` field

#### 3. AI Draft Button (convenience)
- "Draft plan from sessions" button
- Calls `POST /projects/:id/epics/:epicId/draft-plan`
- Optionally accepts `session_ids` array to filter which sessions to include
- Returns AI-synthesized plan draft from selected sessions
- User reviews and edits the draft in the plan editor before saving

#### 4. Task Preview (shown after approval)
- After clicking "Approve Plan", the decomposed tasks appear below the plan
- Fetched via `GET /projects/:id/epics/:epicId/tasks`
- Shows task title, pipeline, acceptance criteria
- User reviews tasks before dragging epic to Implement column
- If tasks look wrong: stop epic, edit plan, re-approve

### Recommended Layout

```
+------------------------------------------------------+
| Epic: [title]                    [Status: Planning]  |
+-------------------+----------------------------------+
|  Sessions         |  Final Plan                      |
|                   |                                  |
|  > Claude #1 [✓]  |  [Rich text editor]              |
|  > Codex #1  [✓]  |                                  |
|  > Claude #2 [●]  |  User writes/pastes the agreed   |
|                   |  plan here, combining insights   |
|  [+ New Session]  |  from multiple sessions.         |
|                   |                                  |
|                   |  [Draft from sessions ▼]         |
|                   |  [Save Plan]                     |
+-------------------+----------------------------------+
|  Tasks (after approval)                              |
|  ┌─────────────────────────────────────────────┐     |
|  │ task-01: Set up OAuth routes    [backend]   │     |
|  │ task-02: Add JWT middleware     [backend]   │     |
|  │ task-03: Login page UI          [frontend]  │     |
|  └─────────────────────────────────────────────┘     |
+------------------------------------------------------+
|  Session Preview / Chat                              |
|  [user]: How should we handle auth?                  |
|  [assistant]: I'd recommend OAuth2 with...           |
|  [Type message...] [Send]                            |
+------------------------------------------------------+
|  [← Back to Backlog]          [✓ Approve Plan]       |
|                       (after approval:)              |
|                         [→ Move to Implement]        |
+------------------------------------------------------+
```

### User Workflow
1. Create epic in Backlog (title + description)
2. Drag to Plan column → `PATCH status: "planning"`
3. Start chat sessions with different agents to brainstorm
4. Read through sessions, pick the parts they agree with
5. Either manually write the plan or click "Draft from sessions" for AI assist
6. Edit/refine the plan in the editor
7. Save the plan → `PATCH { plan: "..." }`
8. Click "Approve Plan" → `POST /approve` → loading → tasks appear
9. Review the decomposed tasks
10. Drag to Implement column → `PATCH status: "implementing"` → engine starts

### API Endpoints Used

| Action | Method | Endpoint |
|--------|--------|----------|
| Chat with agent | POST | `/projects/:id/epics/:epicId/chat` |
| Stream response | GET | `/projects/:id/epics/:epicId/chat/stream` |
| List sessions | GET | `/projects/:id/epics/:epicId/chat/sessions` |
| Session history | GET | `/projects/:id/epics/:epicId/chat/sessions/:sid/history` |
| Delete session | DELETE | `/projects/:id/epics/:epicId/chat/sessions/:sid` |
| Finish session | POST | `/projects/:id/epics/:epicId/chat/finish` |
| Draft plan (AI) | POST | `/projects/:id/epics/:epicId/draft-plan` |
| Save plan | PATCH | `/projects/:id/epics/:epicId` (body: `{ plan: "..." }`) |
| Approve plan | POST | `/projects/:id/epics/:epicId/approve` |
| List epic tasks | GET | `/projects/:id/epics/:epicId/tasks` |
| Move to Implement | PATCH | `/projects/:id/epics/:epicId` (body: `{ status: "implementing" }`) |
| Stop epic | POST | `/projects/:id/epics/:epicId/stop` |
| Retry failed | POST | `/projects/:id/epics/:epicId/retry` |

### Key Design Decisions
- Sessions are **research/input**, the plan is the **curated output**
- User is the curator — they decide what makes it into the final plan
- Decomposer only reads `epic.plan`, not raw chat sessions (token efficient)
- Multi-agent support: sessions can come from any AI provider
- Plan is required for approval — validates `epic.plan` is set before decomposing
- **Approve creates tasks but doesn't execute** — epic goes to `ready`, tasks are visible
- **Dragging to Implement starts execution** — engine only picks tasks from `implementing` epics
- Standalone tasks (no epic) execute immediately when pending
