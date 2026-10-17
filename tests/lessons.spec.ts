import { describe, expect, it } from "vitest";
import { MAX_LESSONS, addLesson, cleanLessonText, findAgent, parseLessonLines, withLessonsBlock, type Lesson } from "../src/shared/lessons.js";

function lesson(n: number, verdict: Lesson["verdict"] = "good"): Lesson {
  return { id: `l${n}`, at: "2026-10-11T10:00:00.000Z", verdict, text: `lesson ${n}`, by: "you" };
}

describe("lessons list", () => {
  it("keeps the newest first and caps the list", () => {
    let list: Lesson[] = [];
    for (let i = 1; i <= MAX_LESSONS + 3; i++) list = addLesson(list, lesson(i));
    expect(list).toHaveLength(MAX_LESSONS);
    expect(list[0].id).toBe(`l${MAX_LESSONS + 3}`);
  });

  it("flattens a lesson to one capped line and strips comment markers", () => {
    expect(cleanLessonText("  forgot\n\nthe   file  ")).toBe("forgot the file");
    expect(cleanLessonText("a <!-- b --> c")).toBe("a b c");
    expect(cleanLessonText("x".repeat(500))).toHaveLength(200);
  });
});

describe("withLessonsBlock", () => {
  const original = "You are an agent.\n\n## Rules\n- be nice\n";

  it("appends the block once and leaves the rest of the file alone", () => {
    const once = withLessonsBlock(original, [lesson(1), lesson(2, "needs_work")]);
    expect(once.startsWith(original)).toBe(true);
    expect(once).toContain("- Good: lesson 1");
    expect(once).toContain("- Needs work: lesson 2");
    const twice = withLessonsBlock(once, [lesson(3)]);
    expect(twice.match(/<!-- office:lessons -->/g)).toHaveLength(1);
    expect(twice).toContain("- Good: lesson 3");
    expect(twice).not.toContain("lesson 1");
    expect(twice.startsWith(original)).toBe(true);
  });

  it("keeps text written after the block", () => {
    const withTail = `${withLessonsBlock(original, [lesson(1)])}\n## Later section\n`;
    expect(withLessonsBlock(withTail, [])).toContain("## Later section");
    expect(withLessonsBlock(withTail, [])).toContain("- (none yet)");
  });
});

describe("parseLessonLines", () => {
  it("reads lesson lines out of a review comment, ignoring the rest", () => {
    const body = [
      "Reviewed the report. Looks fine overall.",
      "Lesson for Ms. Gemini (needs work): forgot to attach the spreadsheet",
      "- **Lesson for Mr. Sonnet (good):** clear, short summary up top",
      "lesson for Ms. Lqwen (Needs_Work): check the file opens before finishing",
      "Lesson for nobody: missing verdict",
    ].join("\n");
    expect(parseLessonLines(body)).toEqual([
      { agent: "Ms. Gemini", verdict: "needs_work", text: "forgot to attach the spreadsheet" },
      { agent: "Mr. Sonnet", verdict: "good", text: "clear, short summary up top" },
      { agent: "Ms. Lqwen", verdict: "needs_work", text: "check the file opens before finishing" },
    ]);
  });
});

describe("findAgent", () => {
  const team = [
    { id: "a", name: "Ms. Gemini", title: null, role: null },
    { id: "b", name: "Mr. Sonnet", title: null, role: null },
    { id: "c", name: "Mr. Sol", title: "Manager", role: "ceo" },
  ];

  it("matches by id, exact name, or a unique part of the name", () => {
    expect(findAgent(team, "b")?.name).toBe("Mr. Sonnet");
    expect(findAgent(team, "mr. sol")?.id).toBe("c");
    expect(findAgent(team, "Gemini")?.id).toBe("a");
  });

  it("refuses an ambiguous or empty query", () => {
    expect(findAgent(team, "Mr.")).toBeNull();
    expect(findAgent(team, "  ")).toBeNull();
  });
});
