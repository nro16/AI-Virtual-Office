import { describe, expect, it } from "vitest";
import {
  cleanReply,
  othersSpokeSince,
  pickManager,
  recapPrompt,
  turnPrompt,
  type MeetingMessage,
  type MeetingPerson,
} from "../src/shared/meeting.js";
import { getBoardroomSeats, setSeatSceneMap, spreadSeats, type MeetingSeat } from "../src/ui/seatMap.js";

const sol: MeetingPerson = { id: "sol", name: "Mr. Sol", title: "Manager", role: "ceo" };
const gemini: MeetingPerson = { id: "gem", name: "Ms. Gemini", title: "Research & Data Lead", role: "general" };
const sonnet: MeetingPerson = { id: "son", name: "Mr. Sonnet", title: null, role: "general" };

function msg(author: string, text: string, kind: MeetingMessage["kind"] = "message"): MeetingMessage {
  return { id: `${author}-${text}`, at: "2026-10-11T10:00:00.000Z", author, text, kind };
}

describe("pickManager", () => {
  it("prefers the Manager title, then the CEO role, then the first attendee", () => {
    expect(pickManager([gemini, sol], ["gem"])).toBe("sol");
    expect(pickManager([gemini, { ...sol, title: null }], ["gem"])).toBe("sol");
    expect(pickManager([gemini, sonnet], ["son", "gem"])).toBe("son");
    expect(pickManager([], [])).toBeNull();
  });
});

describe("cleanReply", () => {
  it("treats PASS and empty output as no reply", () => {
    expect(cleanReply("PASS", "Ms. Gemini")).toBeNull();
    expect(cleanReply("  pass. ", "Ms. Gemini")).toBeNull();
    expect(cleanReply("", "Ms. Gemini")).toBeNull();
    expect(cleanReply(null, "Ms. Gemini")).toBeNull();
  });

  it("keeps a reply that merely starts with the word pass", () => {
    expect(cleanReply("Pass the numbers to Mr. Sol first.", "Ms. Gemini")).toBe("Pass the numbers to Mr. Sol first.");
  });

  it("strips an echoed name prefix and caps the length", () => {
    expect(cleanReply("**Ms. Gemini**: I agree.", "Ms. Gemini")).toBe("I agree.");
    expect(cleanReply("x".repeat(900), "Ms. Gemini")!.length).toBe(600);
  });
});

describe("othersSpokeSince", () => {
  it("is true only when another agent spoke after this agent's last line", () => {
    const base = [msg("you", "hi"), msg("gem", "hello")];
    expect(othersSpokeSince(base, "gem")).toBe(false);
    expect(othersSpokeSince([...base, msg("son", "hey")], "gem")).toBe(true);
    expect(othersSpokeSince([...base, msg("you", "and?")], "gem")).toBe(false);
    expect(othersSpokeSince([...base, msg("system", "x", "system")], "gem")).toBe(false);
  });
});

describe("prompts", () => {
  const messages = [msg("you", "What should we ship next?"), msg("gem", "The data export.")];

  it("tells each attendee who is present and keeps tools off", () => {
    const p = turnPrompt(sonnet, [sol, gemini, sonnet], messages, 1);
    expect(p).toContain("You are Mr. Sonnet");
    expect(p).toContain("Mr. Sol (Manager)");
    expect(p).toContain("Do not use tools");
    expect(p).toContain("User: What should we ship next?");
    expect(p).toContain("Ms. Gemini: The data export.");
    expect(p).not.toContain("PASS");
  });

  it("lets round 2 pass", () => {
    expect(turnPrompt(sonnet, [sol, gemini, sonnet], messages, 2)).toContain("exactly PASS");
  });

  it("only allows tasks in the recap when the user asked for them", () => {
    const p = recapPrompt(sol, [gemini, sonnet], messages);
    expect(p).toContain("Only if the user explicitly asked for tasks");
    expect(p).toContain("Ms. Gemini (Research & Data Lead)");
  });
});

describe("getBoardroomSeats", () => {
  it("finds the chairs around the table, facing it, paired across, ends last", () => {
    const width = 9, height = 7, ts = 16;
    const collision = new Array(width * height).fill(0);
    const block = (x: number, y: number) => { collision[y * width + x] = 1; };
    for (let x = 1; x <= 7; x++) block(x, 1); // wall decor along the room's top edge
    for (let x = 3; x <= 5; x++) block(x, 3); // the table
    const map = {
      width, height, tilewidth: ts,
      layers: [
        { name: "collision", data: collision },
        { name: "zones", objects: [{ name: "boardroom", x: 1 * ts, y: 1 * ts, width: 7 * ts, height: 5 * ts }] },
      ],
    };
    setSeatSceneMap(map, []);
    expect(getBoardroomSeats()).toEqual([
      { tile: { x: 3, y: 2 }, facing: "down" },
      { tile: { x: 3, y: 4 }, facing: "up" },
      { tile: { x: 4, y: 2 }, facing: "down" },
      { tile: { x: 4, y: 4 }, facing: "up" },
      { tile: { x: 5, y: 2 }, facing: "down" },
      { tile: { x: 5, y: 4 }, facing: "up" },
      { tile: { x: 2, y: 3 }, facing: "right" },
      { tile: { x: 6, y: 3 }, facing: "left" },
    ]);
  });

  it("finds a table that sits below the marked boardroom rows", () => {
    const width = 9, height = 12, ts = 16;
    const collision = new Array(width * height).fill(0);
    const block = (x: number, y: number) => { collision[y * width + x] = 1; };
    for (let x = 0; x < width; x++) { block(x, 0); block(x, 9); } // room walls above and below
    for (let x = 3; x <= 5; x++) { block(x, 5); block(x, 6); } // a two-row table under the marked area
    const map = {
      width, height, tilewidth: ts,
      layers: [
        { name: "collision", data: collision },
        { name: "zones", objects: [{ name: "boardroom", x: 0, y: 1 * ts, width: 9 * ts, height: 4 * ts }] },
      ],
    };
    setSeatSceneMap(map, []);
    const seats = getBoardroomSeats();
    expect(seats.slice(0, 2)).toEqual([
      { tile: { x: 3, y: 4 }, facing: "down" },
      { tile: { x: 3, y: 7 }, facing: "up" },
    ]);
    expect(seats).toHaveLength(10); // 3 above, 3 below, 2 at each end
  });

  it("spreads a small group along the table, across from each other", () => {
    const chairs: MeetingSeat[] = [];
    for (let x = 0; x < 5; x++) chairs.push({ tile: { x, y: 0 }, facing: "down" }, { tile: { x, y: 2 }, facing: "up" });
    chairs.push({ tile: { x: -1, y: 1 }, facing: "right" });
    expect(spreadSeats(chairs, 4).map((s) => s.tile)).toEqual([{ x: 1, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 0 }, { x: 3, y: 2 }]);
    expect(spreadSeats(chairs, 1).map((s) => s.tile)).toEqual([{ x: 2, y: 0 }]);
    expect(spreadSeats(chairs, 10)).toHaveLength(10);
    expect(spreadSeats(chairs, 11)).toHaveLength(11);
  });

  it("returns nothing when the floor has no boardroom", () => {
    setSeatSceneMap({ width: 2, height: 2, tilewidth: 16, layers: [] }, []);
    expect(getBoardroomSeats()).toEqual([]);
  });
});
