# 🍃 Kanso (簡素)

> **Distraction-free, blazingly fast local-first markdown workspace powered by Rust & Tauri.**

[![Tauri v2](https://img.shields.io/badge/Tauri-v2-blue?logo=tauri)](https://tauri.app/)
[![Rust](https://img.shields.io/badge/Built%20with-Rust-orange?logo=rust)](https://www.rust-lang.org/)
[![React 19](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0-green.svg)](LICENSE)

---



**Kanso (簡素)** is a lightweight, privacy-focused desktop notes and technical documentation editor. Inspired by the Japanese Zen principle of simplicity and clutter-free focus, Kanso delivers the power of modern note-taking with the speed and efficiency of a native Rust backend.

Zero cloud lock-in, zero bloatware—just you and your thoughts.

---

## Implemented Features

### Dual-Mode Markdown Editor
- **Visual & Source Modes:** Edit seamlessly in **Visual** mode (Tiptap over ProseMirror) or **Source** mode (CodeMirror 6 with Markdown/YAML highlighting), with lossless Markdown serialization and undo/redo history.
- **Formatting & Productivity:** Toolbar, slash command menu (`/`), and floating selection toolbar for rapid formatting.
- **Rich Syntax Support:**
  - Inline styles: bold, italic, underline, strikethrough, `==highlight==`, `^superscript^`, `~subscript~`, inline code, and links.
  - Code blocks powered by `lowlight` (JavaScript, TypeScript, Python, Rust, HTML, CSS, JSON, YAML, SQL, Bash) with language selector, copy button, optional line numbers, and word-wrap toggle.
  - Content-adaptive tables with automatic wrapping and horizontal scroll overflow.
  - Inline (`$...$`) and block (`$$...$$`) KaTeX math rendering.
  - Interactive Mermaid diagram rendering (`flowchart`, `sequenceDiagram`, `stateDiagram`, etc.) with editable source.
  - Callout blocks (`NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`), Markdown footnotes (`[^1]`), and collapsible heading sections.
  - Wiki links (`[[Note|Alias]]`) with autocomplete suggestions and broken-link indicators.

### Workspace, Navigation & Knowledge Graph
- Hierarchical folders and notes with multi-tab editing, Archive, Trash, Starred, and Templates views.
- Command/note switcher (`Ctrl+K`), new note shortcut (`Ctrl+N`), document scroll navigator, and Right Sidebar (**Outline** & **Connections**).
- Interactive 2D Knowledge Graph (`react-force-graph-2d` + `d3-force`) visualizing workspace links.

### Settings & Preferences
- Keyboard-accessible **Settings** dialog (`Escape`, focus trapping, section search) with **General**, **Appearance**, **Editor**, **Keyboard Shortcuts**, **Files & Attachments**, **Version History**, and **About** sections.
- Single typed `localStorage` settings store (`kanso-settings`) with recovery from malformed storage and migration from legacy keys.
- Live appearance controls for Light/Dark theme, editor font family (Sans, Serif, Mono), font size, line height, and content width across both Visual and Source modes, plus confirmation-guarded reset to defaults.

### Managed Local Attachments & Portable Backups
- **SQLite & Content-Addressed Storage:** Managed local attachment store under the app data directory (`0003_attachments.sql`, `0004_attachment_retention.sql`) with stable attachment IDs, SHA-256 deduplicated blobs, and safe path/MIME/magic-byte validation (PNG, JPEG, GIF, WebP, PDF, and plain UTF-8 text up to 25 MiB).
- **Editor Integration:** Insert via toolbar picker, drag-and-drop, or clipboard paste. Images support editable alt text, captions, percentage width, and alignment persisted in Markdown-compatible syntax (`attachment:<id>`). PDFs and text files render attachment cards with safe OS-level opening.
- **Lifecycle & Portability:** Cross-note and version-pinned reference tracking prevents premature deletion. Settings displays storage usage, supports confirmation-guarded orphan cleanup, and provides portable folder backups (`workspace.json`, `notes/*.md` with relative `../attachments/...` links, `attachments/`, and version history) alongside non-destructive backup restore into a **Recovered workspace** folder.

### Per-Note Version History
- **SQLite Snapshots:** Additive migration (`0005_note_versions.sql`) captures periodic deduplicated note snapshots tied cleanly to workspace saves, preserving attachment references (`retained_attachment_refs`) via triggers.
- **History UI & Safe Restoration:** Inspect timestamped snapshots from the right sidebar with loading/error states, read-only previews, and line diffs (**Changes** view). Restoring requires confirmation, flushes pending edits, checks save revisions against concurrent edits, and creates a `Before restore` checkpoint snapshot automatically.
- **Configurable Retention:** Enable/disable automatic snapshots, adjust minimum snapshot interval, and configure max versions per note and max age in **Settings → Version History**.

---

## Architecture & Storage

- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS v4, Tiptap (`@tiptap/core` v3 / ProseMirror), CodeMirror 6, KaTeX, Mermaid, `lowlight`.
- **Backend:** Tauri v2, Rust, SQLite (`rusqlite` with bundled SQLite, WAL mode, strict foreign keys, and additive migrations `0001`–`0005`).
- **Workspace Store:** Notes, folders, tags, wiki-link index, tabs/session state, attachment metadata, and version snapshots reside locally in SQLite inside the Tauri app data directory.

---

## Development & Verification

```bash
# Install frontend dependencies
pnpm install

# Run type checking and production frontend bundle
pnpm exec tsc --noEmit
pnpm build

# Run Rust checks, linter, build, and integration/unit tests
cargo check --manifest-path src-tauri/Cargo.toml --locked --offline --all-targets
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --offline --all-targets -- -D warnings
cargo build --manifest-path src-tauri/Cargo.toml --locked --offline
cargo test --manifest-path src-tauri/Cargo.toml --locked --offline

# Launch desktop app in development
pnpm tauri dev
```

---

## Known Limitations

- **Frontend Test & Lint Scripts:** [`package.json`](package.json) defines `dev`, `build` (`tsc && vite build`), `preview`, and `tauri`; there is no standalone frontend unit test runner (e.g. Vitest) or ESLint/Prettier script configured in the repository. End-to-end UI verification was executed against the production Vite bundle using headless Chromium/Brave CDP with a stateful IPC mock.
- **Native Desktop Dialogs & OS Handlers:** Interactive OS file/folder pickers (`tauri-plugin-dialog`), native window frame/restart behavior, and OS default application launching (`tauri-plugin-opener`) require an interactive desktop display session and are not exercised in headless CLI tests.
- **Frontend Bundle Size:** `vite build` currently emits a chunk-size warning for large third-party bundles (Mermaid, Cytoscape, CodeMirror, Tiptap).
- **Emergency Export vs. Portable Backup:** The header emergency export produces a notes-only JSON snapshot; full attachment- and history-preserving backup/restore lives in **Settings → Files & Attachments**.
