# mcp-edit

Headless transactional editor for LLMs, via MCP.

**Status: P0 + P1 + P2** — read, search, atomic batch edit.

## Tools

| Tool | Purpose |
|---|---|
| `read_file` | Read full file or line range. Returns `hash`, `eol`, `totalLines`, `isBinary`. |
| `search_file` | Plain-text find with line/column positions and context. Returns `hash`. |
| `edit_file` | Atomic batch of `replace` / `insert_before` / `insert_after` / `delete`, with `expectedHash` stale-guard and unified diff in response. |

## Guarantees (P2)

- **Atomic batch** — all edits or none; validation happens before any write.
- **Sequential edits** — each edit sees the result of the previous one.
- **Full-line anchors** for insert operations (mid-line anchors are rejected).
- **Stale-context detection** via `expectedHash` (SHA-256 of raw bytes).
- **EOL preservation** — CRLF/LF of the original file is kept.
- **Atomic write** — tmp + `fsync` + `rename`.
- **Per-file mutex** — concurrent `edit_file` calls on one file serialize.
- **Unified diff** in responses — same format as `git diff`.

## Scope of P2 (deliberately not included)

- No backups, no `commit`/`rollback`, no undo/redo, no transactions.
  **P2 writes are irreversible** from the tool's perspective. Use git.
- No `replace_all` — planned for P5. Use per-context `replace` for now.
- No regex in `search_file` — planned for P5.

## Install

```bash
npm install
npm run build
MCP_EDIT_ROOT=/path/to/project node dist/index.js
```

## Env

| Var | Default | Purpose |
|---|---|---|
| `MCP_EDIT_ROOT` | `process.cwd()` | Workspace root; paths outside are rejected. |
| `MCP_EDIT_BACKUP_DIR` | `<root>/.mcp-edit` | Reserved for P3 (transaction state, backups). |
| `MCP_EDIT_TIMEOUT_MS` | `600000` (10 min) | Reserved for P3 (auto-rollback TTL). |
| `MCP_EDIT_MAX_FILE_SIZE` | `10485760` (10 MiB) | Per-file size cap. |

## Roadmap

- **P3**: transactions — `commit_file`, `rollback_file`, `.bak` snapshots, persistent `state.json`, advisory lock, auto-rollback.
- **P4**: `undo_edit`, `redo_edit`, snapshot-based per-step undo/redo.
- **P5**: `list_transactions`, `search_file` regex (re2), `replace_all` with `confirm: true`.
- **P6**: docs, examples, few-shot refinement.
- **P7**: test suite (>90% on `edits` & `transaction`, property-based `undo(N)+redo(N)=id`).

## Design principles (locked in)

1. **Closed read↔write loop** — `read_file` and `edit_file` live in the same server. No split brain.
2. **8 tools, not 30** — LLMs pick poorly from big menus.
3. **Block operations, not line positions** — search/anchor beats `insert_at_line`.
4. **`expectedHash` + advisory lock** (lock in P3) — two independent guards.
5. **Structured errors with `hint`** — the LLM self-corrects from `hint`, acts programmatically on `details`.
6. **No UI concepts** — no cursor, viewport, selection, LSP.