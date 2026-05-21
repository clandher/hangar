# Contributing

## Setup

```bash
npm install
```

## Compile

```bash
npm run compile
# outputs to dist/extension.js
```

## Dev workflow

1. `npm run compile`
2. Open in VS Code → `F5` to launch Extension Development Host
3. Command palette: **Hangar: Open Hangar**

To iterate: re-compile → `Developer: Reload Window` in the host window (`⌘+R`).

## Package (VSIX)

```bash
npm install -g @vscode/vsce
vsce package
# outputs hangar-<version>.vsix
```

## Install locally

```bash
code --install-extension hangar-<version>.vsix
```

Or: Extensions panel → `···` → *Install from VSIX…*

## Publish to marketplace

```bash
vsce publish
```

## Structure

```
src/extension.ts   — all extension logic + webview HTML/JS (single file)
media/styles.css   — webview styles
media/icon.png     — extension icon
dist/              — compiled output (gitignored)
```
