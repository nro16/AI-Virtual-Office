export const LESSONS_DATA_KEY = "lessons";
export const LESSON_ADD_ACTION = "lesson-add";
export const LESSON_DELETE_ACTION = "lesson-delete";
export const ADD_LESSON_TOOL = "office_add_lesson";

/** Declared in the manifest and registered by the worker; one copy so the two can't drift. */
export const ADD_LESSON_TOOL_SPEC = {
  displayName: "Record a lesson",
  description: "Manager only: after reviewing a teammate's finished work, save one short lesson to that teammate's instructions so they repeat what went well or avoid the mistake next time.",
  parametersSchema: {
    type: "object",
    properties: {
      agent: { type: "string", description: "The teammate's name (e.g. \"Ms. Gemini\") or agent id." },
      verdict: { type: "string", enum: ["good", "needs_work"], description: "good = keep doing this; needs_work = avoid this next time." },
      lesson: { type: "string", description: "One short line on what to repeat or avoid, specific enough to act on." },
    },
    required: ["agent", "verdict", "lesson"],
  },
};

/** Only the newest few go in an agent's instructions: they're read on every run, and the Hermes adapter
 *  passes the whole prompt on the Windows command line, which has a length cap. */
export const MAX_LESSONS = 10;
export const LESSON_MAX_CHARS = 200;

export type LessonVerdict = "good" | "needs_work";

export interface Lesson {
  id: string;
  at: string;
  verdict: LessonVerdict;
  text: string;
  /** "you" for the board user, otherwise the agent id that recorded it (the manager). */
  by: string;
}

export interface LessonsView {
  lessons: Lesson[];
  /** Null when the lessons reached the agent's instructions file; otherwise why they didn't. */
  fileError: string | null;
}

const START = "<!-- office:lessons -->";
const END = "<!-- /office:lessons -->";

/** One line, trimmed and capped, so a lesson can't break the markdown block or bloat the prompt. */
export function cleanLessonText(text: string): string {
  const flat = text.replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim();
  return flat.length > LESSON_MAX_CHARS ? `${flat.slice(0, LESSON_MAX_CHARS - 1).trimEnd()}…` : flat;
}

/** Newest first, capped. */
export function addLesson(list: Lesson[], lesson: Lesson): Lesson[] {
  return [lesson, ...list].slice(0, MAX_LESSONS);
}

export function lessonsBlock(lessons: Lesson[]): string {
  const lines = [
    START,
    "## Lessons from your past work",
    "",
    "Feedback from the board and your manager on work you finished, newest first. Repeat what went well; avoid what didn't.",
    "",
    ...(lessons.length
      ? lessons.map((l) => `- ${l.verdict === "good" ? "Good" : "Needs work"}: ${l.text}`)
      : ["- (none yet)"]),
    END,
  ];
  return lines.join("\n");
}

/** Replaces the office's lessons block in an instructions file, or appends it; the rest of the file is untouched. */
export function withLessonsBlock(fileText: string, lessons: Lesson[]): string {
  const block = lessonsBlock(lessons);
  const start = fileText.indexOf(START);
  const end = fileText.indexOf(END);
  if (start !== -1 && end > start) return fileText.slice(0, start) + block + fileText.slice(end + END.length);
  const base = fileText.endsWith("\n") ? fileText : `${fileText}\n`;
  return `${base}\n${block}\n`;
}

/** The line the manager writes in a review comment: "Lesson for Ms. Gemini (needs work): forgot the file".
 *  Plugin tools need a project-scoped run, and runs outside projects can't call them, so comments are the
 *  path that always works. Markdown bullets and bold around the prefix are tolerated. */
const LESSON_LINE = /^[\s>*_-]*lesson for\s+(.+?)\s*\(\s*(good|needs[\s_-]*work)\s*\)[\s*_]*:[\s*_]*(.+)$/i;

export function parseLessonLines(body: string): Array<{ agent: string; verdict: LessonVerdict; text: string }> {
  const out: Array<{ agent: string; verdict: LessonVerdict; text: string }> = [];
  for (const line of body.split(/\r?\n/)) {
    const m = LESSON_LINE.exec(line);
    if (!m) continue;
    const text = cleanLessonText(m[3].replace(/[*_`]+$/g, ""));
    if (text) out.push({ agent: m[1].replace(/[*_`]/g, "").trim(), verdict: /good/i.test(m[2]) ? "good" : "needs_work", text });
  }
  return out;
}

export interface LessonPerson {
  id: string;
  name: string;
  title: string | null;
  role: string | null;
}

/** An agent by id, exact name, or a name that contains the text ("Gemini" finds "Ms. Gemini"); null when unclear. */
export function findAgent(people: LessonPerson[], query: string): LessonPerson | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const byId = people.find((p) => p.id === query.trim());
  if (byId) return byId;
  const exact = people.filter((p) => p.name.toLowerCase() === q);
  if (exact.length === 1) return exact[0];
  const partial = people.filter((p) => p.name.toLowerCase().includes(q));
  return partial.length === 1 ? partial[0] : null;
}
