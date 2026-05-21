# Hangar

Your local projects, always within reach.

Hangar opens a fast, filterable dashboard of all your local projects — launch them in VS Code or IntelliJ with a single click.

![Hangar Dashboard](media/icon.png)

## Features

- **Multi-hangar** — add multiple root folders, switch between them with tabs
- **Instant filter** — type to search projects by name
- **Git info** — branch, last commit message, author, and time per card
- **Recents** — recently opened projects surfaced at the top
- **Favorites** — star projects to pin them
- **Disk size** — see folder size per project
- **Themes** — terminal, amber, synthwave, paper
- **Sort** — by recent, modified, name, size, or group
- **IntelliJ support** — Java/Gradle projects get an IntelliJ button

## Keybindings

| Action | Shortcut |
|---|---|
| Open Hangar | `⌘+Shift+H` / `Ctrl+Shift+H` |
| Open project | Click **open** button on card |
| Open in new window | `⌘+click` / `Ctrl+click` on card |
| Search | `/` or click search bar |
| Clear search | `Esc` |
| Refresh | `r` or **↺** button |
| Filter by group | Click group chips |
| Git repos only | **git only** toggle |

## Settings

| Setting | Default | Description |
|---|---|---|
| `hangar.chipAction` | `new-window` | What the **open** button does: `new-window` or `replace` |
| `hangar.clickAction` | `replace` | What `⌘+click` does: `new-window` or `replace` |
| `hangar.showOnStartup` | `true` | Open dashboard when VS Code starts |
| `hangar.maxRecents` | `6` | Number of recent projects to show |
| `hangar.cardSize` | `normal` | Card size: `compact`, `normal`, or `large` |
| `hangar.showGitInfo` | `true` | Show git branch, last commit, and badge on cards |

## Tip

For the best experience, set the startup editor to none so Hangar opens immediately without the default welcome tab:

```json
"workbench.startupEditor": "none"
```
