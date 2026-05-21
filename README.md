# Hangar

VS Code extension that shows all local projects in a fast, filterable dashboard. Opens projects in VS Code or IntelliJ, shows git branch, last commit, disk size, and last-opened time.

## Structure

```
src/extension.ts   — all extension logic + webview HTML/JS (single file)
media/styles.css   — webview styles
dist/              — compiled output (gitignored)
```

## Recommended Settings

For best experience, set the startup editor to none so Hangar opens immediately on launch instead of the default welcome tab:

```json
"workbench.startupEditor": "none"
```

## Requirements

- Node.js + npm
- TypeScript: `npm install`
- `vsce` for packaging: `npm install -g @vscode/vsce`

## Compile

```bash
npm run compile
# outputs to dist/extension.js
```

TypeScript compiles `src/extension.ts` → `dist/` per `tsconfig.json`.

## Generate VSIX

```bash
vsce package
# outputs hangar-<version>.vsix
```

Then install in VS Code:

```bash
code --install-extension hangar-0.0.1.vsix
```

Or via the UI: Extensions panel → `···` → *Install from VSIX…*

## Dev workflow

1. `npm run compile`
2. Open in VS Code → `F5` to launch Extension Development Host
3. Run command: **Hangar: Open Hangar**

To iterate: re-compile, then `Developer: Reload Window` in the host window (`Ctrl/⌘+R`).

## Keybindings

| Action | How |
|---|---|
| Open project | Click **open** / **vsc** / **intellij** button |
| Open in new window | `⌘+click` anywhere on card |
| Refresh | `r` key or **↺** button |
| Search | Type in search bar |
| Filter by group | Click group chips |
| Show only git repos | **git** toggle |
