export const MEETING_DATA_KEY = "meeting";
export const MEETING_START_ACTION = "meeting-start";
export const MEETING_SAY_ACTION = "meeting-say";
export const MEETING_END_ACTION = "meeting-end";
export const MEETING_CLOSE_ACTION = "meeting-close";
/** Called by the open meeting panel every couple of seconds; the worker does its host work (send, save) here. */
export const MEETING_TICK_ACTION = "meeting-tick";

/** Each attendee answers at most this many times per message the user sends: once to the user, once to the room. */
export const REPLIES_PER_MESSAGE = 2;
const REPLY_MAX_CHARS = 600;
// Kept short on purpose: the Hermes adapter passes the whole prompt on the command line, and Windows caps that.
const TRANSCRIPT_TAIL = 20;
const RECAP_TAIL = 40;
const TRANSCRIPT_LINE_MAX = 300;

export type MeetingPhase = "idle" | "open" | "wrapping" | "ended";

export interface MeetingMessage {
  id: string;
  at: string;
  /** "you" for the user, "system" for notices, otherwise the agent id. */
  author: string;
  text: string;
  kind: "message" | "recap" | "system";
}

export interface MeetingState {
  id: string | null;
  phase: MeetingPhase;
  attendeeIds: string[];
  managerId: string | null;
  messages: MeetingMessage[];
  /** Agents with a reply in flight. */
  typing: string[];
  startedAt: string | null;
}

export const EMPTY_MEETING: MeetingState = {
  id: null,
  phase: "idle",
  attendeeIds: [],
  managerId: null,
  messages: [],
  typing: [],
  startedAt: null,
};

export interface MeetingPerson {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
}

/** The agent titled Manager, else the CEO role, else the first attendee. */
export function pickManager(agents: MeetingPerson[], attendeeIds: string[]): string | null {
  const byTitle = agents.find((a) => /manager/i.test(a.title ?? ""));
  if (byTitle) return byTitle.id;
  const ceo = agents.find((a) => (a.role ?? "").toLowerCase() === "ceo");
  if (ceo) return ceo.id;
  return attendeeIds[0] ?? null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function who(p: MeetingPerson): string {
  return p.title ? `${p.name} (${p.title})` : p.name;
}

export function transcriptText(messages: MeetingMessage[], byId: Map<string, MeetingPerson>, tail = TRANSCRIPT_TAIL): string {
  const lines = messages
    .filter((m) => m.kind !== "system")
    .slice(-tail)
    .map((m) => {
      const name = m.author === "you" ? "User" : byId.get(m.author)?.name ?? "Someone";
      return `${name}${m.kind === "recap" ? " (recap)" : ""}: ${clip(m.text, TRANSCRIPT_LINE_MAX)}`;
    });
  return lines.length ? lines.join("\n") : "(nothing said yet)";
}

const GROUND_RULES = [
  "This is a conversation only. Do not use tools, do not create, change or comment on issues, and do not start any work, unless the user explicitly asks you by name to do something.",
  "Answer as yourself in 1 to 3 short sentences of plain text: no headings, no lists, no sign-off.",
  "You can talk to the user or to a colleague by name, for example \"Ms. Gemini, I'd add...\".",
];

/** The prompt for one attendee's turn. Round 1 answers the user from their own role; round 2 reacts to a
 *  colleague by name. A softer "only if useful, else PASS" round 2 made every agent pass, every time. */
export function turnPrompt(me: MeetingPerson, attendees: MeetingPerson[], messages: MeetingMessage[], round: 1 | 2): string {
  const byId = new Map(attendees.map((a) => [a.id, a]));
  const others = attendees.filter((a) => a.id !== me.id).map(who);
  const lines = [
    `You are ${who(me)}, in a live boardroom meeting in the office with the user (your boss)${others.length ? ` and ${others.join(", ")}` : ""}.`,
    ...GROUND_RULES,
    round === 1
      ? "Reply to the user's latest message. Your colleagues are answering at the same time without seeing your reply, so speak from your own role and add what only you would add."
      : "Your colleagues have now answered too. Respond to at least one of them by name: agree and add something new, disagree and say why, or ask them a question. Keep it to 1 or 2 sentences. Reply with exactly PASS only if they already said everything you would say.",
    "",
    "Meeting so far (latest last):",
    transcriptText(messages, byId),
    "",
    `Your reply as ${me.name}:`,
  ];
  return lines.join("\n");
}

/** The manager's closing recap. Tasks only when the user asked for them during the meeting. */
export function recapPrompt(manager: MeetingPerson, attendees: MeetingPerson[], messages: MeetingMessage[]): string {
  const byId = new Map([...attendees, manager].map((a) => [a.id, a]));
  return [
    `You are ${who(manager)}. The boardroom meeting with the user and ${attendees.filter((a) => a.id !== manager.id).map(who).join(", ") || "the team"} has just ended.`,
    "Write a short recap for the user: the key points, any decisions, and open questions. At most 6 short lines, plain text.",
    "Only if the user explicitly asked for tasks during the meeting, and they were not created yet, create them now as Paperclip issues and list them in the recap. Otherwise do not create, change or comment on anything.",
    "",
    "Meeting transcript (latest last):",
    transcriptText(messages, byId, RECAP_TAIL),
    "",
    "Your recap:",
  ].join("\n");
}

/** Null when the agent passed or said nothing. Strips a leading "Name:" the model may echo. */
export function cleanReply(text: string | null | undefined, name: string): string | null {
  if (!text) return null;
  let t = text.trim();
  const echo = new RegExp(`^\\**${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\**\\s*:\\s*`, "i");
  t = t.replace(echo, "").trim();
  if (!t || /^pass\b[.!]?$/i.test(t)) return null;
  return t.length > REPLY_MAX_CHARS ? `${t.slice(0, REPLY_MAX_CHARS - 1).trimEnd()}…` : t;
}

/** Has anyone else spoken since this attendee's last message? */
export function othersSpokeSince(messages: MeetingMessage[], agentId: string): boolean {
  let last = -1;
  messages.forEach((m, i) => { if (m.author === agentId) last = i; });
  return messages.slice(last + 1).some((m) => m.kind === "message" && m.author !== agentId && m.author !== "you" && m.author !== "system");
}
