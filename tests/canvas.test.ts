// JSON Canvas model. Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { anchor, colorOf, drawable, edgePath, facingSides, insideGroup, newId, parseCanvas, removeNodes, serializeCanvas, type CanvasNode } from "../src/lib/canvas.ts";

const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: "text", x, y, width: 100, height: 50, text: id, ...extra });

test("round-trips a canvas, keeping fields we don't know", () => {
  const text = JSON.stringify({
    nodes: [node("a", 0, 0, { custom: { keep: true } }), node("b", 300, 0)],
    edges: [{ id: "e", fromNode: "a", toNode: "b", toEnd: "arrow", style: "dashed" }],
    meta: { app: "other" },
  });
  const c = parseCanvas(text);
  const back = JSON.parse(serializeCanvas(c));
  assert.deepEqual(back, JSON.parse(text));
  assert.ok(serializeCanvas(c).includes("\n\t"), "tab-indented like other apps");
});

test("tolerates empty files, keeps entries it can't draw, refuses non-canvas JSON", () => {
  assert.deepEqual(parseCanvas(""), { nodes: [], edges: [] });
  const c = parseCanvas(JSON.stringify({ nodes: [node("a", 0, 0), { id: "x", type: "text" }, { id: "y", type: "video", x: 0, y: 0, width: 1, height: 1 }, "junk"], edges: [{ id: "e", fromNode: "a", toNode: "gone" }] }));
  assert.deepEqual(c.nodes.map((n) => n.id), ["a", "x", "y"], "kept, so saving doesn't lose them");
  assert.deepEqual(c.nodes.filter(drawable).map((n) => n.id), ["a"], "only drawable nodes are shown");
  assert.equal(edgePath(c, c.edges[0]), null, "edges to missing nodes aren't drawn");
  assert.throws(() => parseCanvas("[1,2]"));
  assert.throws(() => parseCanvas("{not json"));
});

test("edges attach to the facing sides", () => {
  const a = node("a", 0, 0), right = node("b", 400, 10), below = node("c", 0, 300);
  assert.deepEqual(facingSides(a, right), ["right", "left"]);
  assert.deepEqual(facingSides(a, below), ["bottom", "top"]);
  assert.deepEqual(facingSides(right, a), ["left", "right"]);
  assert.deepEqual(anchor(a, "right"), { x: 100, y: 25 });
  const c = { nodes: [a, right], edges: [] };
  assert.match(edgePath(c, { id: "e", fromNode: "a", toNode: "b" })!, /^M 100 25 C .* 400 35$/);
  assert.equal(edgePath(c, { id: "e", fromNode: "a", toNode: "missing" }), null);
});

test("removing nodes removes their edges; groups contain the nodes inside them", () => {
  const g = node("g", -10, -10, { type: "group", width: 500, height: 100 });
  const c = { nodes: [g, node("a", 0, 0), node("b", 300, 0), node("far", 900, 900)], edges: [{ id: "e1", fromNode: "a", toNode: "b" }, { id: "e2", fromNode: "b", toNode: "far" }] };
  assert.deepEqual(insideGroup(c, g).map((n) => n.id), ["a", "b"]);
  const r = removeNodes(c, new Set(["b"]));
  assert.deepEqual(r.nodes.map((n) => n.id), ["g", "a", "far"]);
  assert.equal(r.edges.length, 0);
});

test("ids are unique and colours resolve presets or hex only", () => {
  const c = { nodes: [node("a", 0, 0)], edges: [] };
  const ids = new Set(Array.from({ length: 200 }, () => newId(c)));
  assert.equal(ids.size, 200);
  assert.ok([...ids].every((id) => /^[0-9a-f]{16}$/.test(id)));
  assert.equal(colorOf("4"), "#2f9e44");
  assert.equal(colorOf("#abc"), "#abc");
  assert.equal(colorOf("red; background:url(x)"), undefined, "no CSS injection through colours");
});
