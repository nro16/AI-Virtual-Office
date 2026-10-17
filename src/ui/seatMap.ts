import { assignSeats, resolveSeatTiles, type Tile, type ZoneRect } from "../layout/seatAssignment.js";
import { findPath } from "../../vendor/munder-difflin/src/renderer/src/scene/office/pathfinding.js";

const TILE_ID_MASK = 0x1fffffff;
const BOARDROOM_ZONE = "boardroom";

interface MapObject {
  name: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}
interface MapLayer {
  name: string;
  type?: string;
  data?: number[];
  objects?: MapObject[];
}
interface SceneMap {
  width: number;
  height: number;
  tilewidth: number;
  layers: MapLayer[];
}

let sceneMap: SceneMap | null = null;
let seatNames: string[] = [];

/** Records the map + theme seat order the floor is about to render, so the heatmap can find the
 *  same desk tiles upstream's OfficeFloor claims. Called alongside wallPlaque's setSceneMap. */
export function setSeatSceneMap(map: unknown, primarySeatNames: string[]): void {
  sceneMap = map as SceneMap;
  seatNames = primarySeatNames;
}

function findLayer(map: SceneMap, name: string): MapLayer | undefined {
  return map.layers.find((l) => l.name === name);
}

function spawnPoints(map: SceneMap): Map<string, Tile> {
  const out = new Map<string, Tile>();
  for (const obj of findLayer(map, "spawn-points")?.objects ?? []) {
    out.set(obj.name, { x: Math.floor(obj.x / map.tilewidth), y: Math.floor(obj.y / map.tilewidth) });
  }
  return out;
}

function boardroomZone(map: SceneMap): ZoneRect | undefined {
  const obj = findLayer(map, "zones")?.objects?.find((o) => o.name === BOARDROOM_ZONE);
  if (!obj) return undefined;
  return {
    x: Math.floor(obj.x / map.tilewidth),
    y: Math.floor(obj.y / map.tilewidth),
    width: Math.floor((obj.width ?? 0) / map.tilewidth),
    height: Math.floor((obj.height ?? 0) / map.tilewidth),
  };
}

function isWalkable(map: SceneMap, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const collision = findLayer(map, "collision")?.data;
  if (!collision) return true;
  return ((collision[y * map.width + x] ?? 0) & TILE_ID_MASK) === 0;
}

/** Desk tile per agent id, for the currently loaded map + seat order. */
export function getSeatAssignments(agents: { id: string; isChief: boolean }[]): Map<string, Tile> {
  if (!sceneMap) return new Map();
  const seatTiles = resolveSeatTiles(seatNames, spawnPoints(sceneMap), boardroomZone(sceneMap), (x, y) =>
    isWalkable(sceneMap!, x, y),
  );
  return assignSeats(seatTiles, agents);
}

export function getSceneTileSize(): number {
  return sceneMap?.tilewidth ?? 16;
}

/** The office door, for anything that should walk in the way agents do. */
export function getSpawnTile(name: string): Tile | null {
  if (!sceneMap) return null;
  return spawnPoints(sceneMap).get(name) ?? null;
}

export function getEntranceTile(): Tile | null {
  if (!sceneMap) return null;
  return spawnPoints(sceneMap).get("entrance") ?? null;
}

export interface MeetingSeat {
  tile: Tile;
  facing: "up" | "down" | "left" | "right";
}

/** Chairs around the boardroom table: walkable tiles touching the biggest blocked block that stays clear of
 *  the room's edge (the table, not the wall decor), each facing the table. Ordered top/bottom pairs from
 *  the left, so attendees sit across from each other; chairs at the table ends come last. */
export function getBoardroomSeats(): MeetingSeat[] {
  if (!sceneMap) return [];
  const map = sceneMap;
  const marked = boardroomZone(map);
  if (!marked) return [];
  // The generated floor marks only the template's 5 interior rows; styled rooms run deeper and the table
  // sits below that, so search twice the marked height. The room's walls touch the search edge and drop out.
  const zone = { ...marked, height: Math.min(marked.height * 2, map.height - marked.y) };
  const inZone = (x: number, y: number) => x >= zone.x && y >= zone.y && x < zone.x + zone.width && y < zone.y + zone.height;
  const key = (x: number, y: number) => `${x},${y}`;

  const seen = new Set<string>();
  let table: Set<string> | null = null;
  for (let y = zone.y; y < zone.y + zone.height; y++) {
    for (let x = zone.x; x < zone.x + zone.width; x++) {
      if (seen.has(key(x, y)) || isWalkable(map, x, y)) continue;
      const blob = new Set<string>();
      let edge = false;
      const stack: Tile[] = [{ x, y }];
      seen.add(key(x, y));
      while (stack.length) {
        const t = stack.pop()!;
        blob.add(key(t.x, t.y));
        if (t.x === zone.x || t.y === zone.y || t.x === zone.x + zone.width - 1 || t.y === zone.y + zone.height - 1) edge = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = t.x + dx, ny = t.y + dy;
          if (!inZone(nx, ny) || seen.has(key(nx, ny)) || isWalkable(map, nx, ny)) continue;
          seen.add(key(nx, ny));
          stack.push({ x: nx, y: ny });
        }
      }
      if (!edge && (!table || blob.size > table.size)) table = blob;
    }
  }
  if (!table) return [];

  const seats: MeetingSeat[] = [];
  const dirs: [number, number, MeetingSeat["facing"]][] = [[0, 1, "down"], [0, -1, "up"], [1, 0, "right"], [-1, 0, "left"]];
  for (let y = zone.y; y < zone.y + zone.height; y++) {
    for (let x = zone.x; x < zone.x + zone.width; x++) {
      if (!isWalkable(map, x, y)) continue;
      const hit = dirs.find(([dx, dy]) => table!.has(key(x + dx, y + dy)));
      if (hit) seats.push({ tile: { x, y }, facing: hit[2] });
    }
  }
  const byX = (a: MeetingSeat, b: MeetingSeat) => a.tile.x - b.tile.x || a.tile.y - b.tile.y;
  const top = seats.filter((s) => s.facing === "down").sort(byX);
  const bottom = seats.filter((s) => s.facing === "up").sort(byX);
  const sides = seats.filter((s) => s.facing === "left" || s.facing === "right").sort(byX);
  const paired: MeetingSeat[] = [];
  for (let i = 0; i < Math.max(top.length, bottom.length); i++) {
    if (top[i]) paired.push(top[i]);
    if (bottom[i]) paired.push(bottom[i]);
  }
  return [...paired, ...sides];
}

/** Spaces a small group evenly along the table instead of bunching them at one end, so nameplates don't overlap.
 *  `chairs` is getBoardroomSeats' order: across-the-table pairs (top, bottom, top, bottom…), then the ends. */
export function spreadSeats(chairs: MeetingSeat[], count: number): MeetingSeat[] {
  const pairs = chairs.filter((c) => c.facing === "down").length;
  const needed = Math.ceil(count / 2);
  if (count === 0 || needed > pairs || chairs.filter((c) => c.facing === "up").length < pairs) return chairs.slice(0, count);
  const out: MeetingSeat[] = [];
  for (let i = 0; i < count; i++) {
    const pair = Math.round(((Math.floor(i / 2) + 0.5) * pairs) / needed - 0.5);
    out.push(chairs[pair * 2 + (i % 2)]);
  }
  return out;
}

/** BFS path between two tiles on the currently loaded map (vendor's own pathfinder, no map instance needed). */
export function findWalkPath(from: Tile, to: Tile): Tile[] | null {
  if (!sceneMap) return null;
  const map = sceneMap;
  const walk = (x: number, y: number) => isWalkable(map, x, y);
  const start = nearestWalkable(from, walk);
  const end = nearestWalkable(to, walk);
  if (!start || !end) return null;
  return findPath({ width: map.width, height: map.height, isWalkable: walk }, start, end);
}

function nearestWalkable(t: Tile, walk: (x: number, y: number) => boolean, maxR = 4): Tile | null {
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (walk(t.x + dx, t.y + dy)) return { x: t.x + dx, y: t.y + dy };
      }
    }
  }
  return null;
}
