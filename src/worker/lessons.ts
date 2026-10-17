import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginContext, ToolResult } from "@paperclipai/plugin-sdk";
import {
  ADD_LESSON_TOOL,
  ADD_LESSON_TOOL_SPEC,
  LESSONS_DATA_KEY,
  LESSON_ADD_ACTION,
  LESSON_DELETE_ACTION,
  addLesson,
  cleanLessonText,
  findAgent,
  parseLessonLines,
  withLessonsBlock,
  type Lesson,
  type LessonPerson,
  type LessonVerdict,
  type LessonsView,
} from "../shared/lessons.js";
import { pickManager } from "../shared/meeting.js";

const STATE_KEY = "agent-lessons";
const stateKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: STATE_KEY });

/** Last write failure per agent, shown in the Lessons tab so a lesson that never reached the agent isn't silent. */
const fileErrors = new Map<string, string>();

async function readAll(ctx: PluginContext, companyId: string): Promise<Record<string, Lesson[]>> {
  return ((await ctx.state.get(stateKey(companyId)).catch(() => null)) as Record<string, Lesson[]> | null) ?? {};
}

async function people(ctx: PluginContext, companyId: string): Promise<LessonPerson[]> {
  const agents = await ctx.agents.list({ companyId, limit: 500 });
  return agents
    .filter((a) => a.status !== "terminated")
    .map((a) => ({ id: a.id, name: a.name, title: a.title ?? null, role: a.role ?? null }));
}

/** The agent's instructions entry file: the path in its adapter config, else Paperclip's usual managed location
 *  (the worker's environment is stripped, so PAPERCLIP_HOME is usually not there). */
async function instructionsFile(ctx: PluginContext, companyId: string, agentId: string): Promise<string | null> {
  const agent = await ctx.agents.get(agentId, companyId).catch(() => null);
  const configured = (agent as { adapterConfig?: { instructionsFilePath?: unknown } } | null)?.adapterConfig?.instructionsFilePath;
  if (typeof configured === "string" && configured && existsSync(configured)) return configured;
  const instance = process.env.PAPERCLIP_INSTANCE_ID || "default";
  const homes = [process.env.PAPERCLIP_HOME, join(homedir(), ".paperclip")].filter((h): h is string => !!h);
  for (const home of homes) {
    const file = join(home, "instances", instance, "companies", companyId, "agents", agentId, "instructions", "AGENTS.md");
    if (existsSync(file)) return file;
  }
  return null;
}

async function writeToInstructions(ctx: PluginContext, companyId: string, agentId: string, lessons: Lesson[]): Promise<void> {
  const key = `${companyId}:${agentId}`;
  const file = await instructionsFile(ctx, companyId, agentId);
  if (!file) {
    fileErrors.set(key, "Couldn't find this agent's instructions file, so it won't see these lessons yet.");
    return;
  }
  try {
    writeFileSync(file, withLessonsBlock(readFileSync(file, "utf8"), lessons), "utf8");
    fileErrors.delete(key);
  } catch (err) {
    fileErrors.set(key, `Couldn't update the instructions file: ${String(err instanceof Error ? err.message : err).slice(0, 160)}`);
  }
}

async function save(ctx: PluginContext, companyId: string, agentId: string, update: (list: Lesson[]) => Lesson[]): Promise<LessonsView> {
  const all = await readAll(ctx, companyId);
  const lessons = update(all[agentId] ?? []);
  await ctx.state.set(stateKey(companyId), { ...all, [agentId]: lessons });
  await writeToInstructions(ctx, companyId, agentId, lessons);
  return { lessons, fileError: fileErrors.get(`${companyId}:${agentId}`) ?? null };
}

function newLesson(verdict: LessonVerdict, text: string, by: string): Lesson {
  return { id: randomUUID(), at: new Date().toISOString(), verdict, text, by };
}

function verdictOf(value: unknown): LessonVerdict | null {
  return value === "good" || value === "needs_work" ? value : null;
}

function required(params: Record<string, unknown>, key: string): string {
  const value = String(params[key] ?? "").trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

const SEEN_KEY = "lesson-comments-seen";
const SEEN_KEEP = 200;

/** Lessons the manager wrote as "Lesson for <name> (good|needs work): ..." lines in a comment on this issue. */
async function lessonsFromComments(ctx: PluginContext, companyId: string, issueId: string, authorId: string): Promise<void> {
  const team = await people(ctx, companyId);
  if (authorId !== pickManager(team, team.map((t) => t.id))) return;
  const rows = await ctx.db.query<Record<string, unknown>>(
    `SELECT id, body FROM public.issue_comments
      WHERE company_id = $1 AND issue_id = $2 AND author_agent_id = $3 AND deleted_at IS NULL
        AND created_at > now() - interval '10 minutes'
      ORDER BY created_at DESC LIMIT 5`,
    [companyId, issueId, authorId],
  );
  const seenKey = { scopeKind: "company" as const, scopeId: companyId, stateKey: SEEN_KEY };
  const seen = ((await ctx.state.get(seenKey).catch(() => null)) as string[] | null) ?? [];
  const fresh = rows.filter((r) => !seen.includes(String(r.id)));
  if (fresh.length === 0) return;
  await ctx.state.set(seenKey, [...fresh.map((r) => String(r.id)), ...seen].slice(0, SEEN_KEEP));
  for (const row of fresh) {
    for (const found of parseLessonLines(String(row.body ?? ""))) {
      const target = findAgent(team, found.agent);
      if (!target || target.id === authorId) continue;
      await save(ctx, companyId, target.id, (list) => addLesson(list, newLesson(found.verdict, found.text, authorId)));
    }
  }
}

export function registerLessons(ctx: PluginContext): void {
  ctx.events.on("issue.comment.created", async (event) => {
    if (event.actorType !== "agent" || !event.actorId) return;
    const issueId = (event.payload as { issueId?: unknown } | null)?.issueId ?? (event.entityType === "issue" ? event.entityId : undefined);
    if (typeof issueId !== "string" || !issueId) return;
    await lessonsFromComments(ctx, event.companyId, issueId, event.actorId).catch((err) => {
      ctx.logger.warn("office: lesson comment not read", { error: String(err).slice(0, 200) });
    });
  });

  ctx.data.register(LESSONS_DATA_KEY, async (params) => {
    const p = params as Record<string, unknown>;
    const companyId = required(p, "companyId");
    const agentId = required(p, "agentId");
    const all = await readAll(ctx, companyId);
    return { lessons: all[agentId] ?? [], fileError: fileErrors.get(`${companyId}:${agentId}`) ?? null } satisfies LessonsView;
  });

  ctx.actions.register(LESSON_ADD_ACTION, async (params) => {
    const companyId = required(params, "companyId");
    const agentId = required(params, "agentId");
    const verdict = verdictOf(params.verdict);
    if (!verdict) throw new Error("Pick Good or Needs work");
    const text = cleanLessonText(String(params.text ?? ""));
    if (!text) throw new Error("Write one line on why");
    return save(ctx, companyId, agentId, (list) => addLesson(list, newLesson(verdict, text, "you")));
  });

  ctx.actions.register(LESSON_DELETE_ACTION, async (params) => {
    const companyId = required(params, "companyId");
    const agentId = required(params, "agentId");
    const lessonId = required(params, "lessonId");
    return save(ctx, companyId, agentId, (list) => list.filter((l) => l.id !== lessonId));
  });

  ctx.tools.register(
    ADD_LESSON_TOOL,
    ADD_LESSON_TOOL_SPEC,
    async (params, runCtx): Promise<ToolResult> => {
      const p = (params ?? {}) as Record<string, unknown>;
      const team = await people(ctx, runCtx.companyId);
      const managerId = pickManager(team, team.map((t) => t.id));
      if (runCtx.agentId !== managerId) return { content: "Only the manager can record lessons." };
      const target = findAgent(team, String(p.agent ?? ""));
      if (!target) return { content: `No single teammate matches "${String(p.agent ?? "")}". Use their full name.` };
      if (target.id === runCtx.agentId) return { content: "Lessons are for teammates, not yourself." };
      const verdict = verdictOf(p.verdict);
      if (!verdict) return { content: "verdict must be \"good\" or \"needs_work\"." };
      const text = cleanLessonText(String(p.lesson ?? ""));
      if (!text) return { content: "Write the lesson as one short line." };
      const view = await save(ctx, runCtx.companyId, target.id, (list) => addLesson(list, newLesson(verdict, text, runCtx.agentId)));
      return {
        content: view.fileError ? `Saved for ${target.name}, but: ${view.fileError}` : `Saved. ${target.name} will see it from their next run.`,
        data: view,
      };
    },
  );
}
