# Security policy

FermiVault is a local desktop app. Your notes, its index and its snapshots stay on your computer. They are sent somewhere else only when you ask: to the AI server you configure in Settings → AI, or to the AI apps you connect over MCP.

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** on this repository. Don't open a public issue for them.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply within a week. Please give us a reasonable time to ship a fix before you disclose it publicly.

## Supported versions

Only the latest release gets security fixes.

## Scope notes

- **AI apps you connect over MCP** can read and edit everything in that vault; that's their job. Every agent edit is snapshotted and can be undone from File recovery.
- **Plugins and Git are opt-in per device.** Plugin approvals, Git auto-sync and the choice to use a vault's Git repository are stored on your computer, not in the vault, so a shared vault can't turn them on.
- **Notes are treated as untrusted content.** This covers shared vaults, web clips and AI answers. Rendering one must not run code, read files outside the vault, or contact the network without your action. If you find a way around that, please report it.
