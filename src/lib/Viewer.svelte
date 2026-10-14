<script lang="ts">
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { assetUrl, kind } from "./api";
  import { app } from "./store.svelte";

  /** Non-Markdown files. PDFs use the webview's built-in viewer, so no pdf.js bundle is needed. */
  let { path }: { path: string } = $props();
  const src = $derived(assetUrl(app.root!, path));
  const k = $derived(kind(path));
  const absolute = $derived(app.root + (app.root!.includes("\\") ? "\\" : "/") + path.replaceAll("/", app.root!.includes("\\") ? "\\" : "/"));
</script>

<div class="viewer" class:fill={k === "pdf"}>
  {#if k === "image"}
    <img {src} alt={path} />
  {:else if k === "pdf"}
    <iframe {src} title={path}></iframe>
  {:else if k === "audio"}
    <audio controls {src}></audio>
  {:else if k === "video"}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video controls {src}></video>
  {:else}
    <p>This file type can't be previewed.</p>
    <button onclick={() => revealItemInDir(absolute).catch((e) => (app.error = String(e)))}>Show in folder</button>
  {/if}
</div>

<style>
  .viewer {
    height: 100%;
    overflow: auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    color: var(--fv-muted);
  }
  .viewer.fill {
    padding: 0;
  }
  img,
  video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    border-radius: 6px;
  }
  iframe {
    width: 100%;
    height: 100%;
    border: none;
  }
  audio {
    width: min(520px, 90%);
  }
</style>
