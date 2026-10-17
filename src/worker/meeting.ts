import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  EMPTY_MEETING,
  MEETING_CLOSE_ACTION,
  MEETING_DATA_KEY,
  MEETING_END_ACTION,
  MEETING_SAY_ACTION,
  MEETING_START_ACTION,
  MEETING_TICK_ACTION,
  REPLIES_PER_MESSAGE,
  cleanReply,
  othersSpokeSince,
  pickManager,
  recapPrompt,
  turnPrompt,
  type MeetingMessage,
  type MeetingPerson,
  type MeetingState,
} from "../shared/meeting.js";

// A local model can take minutes per reply; past this the attendee is marked as not answering.
const REPLY_TIMEOUT_MS = 6 * 60_000;
const STATE_KEY = "meeting-state";

/*
 * The host only accepts calls made while the worker is handling a request (an action or data call); anything
 * sent after that request returns is refused as an "expired invocation". So nothing here calls the host in the
 * background. Every step that needs the host (open a session, send a prompt, save) runs inside an action: the
 * user's own clicks, plus `meeting-tick`, which the open meeting panel calls every couple of seconds.
 * Replies arrive as session events and only update memory; the next tick acts on them.
 */

type AskKind = "turn" | "recap";

interface Ask {
  agentId: string;
  kind: AskKind;
  round: 1 | 2;
  turn: number;
}

interface Live {
  state: MeetingState;
  /** Paperclip chat session per agent, opened on first use and closed when the meeting closes. */
  sessions: Map<string, string>;
  /** Bumped on every user message and on end; asks from an older turn are dropped before they are sent. */
  turn: number;
  /** Asks waiting to be sent. One at a time per agent: a second wakeup while a run is live can be dropped by the host. */
  pending: Ask[];
  /** Asks sent and waiting for a reply, by agent. */
  inflight: Map<string, Ask>;
  /** Replies per agent in the current turn, and whether round 2 has been queued. */
  counts: Map<string, number>;
  round2Queued: boolean;
  dirty: boolean;
  /** Runs that finished with no text on the done event (the host can announce "succeeded" before it saves the
   *  result); the next tick reads the saved result instead of dropping the reply. */
  fetches: Fetch[];
}

interface Fetch {
  ask: Ask;
  meetingId: string | null;
  name: string;
  runId: string;
  tries: number;
}

// Ticks run every 1.5s, so this gives a late-saved result about half a minute to show up.
const FETCH_TRIES = 20;

const live = new Map<string, Live>();

const stateKey = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: STATE_KEY });

function fresh(state: MeetingState): Live {
  return { state, sessions: new Map(), turn: 0, pending: [], inflight: new Map(), counts: new Map(), round2Queued: true, dirty: false, fetches: [] };
}

async function getLive(ctx: PluginContext, companyId: string): Promise<Live> {
  let m = live.get(companyId);
  if (m) return m;
  const saved = (await ctx.state.get(stateKey(companyId)).catch(() => null)) as MeetingState | null;
  // A worker restart loses replies in flight; nobody is still typing.
  m = fresh(saved ? { ...saved, typing: [] } : { ...EMPTY_MEETING });
  if (m.state.phase === "wrapping") m.state = { ...m.state, phase: "ended" };
  live.set(companyId, m);
  return m;
}

async function save(ctx: PluginContext, companyId: string, m: Live): Promise<void> {
  m.dirty = false;
  await ctx.state.set(stateKey(companyId), m.state).catch((err) => {
    ctx.logger.warn("office: meeting state not saved", { error: String(err).slice(0, 200) });
  });
}

function post(m: Live, author: string, text: string, kind: MeetingMessage["kind"] = "message"): void {
  m.state = { ...m.state, messages: [...m.state.messages, { id: randomUUID(), at: new Date().toISOString(), author, text, kind }] };
  m.dirty = true;
}

function setTyping(m: Live, agentId: string, on: boolean): void {
  const rest = m.state.typing.filter((id) => id !== agentId);
  m.state = { ...m.state, typing: on ? [...rest, agentId] : rest };
}

function errText(err: unknown): string {
  return String(err instanceof Error ? err.message : err).slice(0, 160);
}

async function people(ctx: PluginContext, companyId: string): Promise<MeetingPerson[]> {
  const agents = await ctx.agents.list({ companyId, limit: 500 });
  return agents
    .filter((a) => a.status !== "terminated")
    .map((a) => ({ id: a.id, name: a.name, title: a.title ?? null, role: a.role ?? null }));
}

/** A reply (or failure) for an ask. Memory only: this runs from a session event, outside any request. */
function settle(m: Live, meetingId: string | null, ask: Ask, name: string, text: string | null, error?: string): void {
  if (m.inflight.get(ask.agentId) !== ask) return;
  m.inflight.delete(ask.agentId);
  if (m.state.id !== meetingId) return;
  setTyping(m, ask.agentId, false);
  const reply = cleanReply(text, name);
  if (ask.kind === "recap") {
    if (reply) post(m, ask.agentId, reply, "recap");
    else post(m, "system", `${name} couldn't write the recap${error ? ` (${error})` : ""}.`, "system");
    m.state = { ...m.state, phase: "ended" };
    m.dirty = true;
    return;
  }
  if (m.state.phase !== "open") return;
  if (reply) {
    post(m, ask.agentId, reply);
    if (ask.turn === m.turn) m.counts.set(ask.agentId, (m.counts.get(ask.agentId) ?? 0) + 1);
  } else if (error && ask.round === 1) {
    post(m, "system", `${name} couldn't answer (${error}).`, "system");
  }
  m.dirty = true;
}

/** Sends one ask. Must run inside a request: opening the session and the wakeup are host calls. */
async function send(ctx: PluginContext, companyId: string, m: Live, ask: Ask, team: Map<string, MeetingPerson>): Promise<void> {
  const me = team.get(ask.agentId);
  if (!me) return;
  const attendees = m.state.attendeeIds.map((id) => team.get(id)).filter((p): p is MeetingPerson => !!p);
  const prompt = ask.kind === "recap" ? recapPrompt(me, attendees, m.state.messages) : turnPrompt(me, attendees, m.state.messages, ask.round);
  const meetingId = m.state.id;
  m.inflight.set(ask.agentId, ask);
  setTyping(m, ask.agentId, true);
  const fail = (error: string) => settle(m, meetingId, ask, me.name, null, error);
  const sessionFor = async (fresh: boolean): Promise<string> => {
    const cached = m.sessions.get(ask.agentId);
    if (cached && !fresh) return cached;
    const sessionId = (await ctx.agents.sessions.create(ask.agentId, companyId, { reason: "Boardroom meeting" })).sessionId;
    m.sessions.set(ask.agentId, sessionId);
    return sessionId;
  };
  const sendOnce = async (sessionId: string): Promise<void> => {
    const timer = setTimeout(() => fail("no answer in time"), REPLY_TIMEOUT_MS);
    try {
      await ctx.agents.sessions.sendMessage(sessionId, companyId, {
        prompt,
        reason: "Boardroom meeting",
        onEvent: (e) => {
          if (e.eventType === "done") {
            clearTimeout(timer);
            if (e.message?.trim()) settle(m, meetingId, ask, me.name, e.message);
            else m.fetches.push({ ask, meetingId, name: me.name, runId: e.runId, tries: 0 });
          }
          else if (e.eventType === "error") { clearTimeout(timer); fail(e.message ?? "run failed"); }
        },
      });
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  };
  try {
    try {
      await sendOnce(await sessionFor(false));
    } catch (err) {
      // The host can drop a session the meeting still remembers (server restart, idle
      // cleanup, agent config change). Open a fresh one and try once more.
      if (!/session not found/i.test(errText(err))) throw err;
      ctx.logger.info("office: meeting session was gone, opening a new one", { agentId: ask.agentId });
      await sendOnce(await sessionFor(true));
    }
  } catch (err) {
    ctx.logger.warn("office: meeting ask not sent", { agentId: ask.agentId, error: String(err).slice(0, 300) });
    fail(errText(err));
  }
}

function resultText(result: unknown): string | null {
  const r = (typeof result === "string" ? JSON.parse(result) : result) as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  // "stdout" covers command-type agents (Paperclip's process adapter, e.g. the Antigravity bridge).
  for (const key of ["summary", "result", "message", "stdout"]) {
    const v = r[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
}

/** Reads the saved result of runs whose done event came without text. */
async function fetchLateReplies(ctx: PluginContext, m: Live): Promise<void> {
  if (m.fetches.length === 0) return;
  const waiting = m.fetches;
  m.fetches = [];
  for (const f of waiting) {
    let text: string | null = null;
    try {
      const rows = await ctx.db.query<Record<string, unknown>>(`SELECT result_json FROM public.heartbeat_runs WHERE id = $1`, [f.runId]);
      text = resultText(rows[0]?.result_json ?? null);
    } catch (err) {
      ctx.logger.warn("office: meeting reply not read", { runId: f.runId, error: String(err).slice(0, 200) });
    }
    if (text) settle(m, f.meetingId, f.ask, f.name, text);
    else if (f.tries + 1 >= FETCH_TRIES) settle(m, f.meetingId, f.ask, f.name, null, "its reply was lost");
    else m.fetches.push({ ...f, tries: f.tries + 1 });
  }
}

/** Moves the meeting forward: collect late replies, queue round 2 once round 1 is in, send whatever can go, save. */
async function pump(ctx: PluginContext, companyId: string, m: Live): Promise<void> {
  await fetchLateReplies(ctx, m);
  if (m.state.phase === "open" && !m.round2Queued) {
    const round1Left = m.pending.some((a) => a.turn === m.turn && a.round === 1)
      || [...m.inflight.values()].some((a) => a.turn === m.turn && a.round === 1);
    if (!round1Left) {
      m.round2Queued = true;
      for (const id of m.state.attendeeIds) {
        if ((m.counts.get(id) ?? 0) < REPLIES_PER_MESSAGE && othersSpokeSince(m.state.messages, id)) {
          m.pending.push({ agentId: id, kind: "turn", round: 2, turn: m.turn });
        }
      }
    }
  }
  // Older turns' asks that never went out are stale; a recap survives the turn bump that ending the meeting causes.
  m.pending = m.pending.filter((a) => a.kind === "recap" || (a.turn === m.turn && m.state.phase === "open"));
  const ready = m.pending.filter((a) => !m.inflight.has(a.agentId));
  if (ready.length > 0) {
    const sending = new Set(ready);
    m.pending = m.pending.filter((a) => !sending.has(a));
    const team = new Map((await people(ctx, companyId)).map((p) => [p.id, p]));
    await Promise.all(ready.map((a) => send(ctx, companyId, m, a, team)));
    m.dirty = true;
  }
  if (m.dirty) await save(ctx, companyId, m);
}

function companyOf(params: Record<string, unknown>): string {
  const companyId = String(params.companyId ?? "");
  if (!companyId) throw new Error("companyId is required");
  return companyId;
}

async function closeSessions(ctx: PluginContext, companyId: string, m: Live): Promise<void> {
  const ids = [...m.sessions.values()];
  m.sessions.clear();
  await Promise.all(ids.map((id) => ctx.agents.sessions.close(id, companyId).catch(() => undefined)));
}

export function registerMeeting(ctx: PluginContext): void {
  ctx.data.register(MEETING_DATA_KEY, async (params) => {
    const m = await getLive(ctx, companyOf(params as Record<string, unknown>));
    return m.state;
  });

  ctx.actions.register(MEETING_TICK_ACTION, async (params) => {
    const companyId = companyOf(params);
    const m = await getLive(ctx, companyId);
    if (m.state.phase !== "idle") await pump(ctx, companyId, m);
    return m.state;
  });

  ctx.actions.register(MEETING_START_ACTION, async (params) => {
    const companyId = companyOf(params);
    const m = await getLive(ctx, companyId);
    const team = await people(ctx, companyId);
    const wanted = Array.isArray(params.attendeeIds) ? params.attendeeIds.map(String) : team.map((p) => p.id);
    const attendeeIds = team.filter((p) => wanted.includes(p.id)).map((p) => p.id);
    if (attendeeIds.length === 0) throw new Error("Pick at least one agent for the meeting");
    await closeSessions(ctx, companyId, m);
    const next = fresh({
      ...EMPTY_MEETING,
      id: randomUUID(),
      phase: "open",
      attendeeIds,
      managerId: pickManager(team, attendeeIds),
      startedAt: new Date().toISOString(),
    });
    live.set(companyId, next);
    await save(ctx, companyId, next);
    return next.state;
  });

  ctx.actions.register(MEETING_SAY_ACTION, async (params) => {
    const companyId = companyOf(params);
    const text = String(params.text ?? "").trim();
    if (!text) throw new Error("Say something first");
    const m = await getLive(ctx, companyId);
    if (m.state.phase !== "open") throw new Error("No meeting is open");
    post(m, "you", text);
    m.turn++;
    m.counts = new Map();
    m.round2Queued = false;
    m.pending = m.state.attendeeIds.map((agentId) => ({ agentId, kind: "turn" as const, round: 1 as const, turn: m.turn }));
    await pump(ctx, companyId, m);
    return m.state;
  });

  ctx.actions.register(MEETING_END_ACTION, async (params) => {
    const companyId = companyOf(params);
    const m = await getLive(ctx, companyId);
    if (m.state.phase !== "open") return m.state;
    m.turn++;
    const said = m.state.messages.some((msg) => msg.kind === "message");
    const managerId = m.state.managerId;
    if (managerId && said) {
      m.state = { ...m.state, phase: "wrapping", typing: m.state.typing.filter((id) => m.inflight.has(id)) };
      m.pending = [{ agentId: managerId, kind: "recap", round: 1, turn: m.turn }];
    } else {
      m.state = { ...m.state, phase: "ended", typing: [] };
      m.pending = [];
    }
    m.dirty = true;
    await pump(ctx, companyId, m);
    return m.state;
  });

  ctx.actions.register(MEETING_CLOSE_ACTION, async (params) => {
    const companyId = companyOf(params);
    const m = await getLive(ctx, companyId);
    await closeSessions(ctx, companyId, m);
    const next = fresh({ ...EMPTY_MEETING });
    live.set(companyId, next);
    await save(ctx, companyId, next);
    return next.state;
  });
}
