// Example FermiVault plugin. Runs in a sandboxed worker; everything goes through `fermi`.

fermi.commands.add({ id: "count", name: "Count words in vault" }, async () => {
  const notes = (await fermi.vault.list()).filter((p) => p.endsWith(".md"));
  let words = 0;
  for (const path of notes) {
    const text = await fermi.vault.read(path);
    words += (text.match(/\S+/g) || []).length;
  }
  await fermi.notice(`${words.toLocaleString("en")} words in ${notes.length} notes`);
});

fermi.commands.add({ id: "date", name: "Insert date and time" }, async () => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  await fermi.editor.insert(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`);
});

// Events: "file-open" ({ path }) and "vault-change" ({ paths }).
fermi.on("file-open", ({ path }) => {
  // e.g. keep per-note state here
});
