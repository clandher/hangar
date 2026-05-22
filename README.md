# Hangar

Your local projects, always within reach.

Hangar opens a fast, filterable dashboard of all your local projects — launch them in VS Code or IntelliJ with a single click.

![Hangar Dashboard](media/icon.png)

## Features

- **Multi-hangar** — add multiple root folders, switch between them with tabs
- **Instant filter** — type to search projects by name
- **Git info** — branch, last commit message, author, and time per card
- **Dirty indicator** — red `●` badge on cards with uncommitted changes
- **Open in terminal** — `⌨` button opens the project in VS Code's integrated terminal
- **Recents** — recently opened projects surfaced at the top
- **Favorites** — star projects to pin them
- **Disk size** — see folder size per project
- **Themes** — terminal, amber, synthwave, paper
- **Sort** — by recent, modified, name, size, group, or dirty-first
- **`.hangarignore`** — exclude folders from dashboard; hover any hangar tab and click `⊘` to open/create the file
- **Ahead/behind** — `↑2 ↓1` badge shows commits ahead/behind a base branch (configurable)
- **IntelliJ support** — Java/Gradle projects get an IntelliJ button
- **Status bar** — project count shown in the status bar; click to open Hangar

## Keybindings

| Action | Shortcut |
|---|---|
| Open Hangar | `⌘+Shift+R` / `Ctrl+Shift+R` |
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
| `hangar.reusePanel` | `true` | Reveal existing panel instead of opening a new one |
| `hangar.showStatusBar` | `true` | Show project count in the status bar |
| `hangar.baseBranch` | `""` | Branch to compare ahead/behind against (e.g. `develop`). Empty = each repo's upstream |

## Tip

For the best experience, set the startup editor to none so Hangar opens immediately without the default welcome tab:

```json
"workbench.startupEditor": "none"
```
