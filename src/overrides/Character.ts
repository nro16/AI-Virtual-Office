// Override of upstream Character.ts: registers/unregisters each live sprite so
// src/ui/agentLabels.ts can read its world position every frame (nameplates,
// issue tags and state rings must follow the character as it walks).
// Also seats agents at their desks when a floor is first built (no walk-in on every
// tab switch), and lets a boardroom meeting take the avatar over: while seated in a
// meeting, the floor's own commands (desk, wander, errands, thoughts) are ignored.
import { Character as UpstreamCharacter } from "../../vendor/munder-difflin/src/renderer/src/scene/office/Character.js";
import type { Direction } from "../../vendor/munder-difflin/src/renderer/src/scene/office/CharacterSprite.js";
import { registerCharacter, unregisterCharacter } from "../ui/agentLabels.js";
import { registerMeetingCharacter, unregisterMeetingCharacter, type MeetingCharacter } from "../ui/meetingScene.js";
import type { MeetingSeat } from "../ui/seatMap.js";
import { useStore } from "../adapters/store.js";
import { t } from "../adapters/i18n.js";

const QUIET = () => new Set([t("office.activity.idle"), t("office.activity.waiting")]);

export { paintCup } from "../../vendor/munder-difflin/src/renderer/src/scene/office/Character.js";

// Agents created while a floor is first being built (e.g. returning to the Office tab) start at their desks;
// only agents that appear later walk in from the door. Keyed by the floor's map renderer, one per scene build.
const ARRIVE_SEATED_MS = 8000;
const floorBuiltAt = new WeakMap<object, number>();

function arriveSeatedOnBuild(options: ConstructorParameters<typeof UpstreamCharacter>[0]): ConstructorParameters<typeof UpstreamCharacter>[0] {
  const floor = options.mapRenderer as unknown as object;
  const builtAt = floorBuiltAt.get(floor) ?? performance.now();
  if (!floorBuiltAt.has(floor)) floorBuiltAt.set(floor, builtAt);
  return performance.now() - builtAt < ARRIVE_SEATED_MS ? { ...options, spawnTile: options.seatTile } : options;
}

export class Character extends UpstreamCharacter implements MeetingCharacter {
  private meetingSeat: MeetingSeat | null = null;
  private meetingDriving = false;

  constructor(...args: ConstructorParameters<typeof UpstreamCharacter>) {
    super(arriveSeatedOnBuild(args[0]));
    registerCharacter(this.agentId, this);
    registerMeetingCharacter(this.agentId, this);
  }

  /** True while a meeting owns this avatar and the call came from the floor, not the meeting. */
  private get held(): boolean {
    return this.meetingSeat !== null && !this.meetingDriving;
  }

  private drive(fn: () => void): void {
    this.meetingDriving = true;
    try {
      fn();
    } finally {
      this.meetingDriving = false;
    }
  }

  enterMeeting(seat: MeetingSeat): void {
    this.meetingSeat = seat;
    this.drive(() => {
      super.setStatusGlyph("none");
      super.hideThought();
      super.setIdle();
      super.walkToAndThen(seat.tile, () => {
        if (this.meetingSeat === seat) this.drive(() => super.sitInPlace(seat.facing));
      });
    });
  }

  /** Back to what the agent's current state asks for; the floor takes over again on its next change. */
  leaveMeeting(): void {
    if (!this.meetingSeat) return;
    this.meetingSeat = null;
    super.hideThought();
    const agent = useStore.getState().agents.find((a) => a.id === this.agentId);
    const status = agent?.status ?? "idle";
    if (agent?.isGod || status === "working" || status === "thinking" || status === "compacting") super.sitAtDesk(true);
    else if (status === "idle" || status === "success") super.startWandering();
    else if (status === "ghost") super.setIdle();
    else super.sitAtDesk(false);
  }

  meetingSay(text: string): void {
    this.drive(() => super.showThought(text));
  }

  meetingQuiet(): void {
    this.drive(() => super.hideThought());
  }

  override moveTo(tile: { x: number; y: number }): void {
    if (!this.held) super.moveTo(tile);
  }

  override walkToAndThen(tile: { x: number; y: number }, callback: () => void): void {
    if (!this.held) super.walkToAndThen(tile, callback);
  }

  override walkToTile(tile: { x: number; y: number }): void {
    if (!this.held) super.walkToTile(tile);
  }

  override sitAtDesk(working: boolean): void {
    if (!this.held) super.sitAtDesk(working);
  }

  override sitInPlace(dir: Direction): void {
    if (!this.held) super.sitInPlace(dir);
  }

  override startWandering(): void {
    if (!this.held) super.startWandering();
  }

  override setIdle(): void {
    if (!this.held) super.setIdle();
  }

  override faceDirection(dir: Direction): void {
    if (!this.held) super.faceDirection(dir);
  }

  override cheer(): void {
    if (!this.held) super.cheer();
  }

  override startWatering(seconds: number, onDone?: () => void): void {
    if (!this.held) super.startWatering(seconds, onDone);
  }

  override startSmoking(seconds: number, onDone?: () => void): void {
    if (!this.held) super.startSmoking(seconds, onDone);
  }

  override showThought(text: string, tool?: string): void {
    if (this.held) return;
    if (QUIET().has(text.trim())) {
      this.hideThought();
      return;
    }
    super.showThought(text, tool);
  }

  override hideThought(): void {
    if (!this.held) super.hideThought();
  }

  override destroy(): void {
    unregisterCharacter(this.agentId);
    unregisterMeetingCharacter(this.agentId, this);
    super.destroy();
  }
}
