// In-app AI: chat grounded in the vault, and inline writing commands that stream
// straight into the editor. All model traffic goes to the endpoint picked in
// Settings → AI (a local server by default).

import { t } from "./i18n.svelte";
import { tk } from "./tk";
import { api, streamChat, type ChatMessage, type ChunkRef } from "./api";
import { app } from "./store.svelte";

class AI {
  busy = $state<{ label: string; cancel: () => void } | null>(null);

  get ready() {
    return !!(app.settings.aiBaseUrl && app.settings.aiModel);
  }

  /** True when a model is configured; otherwise points the user at Settings. */
  require() {
    if (this.ready) return true;
    app.error = t("Choose a model first: Settings → AI. Ollama or LM Studio run models locally.");
    app.settingsSection = "ai";
    app.showSettings = true;
    return false;
  }

  stream(messages: ChatMessage[], onText: (t: string) => void, label: string) {
    const h = streamChat(app.settings.aiBaseUrl, app.settings.aiModel, messages, onText);
    this.busy = { label, cancel: h.cancel };
    return h.done.finally(() => (this.busy = null));
  }

  stop() {
    this.busy?.cancel();
  }
}

export const ai = new AI();

const EDITOR_SYSTEM =
  "You are a writing assistant inside a Markdown notes app. Reply with only the requested text: no preamble, no explanations, no code fences around it.";

const INLINE = {
  improve: { label: tk("Improving writing"), replace: true, prompt: "Rewrite this to be clearer and more concise. Keep the meaning, language, tone and Markdown formatting:" },
  fix: { label: tk("Fixing spelling and grammar"), replace: true, prompt: "Fix spelling, grammar and punctuation. Change nothing else and keep the Markdown formatting:" },
  summarize: { label: tk("Summarizing"), replace: false, prompt: "Summarize this as a short Markdown bullet list:" },
  continue: { label: tk("Continuing"), replace: false, prompt: "Continue this note from where it ends, in the same voice and format. Write a few sentences or bullets:" },
} as const;

export type InlineKind = keyof typeof INLINE;

/** Runs an inline command on the selection (or, for `continue`, the text before the cursor).
 *  Output goes to the note the command started in, at a range that follows the user's edits,
 *  and undoes in one step. */
export async function inlineAI(kind: InlineKind) {
  const ed = app.focusedEditor();
  const doc = ed?.doc();
  if (!ed || !doc) return void (app.error = t("Open a note first."));
  if (ai.busy || !ai.require()) return;
  const spec = INLINE[kind];
  const s = doc.state;
  const sel = s.selection.main;
  const text = kind === "continue" ? s.sliceDoc(Math.max(0, sel.head - 4000), sel.head) : s.sliceDoc(sel.from, sel.to);
  if (!text.trim()) return void (app.error = kind === "continue" ? t("Write something first.") : t("Select some text first."));
  const { begin, finish, step } = await import("./inline"); // with the editor, not at startup

  const at = kind === "continue" ? sel.head : sel.to;
  const original = spec.replace ? text : "";
  ed.apply(doc, spec.replace ? begin(sel.from, sel.to) : begin(at, at));
  let first = true;
  try {
    await ai.stream(
      [{ role: "system", content: EDITOR_SYSTEM }, { role: "user", content: `${spec.prompt}\n\n${text}` }],
      (t) => {
        const change = step(doc.state, first && kind === "summarize" ? "\n\n" + t : t, first && spec.replace);
        // Stop if the user edited inside the output, or the note was trashed / its vault closed.
        if (!change || !ed.apply(doc, change)) return void ai.stop();
        first = false;
      },
      spec.label,
    );
  } catch (e) {
    app.error = `AI: ${(e as Error).message}`;
  } finally {
    for (const f of finish(doc.state, original)) ed.apply(doc, f);
  }
}

/** Builds a grounded chat request: retrieved passages are numbered so answers can cite them. */
export async function groundedMessages(history: ChatMessage[], question: string, note: { path: string; text: string } | null) {
  const sources: ChunkRef[] = await api.aiContext(question, 6).catch(() => []);
  const numbered = sources.map((c, i) => `[${i + 1}] ${c.path}${c.heading ? " › " + c.heading : ""}\n${c.text}`);
  const system = [
    "You are the assistant inside FermiVault, the user's Markdown notes app.",
    "Answer from the user's notes when they are relevant, citing them inline as [1], [2] matching the numbered sources.",
    "If the notes don't cover the question, say so briefly, then answer from general knowledge. Be concise; use Markdown.",
    note ? `\nThe user is looking at "${note.path}":\n${note.text.slice(0, 6000)}` : "",
    numbered.length ? `\nSources from the vault:\n\n${numbered.join("\n\n")}` : "\nNo matching notes were found in the vault.",
  ].join("\n");
  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history.slice(-8), { role: "user", content: question }];
  return { messages, sources };
}

/** Turns `[n]` citations into links to the cited note. */
export function linkCitations(text: string, sources: ChunkRef[]) {
  return text.replace(/\[(\d{1,2})\](?![(\]])/g, (m, n) => {
    const s = sources[Number(n) - 1];
    return s ? `[[${s.path.replace(/\.md$/, "")}|${n}]]` : m;
  });
}
