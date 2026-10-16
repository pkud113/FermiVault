// What image URLs in untrusted Markdown load (S4, S5). Run with `pnpm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { imageTarget } from "../src/lib/api.ts";

test("a malformed %-escape doesn't throw; it's used as written", () => {
  assert.deepEqual(imageTarget("%ZZ.png"), { path: "%ZZ.png" });
  assert.deepEqual(imageTarget("a%E0%A4%A.png"), { path: "a%E0%A4%A.png" });
  assert.deepEqual(imageTarget("my%20pic.png"), { path: "my pic.png" });
});

test("only http(s) images count as web images; other schemes load nothing", () => {
  assert.deepEqual(imageTarget("https://example.com/a.png"), { web: "https://example.com/a.png" });
  assert.deepEqual(imageTarget("HTTP://example.com/a.png"), { web: "HTTP://example.com/a.png" });
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:image/png;base64,AA==", "C:/x.png"]) {
    assert.equal(imageTarget(bad), null, bad);
  }
});
