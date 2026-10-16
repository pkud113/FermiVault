<script lang="ts">
  import { tk } from "./tk";
  import { t } from "./i18n.svelte";
  import type { EditorView } from "@codemirror/view";
  import { basename, type ChatMessage, type ChunkRef } from "./api";
  import { ai, groundedMessages, linkCitations } from "./ai.svelte";
  import { app } from "./store.svelte";
  import { host, loadEditor } from "./host";

  type Turn = { q: string; a: string; sources: ChunkRef[]; done: boolean; error?: string };
  let turns = $state<Turn[]>([]);
  let input = $state("");
  let withNote = $state(true);
  let list: HTMLDivElement;

  async function send() {
    const q = input.trim();
    if (!q || ai.busy || !ai.require()) return;
    input = "";
    const history: ChatMessage[] = turns.filter((t) => t.done && !t.error).flatMap((t) => [
      { role: "user" as const, content: t.q },
      { role: "assistant" as const, content: t.a },
    ]);
    const note = withNote ? app.activeDoc : null;
    turns.push({ q, a: "", sources: [], done: false });
    const turn = turns[turns.length - 1];
    try {
      const { messages, sources } = await groundedMessages(history, q, note);
      turn.sources = sources;
      await ai.stream(messages, (t) => (turn.a += t), tk("Answering"));
    } catch (e) {
      turn.error = (e as Error).message;
    }
    turn.done = true;
  }

  /** Renders a finished answer with the live-preview editor (read-only), so [[links]] are clickable. */
  function markdown(node: HTMLElement, text: string) {
    let view: EditorView | null = null;
    let alive = true;
    const show = () => {
      view?.destroy();
      view = host.nested(text, 1);
      node.append(view.dom);
    };
    loadEditor().then(() => alive && show());
    return {
      update(t: string) {
        text = t;
        if (view) show();
      },
      destroy: () => ((alive = false), view?.destroy()),
    };
  }

  $effect(() => {
    turns.length && turns[turns.length - 1].a;
    list?.scrollTo({ top: list.scrollHeight });
  });
</script>

<div class="chat">
  <div class="turns" bind:this={list}>
    {#if !turns.length}
      <div class="intro">
        <p><strong>{t("Chat with your notes.")}</strong> {t("Answers cite the notes they come from.")}</p>
        {#if !ai.ready}
          <button class="primary" onclick={() => (app.showSettings = true)}>{t("Choose a model in Settings")}</button>
          <p class="hint">{t("Runs locally with Ollama or LM Studio, or any OpenAI-compatible API.")}</p>
        {:else}
          <p class="hint">{t("Model: {model}", { model: app.settings.aiModel })}</p>
        {/if}
      </div>
    {/if}
    {#each turns as turn}
      <div class="q">{turn.q}</div>
      <div class="a">
        {#if turn.error}
          <div class="err">{turn.error}</div>
        {:else if turn.done}
          <div use:markdown={linkCitations(turn.a, turn.sources)}></div>
        {:else}
          <div class="streaming">{turn.a || "…"}</div>
        {/if}
        {#if turn.done && turn.sources.length}
          <details>
            <summary>{t(turn.sources.length === 1 ? "1 source" : "{n} sources", { n: turn.sources.length })}</summary>
            {#each turn.sources as s, i}
              <button class="src" onclick={() => app.goto(s.path, s.line)}>[{i + 1}] {basename(s.path)}{s.heading ? ` › ${s.heading}` : ""}</button>
            {/each}
          </details>
        {/if}
      </div>
    {/each}
  </div>
  <div class="composer">
    <textarea
      bind:value={input}
      placeholder={t("Ask about your notes…")}
      rows="3"
      onkeydown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), send())}
    ></textarea>
    <div class="row">
      <label><input type="checkbox" bind:checked={withNote} /> {t("Include open note")}</label>
      <span class="spacer"></span>
      {#if turns.length && !ai.busy}<button onclick={() => (turns = [])}>{t("Clear")}</button>{/if}
      {#if ai.busy}
        <button onclick={() => ai.stop()}>{t("Stop")}</button>
      {:else}
        <button class="primary" disabled={!input.trim()} onclick={send}>{t("Send")}</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .chat {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .turns {
    flex: 1;
    overflow: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .intro {
    color: var(--fv-muted);
    font-size: 13px;
    padding: 8px;
  }
  .hint {
    color: var(--fv-faint);
    font-size: 12px;
  }
  .q {
    align-self: flex-end;
    background: var(--fv-active);
    padding: 7px 11px;
    border-radius: 12px 12px 2px 12px;
    font-size: 13.5px;
    max-width: 90%;
    white-space: pre-wrap;
  }
  .a {
    font-size: 13.5px;
  }
  .a :global(.cm-editor) {
    font-size: 13.5px;
  }
  .a :global(.cm-content) {
    padding: 0 !important;
  }
  .streaming {
    white-space: pre-wrap;
    line-height: 1.6;
  }
  .err {
    color: var(--fv-danger);
    font-size: 12.5px;
    word-break: break-word;
  }
  details {
    margin-top: 4px;
    font-size: 12px;
    color: var(--fv-faint);
  }
  .src {
    display: block;
    border: none;
    background: none;
    padding: 2px 4px;
    text-align: left;
    font-size: 12px;
  }
  .composer {
    border-top: 1px solid var(--fv-border);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  textarea {
    resize: none;
    font: inherit;
    font-size: 13.5px;
    background: var(--fv-bg);
    color: var(--fv-text);
    border: 1px solid var(--fv-border);
    border-radius: 8px;
    padding: 8px;
    outline: none;
  }
  textarea:focus {
    border-color: var(--fv-accent);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--fv-muted);
  }
  .row label {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .spacer {
    flex: 1;
  }
</style>
