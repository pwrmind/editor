# mcp-edit

Headless transactional editor for LLMs, via MCP.

**Status: P0 + P1 + P2 + P3** — read, search, atomic batch edit, transactions.

## Tools

| Tool | Phase | Purpose |
|---|---|---|
| `read_file` | P1 | Read full file or line range. Returns `hash`, `eol`, `totalLines`, `isBinary`. |
| `search_file` | P1 | Plain-text find with line/column positions and context. Returns `hash`. |
| `edit_file` | P2 | Atomic batch of `replace` / `insert_before` / `insert_after` / `delete`. Returns unified diff. Starts/appends to a transaction. |
| `commit_file` | P3 | Finalize the active transaction. Deletes backup. Returns diff of what was committed. |
| `rollback_file` | P3 | Restore the file to its pre-transaction original. Deletes backup. |
| `list_transactions` | P3 | List active (uncommitted) transactions. Useful for observability across sessions. |

## Guarantees

### P2 (per-edit)
- **Atomic batch** — all edits or none; validation before any write.
- **Sequential edits** — each edit sees the result of the previous one.
- **Full-line anchors** for insert operations.
- **Stale-context detection** via `expectedHash`.
- **EOL preservation** — CRLF/LF of original is kept.
- **Atomic write** — tmp + `fsync` + `rename`.
- **Per-file mutex** — concurrent calls serialize.
- **Unified diff** in responses.

### P3 (per-transaction)
- **Backups on disk** — byte-for-byte original, survives crash/restart.
- **Persistent state** — `state.json` reloaded on startup; active transactions resumed.
- **Cross-process advisory lock** — multi-agent safety with stale-lock takeover.
- **External change detection** — `STALE_CONTENT` when disk diverges from `txn.currentHash`.
- **Auto-rollback** — transactions idle longer than `MCP_EDIT_TIMEOUT_MS` roll back *only if the disk still matches* the transaction. Dirty transactions are left in place, logged, and must be handled manually.
- **Startup recovery** — broken state entries (missing backup, missing file) cleaned up; orphaned backups logged, not deleted.

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
| `MCP_EDIT_BACKUP_DIR` | `<root>/.mcp-edit` | Backups + `state.json` + locks. |
| `MCP_EDIT_TIMEOUT_MS` | `600000` (10 min) | Auto-rollback TTL for idle transactions. |
| `MCP_EDIT_MAX_FILE_SIZE` | `10485760` (10 MiB) | Per-file size cap. |

## Workflow for the LLM

```
read_file(path)                       → content + hash
  ↓ (optional)
search_file(path, pattern)            → matches + hash (aim before editing)
  ↓
edit_file(path, [edits], hash)        → diff + new hash + transactionId
  ↓ (repeat as needed)
edit_file(path, [more_edits], new_hash)
  ↓
commit_file(path)        or          rollback_file(path)
```

Rules:
- `edit_file` **writes to disk immediately**; the transaction is a safety net, not a staging area.
- If the file changes externally between edits, `edit_file`/`commit_file` returns `STALE_CONTENT` → `rollback_file` or re-read and start over.
- If a transaction is idle past `MCP_EDIT_TIMEOUT_MS`, it is auto-rolled back **only if** the disk still matches. Dirty transactions stay in place for manual intervention.
- `list_transactions` shows what's in flight (use it when resuming a session).

## On-disk layout

```
<workspace>/.mcp-edit/
├── state.json                         # active transactions
├── backups/
│   └── <sha256-16-of-path>/
│       └── original                   # byte-for-byte
└── locks/
    └── <sha256-16-of-path>.lock       # { pid, host, transactionId, heartbeatAt }
```

## Roadmap

- **P4**: `undo_edit`, `redo_edit`, snapshot-based per-step undo/redo.
- **P5**: `search_file` regex (re2), `replace_all` with `confirm: true`.
- **P6**: docs, examples, few-shot refinement.
- **P7**: test suite (>90% on `edits` & `transaction`, property-based `undo(N)+redo(N)=id`).

## Design principles (locked in)

1. **Closed read↔write loop** — `read_file` and `edit_file` in the same server. No split brain.
2. **6 tools, not 30** — LLMs pick poorly from big menus.
3. **Block operations, not line positions** — search/anchor beats `insert_at_line`.
4. **`expectedHash` + advisory lock** — two independent guards against stale context and multi-agent collisions.
5. **Structured errors with `hint`** — the LLM self-corrects from `hint`, acts programmatically on `details`.
6. **No UI concepts** — no cursor, viewport, selection, LSP.