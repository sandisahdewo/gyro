import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { ProjectManager } from "../project-manager.js";
import { ChatSpawner, buildSystemPrompt } from "../chat-spawner.js";
import * as db from "../db.js";

function paramId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] : id;
}

function paramEpicId(req: Request): string {
  const id = req.params.epicId;
  return Array.isArray(id) ? id[0] : id;
}

function paramSessionId(req: Request): string {
  const id = req.params.sessionId;
  return Array.isArray(id) ? id[0] : id;
}

function extractResponseText(chunks: string[]): string {
  // The stream-json format ends with a "result" event containing the full response
  // This is the most reliable source — it includes the complete final text
  for (let i = chunks.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(chunks[i]);
      if (parsed.type === "result" && typeof parsed.result === "string") {
        return parsed.result;
      }
    } catch {
      // skip
    }
  }

  // Fallback: build from assistant message content blocks
  let text = "";
  for (const line of chunks) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === "text") {
            text = block.text;
          }
        }
      }
    } catch {
      // skip
    }
  }
  return text;
}

/** Build assistant message content as JSON with full stream events */
function buildAssistantContent(resultText: string, rawChunks: string[]): string {
  const events: unknown[] = [];
  for (const chunk of rawChunks) {
    try {
      events.push(JSON.parse(chunk));
    } catch {
      // skip unparseable lines
    }
  }
  return JSON.stringify({ result: resultText, events });
}

/** Parse stored assistant content — handles both legacy plain text and new JSON format */
function parseAssistantContent(content: string): { result: string; events: unknown[] } {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.result === "string" && Array.isArray(parsed.events)) {
      return parsed;
    }
  } catch {
    // legacy plain text
  }
  return { result: content, events: [] };
}

function formatMessages(messages: db.DbChatMessage[]): unknown[] {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      const parsed = parseAssistantContent(msg.content);
      return {
        id: msg.id,
        session_id: msg.session_id,
        role: msg.role,
        content: parsed.result,
        events: parsed.events,
        created_at: msg.created_at,
      };
    }
    return msg;
  });
}

export function createChatRouter(pm: ProjectManager, chatSpawner: ChatSpawner, database: Database.Database): Router {
  const router = Router();

  // Auto-save assistant response when Claude finishes, regardless of SSE connection
  chatSpawner.on("done", (sessionId: string, _code: number | null) => {
    const result = chatSpawner.getResult(sessionId);
    if (!result) return;
    const fullText = extractResponseText(result.chunks);
    if (!fullText && result.chunks.length === 0) return;
    try {
      const content = buildAssistantContent(fullText, result.chunks);
      db.addChatMessage(database, sessionId, "assistant", content);
    } catch {
      // Session may not exist (e.g. deleted) — ignore
    }
  });

  // --- Helper: check epic-level in-flight guard ---
  function getInFlightSessionForEpic(projectId: string, epicId: string): string | undefined {
    const sessions = db.listChatSessionsByEpic(database, projectId, epicId);
    return chatSpawner.hasActiveAmong(sessions.map((s) => s.id));
  }

  // Send chat message (starts or continues conversation)
  // Body: { message: string, sessionId?: string }
  //   - No sessionId → create new session
  //   - With sessionId → continue that session (reactivates if finished)
  router.post("/:id/epics/:epicId/chat", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const epic = db.getEpic(database, projectId, epicId);
    if (!epic) {
      res.status(404).json({ error: "epic not found" });
      return;
    }

    const { message, sessionId: requestedSessionId } = req.body;
    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    // Epic-level in-flight guard: reject if ANY session on this epic is mid-response
    const inFlightId = getInFlightSessionForEpic(projectId, epicId);
    if (inFlightId) {
      res.status(409).json({
        error: "A response is still in progress on this epic",
        activeSessionId: inFlightId,
      });
      return;
    }

    let session: db.DbChatSession;
    let isResume: boolean;

    if (requestedSessionId) {
      // Continue existing session
      const existing = db.getChatSession(database, requestedSessionId);
      if (!existing) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (existing.project_id !== projectId || existing.epic_id !== epicId) {
        res.status(400).json({ error: "session does not belong to this epic" });
        return;
      }
      // Reactivate if finished
      if (existing.status === "finished") {
        db.reactivateChatSession(database, requestedSessionId);
      }
      session = db.getChatSession(database, requestedSessionId)!;
      isResume = true;
    } else {
      // Create new session
      const newId = randomUUID();
      session = db.createChatSession(database, newId, projectId, epicId);
      isResume = false;
    }

    // Save user message
    const userMsg = db.addChatMessage(database, session.id, "user", message);

    // Build system prompt for first message
    const config = db.getProjectConfig(database, projectId);
    const dbProject = db.getProject(database, projectId)!;
    const systemPrompt = buildSystemPrompt(dbProject, epic, config);

    // Spawn Claude CLI
    try {
      chatSpawner.send(session.id, message, {
        isResume,
        systemPrompt,
        projectDir: dbProject.dir,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.status(201).json({ sessionId: session.id, messageId: userMsg.id });
  });

  // List sessions for an epic
  router.get("/:id/epics/:epicId/chat/sessions", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const sessions = db.listChatSessionsByEpic(database, projectId, epicId);
    const result = sessions.map((s) => {
      const messageCount = db.listChatMessages(database, s.id).length;
      return { ...s, messageCount, isActive: chatSpawner.isActive(s.id) };
    });

    res.json({ sessions: result });
  });

  // SSE stream for current response (accepts ?sessionId= query param)
  router.get("/:id/epics/:epicId/chat/stream", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    // Find session: use query param or find the in-flight one
    let sessionId = req.query.sessionId as string | undefined;
    if (!sessionId) {
      sessionId = getInFlightSessionForEpic(projectId, epicId);
      if (!sessionId) {
        // Check for a stored result from any session
        const sessions = db.listChatSessionsByEpic(database, projectId, epicId);
        for (const s of sessions) {
          if (chatSpawner.getResult(s.id)) {
            sessionId = s.id;
            break;
          }
        }
      }
    }

    if (!sessionId) {
      res.status(404).json({ error: "no in-flight response to stream" });
      return;
    }

    // If the process already finished, replay from stored result
    const existingResult = chatSpawner.getResult(sessionId);
    if (existingResult) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      for (const chunk of existingResult.chunks) {
        res.write(`event: chunk\ndata: ${chunk}\n\n`);
      }
      if (existingResult.error) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: existingResult.error })}\n\n`);
      }
      res.write(`event: done\ndata: {"sessionId":"${sessionId}"}\n\n`);
      chatSpawner.clearResult(sessionId);
      res.end();
      return;
    }

    // Process still running — stream live
    if (!chatSpawner.isActive(sessionId)) {
      res.status(404).json({ error: "no in-flight response to stream" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const targetId = sessionId;

    const onChunk = (sid: string, line: string) => {
      if (sid !== targetId) return;
      res.write(`event: chunk\ndata: ${line}\n\n`);
    };

    const onDone = (sid: string, _code: number | null) => {
      if (sid !== targetId) return;

      const result = chatSpawner.getResult(targetId);
      if (result?.error) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: result.error })}\n\n`);
      }

      res.write(`event: done\ndata: {"sessionId":"${targetId}"}\n\n`);
      chatSpawner.clearResult(targetId);
      cleanup();
      res.end();
    };

    const onSpawnError = (sid: string, err: Error) => {
      if (sid !== targetId) return;
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    };

    const cleanup = () => {
      chatSpawner.removeListener("chunk", onChunk);
      chatSpawner.removeListener("done", onDone);
      chatSpawner.removeListener("spawn_error", onSpawnError);
    };

    chatSpawner.on("chunk", onChunk);
    chatSpawner.on("done", onDone);
    chatSpawner.on("spawn_error", onSpawnError);

    req.on("close", () => {
      cleanup();
    });
  });

  // Get conversation history for a specific session
  router.get("/:id/epics/:epicId/chat/sessions/:sessionId/history", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);
    const sessionId = paramSessionId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const session = db.getChatSession(database, sessionId);
    if (!session || session.project_id !== projectId || session.epic_id !== epicId) {
      res.status(404).json({ error: "session not found" });
      return;
    }

    const messages = db.listChatMessages(database, sessionId);
    res.json({ sessionId: session.id, status: session.status, messages: formatMessages(messages) });
  });

  // Get conversation history (latest session — backward compat)
  router.get("/:id/epics/:epicId/chat/history", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const session = db.getLatestChatSessionByEpic(database, projectId, epicId);
    if (!session) {
      res.status(404).json({ error: "no chat session found" });
      return;
    }

    const messages = db.listChatMessages(database, session.id);
    res.json({ sessionId: session.id, status: session.status, messages: formatMessages(messages) });
  });

  // Delete a session
  router.delete("/:id/epics/:epicId/chat/sessions/:sessionId", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);
    const sessionId = paramSessionId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const session = db.getChatSession(database, sessionId);
    if (!session || session.project_id !== projectId || session.epic_id !== epicId) {
      res.status(404).json({ error: "session not found" });
      return;
    }

    // Can't delete while in-flight
    if (chatSpawner.isActive(sessionId)) {
      res.status(409).json({ error: "cannot delete session while a response is in progress" });
      return;
    }

    chatSpawner.clearResult(sessionId);
    db.deleteChatSession(database, sessionId);
    res.json({ deleted: true, sessionId });
  });

  // Finish conversation (accepts optional sessionId in body)
  router.post("/:id/epics/:epicId/chat/finish", (req: Request, res: Response) => {
    const projectId = paramId(req);
    const epicId = paramEpicId(req);

    const project = pm.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: "project not found" });
      return;
    }

    const requestedId = req.body?.sessionId as string | undefined;
    let session: db.DbChatSession | undefined;

    if (requestedId) {
      session = db.getChatSession(database, requestedId);
      if (!session || session.project_id !== projectId || session.epic_id !== epicId) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (session.status === "finished") {
        res.status(409).json({ error: "session already finished" });
        return;
      }
    } else {
      session = db.getChatSessionByEpic(database, projectId, epicId);
      if (!session) {
        res.status(404).json({ error: "no active chat session" });
        return;
      }
    }

    // Abort if still in-flight
    chatSpawner.abort(session.id);

    db.finishChatSession(database, session.id);
    const messages = db.listChatMessages(database, session.id);

    res.json({ sessionId: session.id, status: "finished", messageCount: messages.length });
  });

  return router;
}
