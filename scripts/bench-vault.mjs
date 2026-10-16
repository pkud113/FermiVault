// Writes a synthetic vault for the performance budgets: `node scripts/bench-vault.mjs <dir> [notes]`.
// Deterministic, so every run measures the same vault: folders, properties, tags and links.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dir, count = "10000"] = process.argv.slice(2);
if (!dir) throw new Error("usage: node scripts/bench-vault.mjs <dir> [notes]");
const n = Number(count);

let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = (a) => a[Math.floor(rand() * a.length)];
const words = "note vault index search graph link tag project meeting idea draft review plan design research paper code test release budget memory editor canvas table query daily weekly summary question answer source model local fast plain markdown file folder rename backlink outline heading block embed image property status due owner".split(" ");
const sentence = () => Array.from({ length: 8 + Math.floor(rand() * 10) }, () => pick(words)).join(" ") + ".";
const folders = ["Projects", "Areas", "Resources", "Archive", "Journal", "Inbox", "Projects/Clients", "Resources/Papers"];
const title = (i) => `Note ${i} ${pick(words)}`;
const names = Array.from({ length: n }, (_, i) => title(i));

for (const f of folders) mkdirSync(join(dir, f), { recursive: true });
names.forEach((name, i) => {
  const links = Array.from({ length: 3 }, () => `[[${names[Math.floor(rand() * n)]}]]`).join(", ");
  const body = [
    "---",
    `status: ${pick(["todo", "doing", "done"])}`,
    `due: 2026-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
    `tags: [${pick(words)}, ${pick(words)}]`,
    "---",
    `# ${name}`,
    "",
    ...Array.from({ length: 4 }, () => Array.from({ length: 3 }, sentence).join(" ") + "\n"),
    `## Links`,
    `See ${links}. #${pick(words)}`,
    "",
    "- [ ] " + sentence(),
    "- [x] " + sentence(),
    "",
  ].join("\n");
  writeFileSync(join(dir, folders[i % folders.length], `${name}.md`), body);
});
console.log(`wrote ${n} notes to ${dir}`);
