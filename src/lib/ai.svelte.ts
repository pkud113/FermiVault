// In-app AI: chat grounded in the vault, and inline writing commands that stream
// straight into the editor. All model traffic goes to the endpoint picked in
// Settings → AI (a local server by default).

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
    app.error = "Choose a model first: Settings → AI. Ollama or LM Studio run models locally.";
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
  improve: { label: "Improving writing", replace: true, prompt: "Rewrite this to be clearer and more concise. Keep the meaning, language, tone and Markdown formatting:" },
  fix: { label: "Fixing spelling and grammar", replace: true, prompt: "Fix spelling, grammar and punctuation. Change nothing else and keep the Markdown formatting:" },
  summarize: { label: "Summarizing", replace: false, prompt: "Summarize this as a short Markdown bullet list:" },
  continue: { label: "Continuing", replace: false, prompt: "Continue this note from where it ends, in the same voice and format. Write a few sentences or bullets:" },
} as const;

export type InlineKind = keyof typeof INLINE;

/** Runs an inline command on the selection (or, for `continue`, the text before the cursor). */
export async function inlineAI(kind: InlineKind) {
  const view = app.views[app.focus];
  if (!view || !app.activePath?.endsWith(".md")) return void (app.error = "Open a note first.");
  if (ai.busy || !ai.require()) return;
  const spec = INLINE[kind];
  const sel = view.state.selection.main;
  const text = kind === "continue" ? view.state.sliceDoc(Math.max(0, sel.head - 4000), sel.head) : view.state.sliceDoc(sel.from, sel.to);
  if (!text.trim()) return void (app.error = kind === "continue" ? "Write something first." : "Select some text first.");

  // ponytail: assumes the user doesn't edit above the insertion point mid-stream; map positions if that bites.
  let pos = kind === "continue" ? sel.head : spec.replace ? sel.from : sel.to;
  let first = true;
  try {
    await ai.stream(
      [{ role: "system", content: EDITOR_SYSTEM }, { role: "user", content: `${spec.prompt}\n\n${text}` }],
      (t) => {
        const insert = first && kind === "summarize" ? "\n\n" + t : t;
        const changes = first && spec.replace ? { from: sel.from, to: sel.to, insert } : { from: pos, insert };
        view.dispatch({ changes, userEvent: "input.ai" });
        pos = changes.from + insert.length;
        first = false;
      },
      spec.label,
    );
  } catch (e) {
    app.error = `AI: ${(e as Error).message}`;
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
