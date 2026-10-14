<script lang="ts">
  // A handful of 24px stroke icons, inlined so no icon font or library ships.
  const PATHS = {
    files: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3",
    tags: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM8 8h.01",
    bookmarks: "M6 3h12v18l-6-4-6 4z",
    ai: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
    graph: "M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M18 8m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M9 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8 6.5l8 1.2M17 9.7l-6.5 6.8M6.6 8l1.8 8",
    calendar: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM8 2v4M16 2v4M4 10h16",
    menu: "M4 6h16M4 12h16M4 18h16",
  } as const;

  let { name, size = 17 }: { name: keyof typeof PATHS; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={PATHS[name]} />
</svg>
