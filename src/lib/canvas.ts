// JSON Canvas 1.0 (https://jsoncanvas.org, MIT): the open format for infinite-canvas boards.
// Model helpers only, no Svelte or DOM, so they're tested in tests/canvas.test.ts. Fields we
// don't know (from other apps or newer spec versions) are kept and written back unchanged.

export type Side = "top" | "right" | "bottom" | "left";
export type CanvasNode = {
  id: string;
  type: "text" | "file" | "link" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  text?: string;
  file?: string;
  subpath?: string;
  url?: string;
  label?: string;
  [extra: string]: unknown;
};
export type CanvasEdge = {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: Side;
  toSide?: Side;
  fromEnd?: "none" | "arrow";
  toEnd?: "none" | "arrow";
  color?: string;
  label?: string;
  [extra: string]: unknown;
};
export type Canvas = { nodes: CanvasNode[]; edges: CanvasEdge[]; [extra: string]: unknown };

const TYPES = new Set(["text", "file", "link", "group"]);

/** Parses a .canvas file. Empty text is an empty canvas; anything that isn't a canvas throws,
 *  so the caller can refuse to overwrite a file it doesn't understand. Entries we can't draw
 *  (unknown node types from a newer spec, broken geometry) are kept, so saving never loses them. */
export function parseCanvas(text: string): Canvas {
  if (!text.trim()) return { nodes: [], edges: [] };
  const c = JSON.parse(text);
  if (typeof c !== "object" || c === null || Array.isArray(c)) throw new Error("not a JSON Canvas file");
  const objects = (v: unknown) => (Array.isArray(v) ? v : []).filter((x) => x && typeof x === "object" && typeof x.id === "string");
  return { ...c, nodes: objects(c.nodes), edges: objects(c.edges) };
}

/** Whether a node can be drawn: a known type with numeric geometry. */
export const drawable = (n: CanvasNode) => TYPES.has(n.type) && [n.x, n.y, n.width, n.height].every(Number.isFinite);

/** Tab-indented JSON, as other JSON Canvas apps write it. */
export const serializeCanvas = (c: Canvas) => JSON.stringify(c, null, "\t") + "\n";

/** A 16-hex-digit id, unique within the canvas. */
export function newId(c: Canvas): string {
  const taken = new Set([...c.nodes.map((n) => n.id), ...c.edges.map((e) => e.id)]);
  for (;;) {
    const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!taken.has(id)) return id;
  }
}

/** Midpoint of a node's side, where edges attach. */
export function anchor(n: CanvasNode, side: Side): { x: number; y: number } {
  const cx = n.x + n.width / 2, cy = n.y + n.height / 2;
  return side === "top" ? { x: cx, y: n.y } : side === "bottom" ? { x: cx, y: n.y + n.height } : side === "left" ? { x: n.x, y: cy } : { x: n.x + n.width, y: cy };
}

/** The sides of `a` and `b` that face each other, for edges without explicit sides. */
export function facingSides(a: CanvasNode, b: CanvasNode): [Side, Side] {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? ["right", "left"] : ["left", "right"]) : dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

const normal: Record<Side, [number, number]> = { top: [0, -1], bottom: [0, 1], left: [-1, 0], right: [1, 0] };

/** SVG path for an edge: a cubic curve leaving and entering perpendicular to the sides. */
export function edgePath(c: Canvas, e: CanvasEdge): string | null {
  const a = c.nodes.find((n) => n.id === e.fromNode), b = c.nodes.find((n) => n.id === e.toNode);
  if (!a || !b || !drawable(a) || !drawable(b)) return null;
  const [fs, ts] = facingSides(a, b);
  const from = e.fromSide ?? fs, to = e.toSide ?? ts;
  const p = anchor(a, from), q = anchor(b, to);
  const k = Math.max(40, Math.hypot(q.x - p.x, q.y - p.y) / 3);
  const [ax, ay] = normal[from], [bx, by] = normal[to];
  return `M ${p.x} ${p.y} C ${p.x + ax * k} ${p.y + ay * k}, ${q.x + bx * k} ${q.y + by * k}, ${q.x} ${q.y}`;
}

/** Removes nodes and every edge touching them. */
export function removeNodes(c: Canvas, ids: Set<string>): Canvas {
  return { ...c, nodes: c.nodes.filter((n) => !ids.has(n.id)), edges: c.edges.filter((e) => !ids.has(e.fromNode) && !ids.has(e.toNode)) };
}

/** Nodes lying entirely inside `group` (they move with it). */
export function insideGroup(c: Canvas, group: CanvasNode): CanvasNode[] {
  return c.nodes.filter(
    (n) => n !== group && n.x >= group.x && n.y >= group.y && n.x + n.width <= group.x + group.width && n.y + n.height <= group.y + group.height,
  );
}

/** Bounding box of `nodes` (or a default area when empty). */
export function bounds(nodes: CanvasNode[]) {
  if (!nodes.length) return { x: 0, y: 0, width: 800, height: 600 };
  const x = Math.min(...nodes.map((n) => n.x)), y = Math.min(...nodes.map((n) => n.y));
  return { x, y, width: Math.max(...nodes.map((n) => n.x + n.width)) - x, height: Math.max(...nodes.map((n) => n.y + n.height)) - y };
}

/** Spec colour presets "1"–"6" (red, orange, yellow, green, cyan, purple), or any hex colour. */
export const PRESETS = ["#e03131", "#e8590c", "#f0b400", "#2f9e44", "#1098ad", "#7048e8"];
export const colorOf = (c?: string) => (c && /^[1-6]$/.test(c) ? PRESETS[Number(c) - 1] : c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined);
