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
    settings: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    sidebarLeft: "M4 5h16v14H4zM9 5v14",
    sidebarRight: "M4 5h16v14H4zM15 5v14",
    menu: "M4 6h16M4 12h16M4 18h16",
    swap: "M7 7h12l-3-3M17 17H5l3 3",
    collapse: "M7 11l5-5 5 5M7 18l5-5 5 5",
  } as const;

  let { name, size = 17 }: { name: keyof typeof PATHS; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d={PATHS[name]} />
</svg>
