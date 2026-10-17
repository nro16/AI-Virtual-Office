import type { MeetingSeat } from "./seatMap.js";

/** What the Character override exposes so a meeting can take an avatar over and hand it back. */
export interface MeetingCharacter {
  enterMeeting(seat: MeetingSeat): void;
  leaveMeeting(): void;
  /** Empty text shows the animated "…" (typing). */
  meetingSay(text: string): void;
  meetingQuiet(): void;
}

const characters = new Map<string, MeetingCharacter>();
const seats = new Map<string, MeetingSeat>();

/** Called from the Character constructor; an avatar created mid-meeting (scene remount) heads straight to its chair. */
export function registerMeetingCharacter(agentId: string, c: MeetingCharacter): void {
  characters.set(agentId, c);
  const seat = seats.get(agentId);
  if (seat) c.enterMeeting(seat);
}

export function unregisterMeetingCharacter(agentId: string, c: MeetingCharacter): void {
  if (characters.get(agentId) === c) characters.delete(agentId);
}

/** The full set of seated attendees; anyone dropped from it goes back to normal office life. */
export function setMeetingSeats(next: Map<string, MeetingSeat>): void {
  for (const id of [...seats.keys()]) {
    if (next.has(id)) continue;
    seats.delete(id);
    characters.get(id)?.leaveMeeting();
  }
  for (const [id, seat] of next) {
    const prev = seats.get(id);
    if (prev && prev.tile.x === seat.tile.x && prev.tile.y === seat.tile.y) continue;
    seats.set(id, seat);
    characters.get(id)?.enterMeeting(seat);
  }
}

/** Speech bubble over an attendee: text, "" for typing, null to clear. */
export function meetingBubble(agentId: string, text: string | null): void {
  if (!seats.has(agentId)) return;
  const c = characters.get(agentId);
  if (!c) return;
  if (text === null) c.meetingQuiet();
  else c.meetingSay(text);
}
