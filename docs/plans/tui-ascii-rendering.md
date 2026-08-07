# TUI ASCII Rendering Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a terminal-native Markdown + Mermaid rendering path to mdmaid, using `veol` CLI as the broad Mermaid ASCII backend and `beautiful-mermaid` as the JS fallback.

**Architecture:** Keep mdmaid's existing web/HTML renderer as the high-fidelity path. Add a separate TUI renderer that can render whole Markdown documents to terminal text and render individual Mermaid blocks to ASCII. The TUI path must work over SSH, Termius, tmux, CI logs, and plain terminals without image protocols.

**Tech Stack:** Node.js/TypeScript, existing mdmaid CLI, external `veol` binary, optional `beautiful-mermaid` npm dependency, child_process, temporary files/stdin piping.

---

## Why this belongs in mdmaid

mdmaid already owns the Markdown + Mermaid rendering contract used by the web preview, blog integrations, and mdmaid.nvim. Adding a terminal renderer makes the same documents usable when a browser is unavailable or inconvenient:

- Remote SSH sessions, including Termius.
- Neovim terminal/floating-window previews.
- Agent outputs and CI logs.
- Fast documentation reading without Chrome/Puppeteer/image protocols.

The existing web renderer remains the best option for exact Mermaid fidelity. TUI rendering is the portable path: "works anywhere a terminal works."

---

## Renderer strategy

Backend order:

1. **Veol CLI** — primary backend for whole-document TUI rendering because it supports many Mermaid diagram types as Unicode/ASCII text.
2. **beautiful-mermaid** — JS-native fallback for individual Mermaid blocks and environments where `veol` is not installed.
3. **Raw fenced source fallback** — preserve content if a diagram is unsupported or rendering fails.

Veol support from its docs:

| Mermaid keyword | Status |
|---|---|
| `flowchart` / `graph` | full |
| `sequenceDiagram` | full |
| `classDiagram` | full |
| `stateDiagram` / `stateDiagram-v2` | full |
| `erDiagram` | full |
| `pie` | full |
| `gantt` | partial |
| `journey` | full |
| `timeline` | full |
| `mindmap` | full |
| `gitGraph` | full |
| `quadrantChart` | full |
| `requirementDiagram` | full |
| `sankey-beta` | full |
| `xychart-beta` | full |
| `block-beta` | full |
| `architecture-beta` | full |
| `packet-beta` | full |

`beautiful-mermaid` should be documented as a smaller fallback, not the primary coverage story.

---

## Proposed CLI UX

```bash
# Existing behavior remains web/HTML-oriented.
mdmaid README.md
mdmaid serve README.md --watch --port 3333

# New whole-document terminal renderer.
mdmaid show README.md --viewer tui
mdmaid show README.md --viewer web
mdmaid show README.md --viewer auto

# Explicit TUI alias for scripts/editors.
mdmaid tui README.md
cat README.md | mdmaid tui -

# Render only a Mermaid block for editor integrations.
mdmaid render-mermaid diagram.mmd --format ascii
cat diagram.mmd | mdmaid render-mermaid - --format ascii
```

Recommended defaults:

- `show --viewer web`: use existing browser/server flow.
- `show --viewer tui`: render to stdout using TUI pipeline.
- `show --viewer auto`: prefer TUI when stdout is a TTY/SSH/editor context and `veol` exists; otherwise use web or fallback.

---

## Proposed public API

```ts
export interface TuiRenderOptions {
  width?: number;
  backend?: 'auto' | 'veol' | 'beautiful-mermaid' | 'source';
  veolPath?: string;
  beautifulMermaid?: boolean;
  unicode?: boolean;
}

export interface TuiRenderResult {
  output: string;
  backend: 'veol' | 'beautiful-mermaid' | 'source';
  warnings: string[];
}

export async function renderMarkdownToTui(
  markdown: string,
  options?: TuiRenderOptions,
): Promise<TuiRenderResult>;

export async function renderMermaidToAscii(
  code: string,
  options?: TuiRenderOptions,
): Promise<TuiRenderResult>;
```

Exports:

```json
{
  "./tui": "./dist/tui/index.js"
}
```

---

## Task 1: Add TUI module skeleton

**Objective:** Create the module boundary without changing existing behavior.

**Files:**

- Create: `src/tui/index.ts`
- Create: `src/tui/types.ts`
- Modify: `package.json`
- Modify: `tsconfig.json` only if needed

**Steps:**

1. Add `TuiRenderOptions` and `TuiRenderResult` types.
2. Add stub functions `renderMarkdownToTui()` and `renderMermaidToAscii()` that return source fallback output.
3. Export `./tui` from `package.json`.
4. Run `npm run build`.

**Verification:**

```bash
npm run build
node -e "import('./dist/tui/index.js').then(m => console.log(Object.keys(m)))"
```

Expected: functions are exported and no existing CLI behavior changes.

---

## Task 2: Add Veol backend wrapper

**Objective:** Shell out to `veol --plain` for whole-document rendering.

**Files:**

- Create: `src/tui/backends/veol.ts`
- Modify: `src/tui/index.ts`

**Implementation notes:**

- Use `child_process.spawn` or `execFile`, not shell string interpolation.
- Support `veolPath`, defaulting to `veol`.
- Pass Markdown through stdin where possible:

```bash
veol --plain --width 100 -
```

- Derive width from `process.stdout.columns` when available.
- If `veol` exits non-zero or is missing, return a structured warning and let the caller try fallback.

**Verification:**

```bash
printf '# Test\n\n```mermaid\ngraph LR\nA-->B\n```\n' | mdmaid tui - --backend veol
```

Expected: terminal output contains a Unicode graph instead of raw Mermaid source when `veol` is installed.

---

## Task 3: Add `beautiful-mermaid` fallback

**Objective:** Render individual Mermaid blocks to ASCII without requiring the `veol` binary.

**Files:**

- Modify: `package.json`
- Create: `src/tui/backends/beautiful-mermaid.ts`
- Modify: `src/tui/index.ts`

**Dependency:**

```bash
npm install beautiful-mermaid
```

**Implementation notes:**

- Use dynamic import so environments that only use web rendering do not pay the cost until needed.
- Use `renderMermaidASCII(code)`.
- Catch unsupported diagram errors and return source fallback.
- Document smaller coverage vs Veol.

**Verification:**

```bash
printf 'graph LR\nA-->B\n' | mdmaid render-mermaid - --format ascii --backend beautiful-mermaid
```

Expected: box-drawing ASCII graph.

---

## Task 4: Add Markdown block-level fallback renderer

**Objective:** If Veol is unavailable, render Markdown text normally and replace Mermaid fences with `beautiful-mermaid` output where possible.

**Files:**

- Create: `src/tui/markdown.ts`
- Modify: `src/tui/index.ts`

**Implementation notes:**

- Do not attempt to reproduce the whole web renderer.
- Support a practical subset:
  - headings
  - paragraphs
  - lists
  - fenced code blocks
  - Mermaid code fences
- For non-Mermaid code blocks, preserve fenced source.
- For unsupported Mermaid, preserve fenced source with a short warning line.

**Verification:**

```bash
mdmaid tui README.md --backend beautiful-mermaid
```

Expected: readable Markdown in terminal; supported Mermaid diagrams render as ASCII.

---

## Task 5: Extend CLI commands

**Objective:** Expose TUI rendering to users and editor plugins.

**Files:**

- Modify: `src/cli/index.ts`
- Modify: `bin/mdmaid.js` only if command routing requires it
- Modify: `README.md`

**Commands:**

```bash
mdmaid show <file> --viewer tui|web|auto
mdmaid tui <file|-> [--backend auto|veol|beautiful-mermaid|source] [--width N]
mdmaid render-mermaid <file|-> --format ascii [--backend auto|veol|beautiful-mermaid|source]
```

**Verification:**

```bash
npm run build
mdmaid tui test.md --backend source
mdmaid show test.md --viewer tui
```

Expected: commands succeed and existing commands still work.

---

## Task 6: Add docs and health output

**Objective:** Make setup discoverable.

**Files:**

- Modify: `README.md`
- Optionally create: `docs/tui-rendering.md`

**Docs must include:**

- Install Veol:

```bash
git clone https://github.com/guiwohl/veol.git
cd veol
cargo install --path .
```

- Optional fallback:

```bash
npm install beautiful-mermaid
```

- Explain web vs TUI tradeoff:
  - web = fidelity
  - TUI = SSH/everywhere
- Explain unsupported diagrams fallback to source.

**Verification:**

Read the README and ensure a new user can choose either browser preview or terminal preview.

---

## Open questions

1. Should `beautiful-mermaid` be a normal dependency or optional peer dependency?
2. Should `veol` be discovered automatically via PATH only, or configurable via env/config?
3. Should `mdmaid tui` preserve color/styling or output plain text by default?
4. Should `show --viewer auto` prefer web or TUI on local desktop terminals?

---

## Acceptance criteria

- Existing `mdmaid` HTML rendering and `serve` behavior are unchanged.
- Users can run `mdmaid tui README.md` and get terminal-rendered Markdown.
- Mermaid blocks render through Veol when available.
- If Veol is missing, common diagrams render through `beautiful-mermaid` when installed.
- If all renderers fail, source is preserved with a short warning.
- The output works over SSH/Termius without Kitty/Sixel/image protocols.
- mdmaid.nvim can call the CLI/API for a current buffer or current Mermaid block.
