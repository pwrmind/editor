# mcp-edit

Headless transactional editor for LLMs, via MCP. **Status: P0 + P1** (read-cycle only).

## What works now

- `read_file` — read full file or a line-range, returns `hash` (SHA-256 of raw bytes), `eol`, `totalLines`, `isBinary`.
- `search_file` — plain-text search with line/column positions and context, returns `hash`.

Both tools:
- resolve paths against `MCP_EDIT_ROOT` (workspace boundary enforced via `realpath`);
- refuse binary files, non-UTF-8 files, and files above `MCP_EDIT_MAX_FILE_SIZE`;
- return structured errors (`{ code, message, hint, details }`) designed for LLM self-correction.

## What's next (per roadmap)

- **P2**: `edit_file` (array of `replace`/`insert_before`/`insert_after`/`delete`/`replace_all`), atomic batch, `expectedHash` stale-guard, unified diff in response.
- **P3**: `commit_file`, `rollback_file`, per-file transaction, advisory lock, persistent `state.json`, auto-rollback.
- **P4**: `undo_edit`, `redo_edit`, snapshot files.
- **P5**: `list_transactions`, `search_file` with regex (re2), cleanup tooling.
- **P6**: few-shot refinement, docs, examples.
- **P7**: test suite (>90% on edits & transactions, property-based `undo(N)+redo(N)=id`).

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
| `MCP_EDIT_BACKUP_DIR` | `<root>/.mcp-edit` | Backups + `state.json` (used from P3). |
| `MCP_EDIT_TIMEOUT_MS` | `600000` (10 min) | Auto-rollback TTL (used from P3). |
| `MCP_EDIT_MAX_FILE_SIZE` | `10485760` (10 MiB) | Per-file size cap. |

## Design principles (locked in)

1. **Closed read↔write loop** — `read_file` lives in the same server as `edit_file`. No split brain.
2. **8 tools, not 30** — LLMs pick poorly from big menus.
3. **Block operations, not line positions** — search/anchor beats `insert_at_line`.
4. **`expectedHash` + advisory lock** — two independent guards against stale context and multi-agent collisions.
5. **Structured errors with `hint`** — the LLM corrects itself from `hint`, acts programmatically on `details`.
6. **No UI concepts** — no cursor, viewport, selection, LSP.