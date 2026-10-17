import { useEffect, useMemo, useRef, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import {
  EMPTY_MEETING,
  MEETING_CLOSE_ACTION,
  MEETING_DATA_KEY,
  MEETING_END_ACTION,
  MEETING_SAY_ACTION,
  MEETING_START_ACTION,
  MEETING_TICK_ACTION,
  type MeetingMessage,
  type MeetingState,
} from "../shared/meeting.js";
import type { OfficeAgent, OfficeData } from "../shared/office.js";
import { getBoardroomSeats, spreadSeats, type MeetingSeat } from "./seatMap.js";
import { meetingBubble, setMeetingSeats } from "./meetingScene.js";
import { Avatar } from "./RosterSidebar.js";
import { tokens } from "./tokens.js";

const LIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 10_000;
const BUBBLE_SECONDS = 12;
const BUBBLE_CHARS = 120;
const PANEL_WIDTH = 340;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function btn(extra?: React.CSSProperties): React.CSSProperties {
  return {
    font: "inherit", fontSize: 12.5, padding: "6px 12px", borderRadius: tokens.radius,
    border: `1px solid ${tokens.border}`, background: tokens.surface, color: tokens.foreground, cursor: "pointer", ...extra,
  };
}

const solid: React.CSSProperties = { background: tokens.primary, borderColor: tokens.primary, color: "var(--primary-foreground, white)", fontWeight: 600 };

/** Keeps the last good state: the hook's data is empty while a refresh is in flight. While a meeting is on, polls
 *  through the tick action instead, because the worker can only reach the agents while handling a request. */
function useMeeting(companyId: string) {
  const { data, refresh } = usePluginData<MeetingState>(MEETING_DATA_KEY, { companyId });
  const tick = usePluginAction(MEETING_TICK_ACTION);
  const [last, setLast] = useState<MeetingState>(EMPTY_MEETING);
  useEffect(() => {
    if (data) setLast(data);
  }, [data]);
  const liveMeeting = last.phase !== "idle";
  useEffect(() => {
    if (!liveMeeting) {
      const timer = setInterval(refresh, IDLE_POLL_MS);
      return () => clearInterval(timer);
    }
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      tick({ companyId })
        .then((next) => { if (next && typeof next === "object" && "phase" in next) setLast(next as MeetingState); })
        .catch(() => undefined)
        .finally(() => { busy = false; });
    }, LIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [liveMeeting, refresh, tick, companyId]);
  return { state: last, setState: setLast, refresh };
}

/** Seats the attendees (manager first) in the boardroom chairs; retries until the floor map has loaded. */
function useSeating(state: MeetingState): boolean | null {
  const [hasRoom, setHasRoom] = useState<boolean | null>(null);
  const key = state.phase === "idle" ? "" : [state.managerId, ...state.attendeeIds].join(",");
  useEffect(() => {
    if (!key) {
      setMeetingSeats(new Map());
      setHasRoom(null);
      return;
    }
    const order = [...new Set([state.managerId, ...state.attendeeIds])].filter((id): id is string => !!id && state.attendeeIds.includes(id));
    let tries = 0;
    const seat = (): boolean => {
      const chairs = getBoardroomSeats();
      if (chairs.length === 0) return false;
      const next = new Map<string, MeetingSeat>();
      spreadSeats(chairs, order.length).forEach((seat, i) => next.set(order[i], seat));
      setMeetingSeats(next);
      setHasRoom(true);
      return true;
    };
    if (seat()) return;
    // The floor map can load after the meeting panel; keep trying, and only say "no boardroom" after a while.
    const timer = setInterval(() => {
      tries++;
      if (seat()) clearInterval(timer);
      else if (tries === 10) setHasRoom(false);
    }, 1000);
    return () => clearInterval(timer);
  }, [key]);
  useEffect(() => () => setMeetingSeats(new Map()), []);
  return hasRoom;
}

/** Speech bubbles over seated attendees: "…" while typing, then their latest line for a few seconds. */
function useBubbles(state: MeetingState): void {
  const shown = useRef(new Map<string, string | null>());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (state.phase === "idle") { shown.current.clear(); return; }
    const timer = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(timer);
  }, [state.phase]);
  useEffect(() => {
    if (state.phase === "idle") return;
    const now = Date.now();
    for (const id of state.attendeeIds) {
      let want: string | null = null;
      if (state.typing.includes(id)) want = "";
      else {
        const latest = [...state.messages].reverse().find((m) => m.author === id && m.kind !== "system");
        if (latest && now - Date.parse(latest.at) < BUBBLE_SECONDS * 1000) want = clip(latest.text, BUBBLE_CHARS);
      }
      if (shown.current.get(id) === want) continue;
      shown.current.set(id, want);
      meetingBubble(id, want);
    }
  }, [state, tick]);
}

function MeetingPicker({ agents, onStart, onCancel, busy }: { agents: OfficeAgent[]; onStart: (ids: string[]) => void; onCancel: () => void; busy: boolean }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return (
    <div style={{ position: "absolute", top: 48, right: 10, zIndex: 20, width: 280, display: "flex", flexDirection: "column", gap: 10, padding: 12, borderRadius: tokens.radius, border: `1px solid ${tokens.border}`, background: tokens.surface, color: tokens.foreground, boxShadow: "0 8px 24px rgba(0,0,0,0.25)" }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>Call a meeting</div>
      <button disabled={busy || agents.length === 0} onClick={() => onStart(agents.map((a) => a.id))} style={btn(solid)}>
        Everyone ({agents.length})
      </button>
      <div style={{ fontSize: 12, color: tokens.mutedForeground }}>Or pick who comes:</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 240, overflowY: "auto" }}>
        {agents.map((a) => (
          <label key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 6px", borderRadius: 6, cursor: "pointer", background: picked.has(a.id) ? tokens.selected : "transparent" }}>
            <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
            <Avatar agentId={a.id} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 500 }}>{a.name}</span>
              {a.title && <span style={{ display: "block", fontSize: 11, color: tokens.mutedForeground }}>{a.title}</span>}
            </span>
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button disabled={busy || picked.size === 0} onClick={() => onStart([...picked])} style={btn({ flex: 1, ...(picked.size ? solid : {}) })}>
          Start with {picked.size || "…"}
        </button>
        <button onClick={onCancel} style={btn()}>Cancel</button>
      </div>
    </div>
  );
}

function Message({ m, byId }: { m: MeetingMessage; byId: Map<string, OfficeAgent> }) {
  if (m.kind === "system") {
    return <div style={{ fontSize: 12, color: tokens.mutedForeground, fontStyle: "italic", textAlign: "center" }}>{m.text}</div>;
  }
  const mine = m.author === "you";
  const name = mine ? "You" : byId.get(m.author)?.name ?? "Someone";
  if (m.kind === "recap") {
    return (
      <div style={{ border: `1px solid ${tokens.primary}`, borderRadius: tokens.radius, padding: "8px 10px", background: tokens.selected }}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Recap from {name}</div>
        <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{m.text}</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8, flexDirection: mine ? "row-reverse" : "row", alignItems: "flex-start" }}>
      {!mine && <Avatar agentId={m.author} />}
      <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
        <span style={{ fontSize: 11, color: tokens.mutedForeground, marginBottom: 2 }}>{name}</span>
        <div style={{ fontSize: 13, whiteSpace: "pre-wrap", padding: "6px 10px", borderRadius: 10, background: mine ? tokens.primary : tokens.accent, color: mine ? "var(--primary-foreground, white)" : tokens.foreground }}>
          {m.text}
        </div>
      </div>
    </div>
  );
}

function names(ids: string[], byId: Map<string, OfficeAgent>): string {
  const list = ids.map((id) => byId.get(id)?.name ?? "Someone");
  if (list.length <= 1) return list.join("");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The boardroom: a Meeting button on the floor, a picker, then a group chat docked over the office while the attendees sit at the table. */
export function MeetingRoom({ companyId, data }: { companyId: string; data: OfficeData | null }) {
  const { state, setState, refresh } = useMeeting(companyId);
  const start = usePluginAction(MEETING_START_ACTION);
  const say = usePluginAction(MEETING_SAY_ACTION);
  const end = usePluginAction(MEETING_END_ACTION);
  const close = usePluginAction(MEETING_CLOSE_ACTION);
  const [picking, setPicking] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const agents = data?.agents ?? [];
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const hasRoom = useSeating(state);
  useBubbles(state);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state.messages.length, state.typing.length, hidden]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    try {
      const next = (await fn()) as MeetingState | undefined;
      if (next && typeof next === "object" && "phase" in next) setState(next);
      void refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const send = () => {
    const text = draft.trim();
    if (!text || state.phase !== "open") return;
    setDraft("");
    void run(() => say({ companyId, text }));
  };

  if (state.phase === "idle") {
    return (
      <>
        <button
          type="button"
          onClick={() => setPicking((p) => !p)}
          title="Call everyone, or the people you pick, into the boardroom"
          style={btn({ position: "absolute", top: 10, right: 10, zIndex: 20, display: "flex", alignItems: "center", gap: 6, boxShadow: "0 2px 8px rgba(0,0,0,0.2)" })}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="3" y="6" width="10" height="4" rx="1" />
            <path d="M5 4v2M8 4v2M11 4v2M5 10v2M8 10v2M11 10v2" />
          </svg>
          Meeting
        </button>
        {picking && (
          <MeetingPicker
            agents={agents}
            busy={busy}
            onCancel={() => setPicking(false)}
            onStart={(ids) => { setPicking(false); setHidden(false); void run(() => start({ companyId, attendeeIds: ids })); }}
          />
        )}
        {err && <div style={{ position: "absolute", top: 48, right: 10, zIndex: 20, fontSize: 12, color: tokens.destructive, background: tokens.surface, padding: "4px 8px", borderRadius: tokens.radius }}>{err}</div>}
      </>
    );
  }

  const manager = state.managerId ? byId.get(state.managerId) : undefined;
  const status = state.phase === "open" ? "In session" : state.phase === "wrapping" ? `${manager?.name ?? "The manager"} is writing the recap…` : "Meeting over";

  if (hidden) {
    return (
      <button type="button" onClick={() => setHidden(false)} style={btn({ position: "absolute", top: 10, right: 10, zIndex: 20, boxShadow: "0 2px 8px rgba(0,0,0,0.2)", ...solid })}>
        Show meeting chat ({state.messages.filter((m) => m.kind !== "system").length})
      </button>
    );
  }

  return (
    <div
      style={{
        position: "absolute", top: 10, right: 52, bottom: 10, zIndex: 20, width: `min(${PANEL_WIDTH}px, calc(100% - 64px))`,
        display: "flex", flexDirection: "column", borderRadius: tokens.radius, border: `1px solid ${tokens.border}`,
        background: tokens.surface, color: tokens.foreground, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 12px", borderBottom: `1px solid ${tokens.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Boardroom meeting</div>
            <div style={{ fontSize: 11.5, color: tokens.mutedForeground }}>{status}</div>
          </div>
          <button onClick={() => setHidden(true)} title="Hide the chat and watch the office" style={btn({ padding: "3px 8px" })}>Hide</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {state.attendeeIds.map((id) => {
            const typing = state.typing.includes(id);
            return (
              <span key={id} style={{ display: "flex", alignItems: "center", gap: 5, padding: "2px 8px 2px 2px", borderRadius: 999, border: `1px solid ${typing ? tokens.primary : tokens.border}`, fontSize: 12 }}>
                <Avatar agentId={id} />
                {byId.get(id)?.name ?? "Agent"}
                {id === state.managerId && <span style={{ fontSize: 10, color: tokens.mutedForeground }}>manager</span>}
                {typing && <span style={{ color: tokens.primary }}>…</span>}
              </span>
            );
          })}
        </div>
        {hasRoom === false && <div style={{ fontSize: 11.5, color: tokens.mutedForeground }}>This floor has no boardroom, so the meeting runs in the chat only.</div>}
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        {state.messages.length === 0 && (
          <div style={{ fontSize: 12.5, color: tokens.mutedForeground }}>
            Everyone's at the table. Say something to start. Each person answers you, then can react to each other once, then waits for your next message.
          </div>
        )}
        {state.messages.map((m) => <Message key={m.id} m={m} byId={byId} />)}
        {state.typing.length > 0 && (
          <div style={{ fontSize: 12, color: tokens.mutedForeground }}>
            {names(state.typing, byId)} {state.typing.length === 1 ? "is" : "are"} typing…
          </div>
        )}
      </div>

      {err && <div style={{ padding: "0 12px 6px", fontSize: 12, color: tokens.destructive }}>{err}</div>}
      <div style={{ borderTop: `1px solid ${tokens.border}`, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {state.phase === "open" && (
          <div style={{ display: "flex", gap: 8 }}>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={2}
              placeholder="Message the room…"
              style={{ flex: 1, resize: "none", font: "inherit", fontSize: 13, padding: "6px 8px", borderRadius: tokens.radius, border: `1px solid ${tokens.border}`, background: tokens.background, color: tokens.foreground }}
            />
            <button disabled={busy || !draft.trim()} onClick={send} style={btn({ alignSelf: "stretch", ...(draft.trim() ? solid : {}) })}>Send</button>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          {state.phase === "open" && (
            <button disabled={busy} onClick={() => void run(() => end({ companyId }))} style={btn()}>
              End meeting{manager ? ` (${manager.name} recaps)` : ""}
            </button>
          )}
          {state.phase !== "open" && (
            <button disabled={busy} onClick={() => void run(() => close({ companyId }))} style={btn(state.phase === "ended" ? solid : {})}>
              Close and send everyone back
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
