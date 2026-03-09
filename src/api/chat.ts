import { Router, type Request, type Response } from "express";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import type { ProjectManager } from "../project-manager.js";
import { ChatSpawner, buildSystemPrompt, parseChatModel } from "../chat-spawner.js";
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

function parseJsonLine(line: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractCodexAgentText(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.final === "string") {
      return parsed.final;
    }
  } catch {
    // use plain string
  }
  return value;
}

function extractResponseText(chunks: string[]): string {
  // The stream-json format ends with a "result" event containing the full response
  // This is the most reliable source — it includes the complete final text
  for (let i = chunks.length - 1; i >= 0; i--) {
    const parsed = parseJsonLine(chunks[i]);
    if (!parsed) continue;
    if (parsed.type === "result" && typeof parsed.result === "string") {
      return parsed.result;
    }
    if (
      parsed.type === "item.completed" &&
      typeof parsed.item === "object" &&
      parsed.item !== null &&
      (parsed.item as Record<string, unknown>).type === "agent_message"
    ) {
      const text = extractCodexAgentText((parsed.item as Record<string, unknown>).text);
      if (text) {
        return text;
      }
    }
  }

  // Fallback: build from assistant message content blocks
  let text = "";
  for (const line of chunks) {
    const parsed = parseJsonLine(line);
    if (!parsed) continue;
    const message = typeof parsed.message === "object" && parsed.message !== null
      ? parsed.message as { content?: Array<{ type?: string; text?: string }> }
      : undefined;
    if (parsed.type === "assistant" && Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block.type === "text") {
          text = block.text ?? "";
        }
      }
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

function extractExternalSessionId(events: unknown[]): string | undefined {
  for (const event of events) {
    if (
      event &&
      typeof event === "object" &&
      (event as Record<string, unknown>).type === "thread.started" &&
      typeof (event as Record<string, unknown>).thread_id === "string"
    ) {
      return (event as Record<string, unknown>).thread_id as string;
    }
  }
  return undefined;
}

function recoverCodexSessionId(database: Database.Database, sessionId: string): string | undefined {
  const messages = db.listChatMessages(database, sessionId);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const parsed = parseAssistantContent(messages[i].content);
    const externalId = extractExternalSessionId(parsed.events);
    if (externalId) {
      return externalId;
    }
  }
  return undefined;
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

  // Auto-save assistant response when the CLI finishes, regardless of SSE connection
  chatSpawner.on("done", (sessionId: string, _code: number | null) => {
    const result = chatSpawner.getResult(sessionId);
    if (!result) return;
    const fullText = extractResponseText(result.chunks);
    if (!fullText && result.chunks.length === 0) return;
    try {
      if (result.externalSessionId) {
        db.updateChatSessionExternalId(database, sessionId, result.externalSessionId);
      }
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

    const { message, sessionId: requestedSessionId, model: modelStr } = req.body;
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
    let chatModel: ReturnType<typeof parseChatModel>;
    let resumeSessionId: string | undefined;

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
      // Use the session's stored model (ignore any model override on resume)
      chatModel = parseChatModel(session.model);
      if (chatModel.agent === "codex") {
        resumeSessionId = session.external_session_id ?? recoverCodexSessionId(database, session.id);
        if (!resumeSessionId) {
          res.status(409).json({ error: "codex session cannot be resumed because its provider thread id is missing" });
          return;
        }
        if (!session.external_session_id) {
          db.updateChatSessionExternalId(database, session.id, resumeSessionId);
          session = db.getChatSession(database, requestedSessionId)!;
        }
      } else {
        resumeSessionId = session.id;
      }
    } else {
      // Parse and validate model before creating session
      try {
        chatModel = parseChatModel(modelStr);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }
      // Create new session with model
      const newId = randomUUID();
      session = db.createChatSession(database, newId, projectId, epicId, chatModel.label);
      isResume = false;
    }

    // Save user message
    const userMsg = db.addChatMessage(database, session.id, "user", message);

    // Build system prompt for first message
    const config = db.getProjectConfig(database, projectId);
    const dbProject = db.getProject(database, projectId)!;
    const systemPrompt = buildSystemPrompt(dbProject, epic, config);

    // Spawn AI CLI
    try {
      chatSpawner.send(session.id, message, {
        isResume,
        systemPrompt,
        projectDir: dbProject.dir,
        agent: chatModel.agent,
        model: chatModel.model,
        resumeSessionId,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
      return;
    }

    res.status(201).json({ sessionId: session.id, messageId: userMsg.id, model: chatModel.label });
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
      return { ...s, model: s.model, messageCount, isActive: chatSpawner.isActive(s.id) };
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
