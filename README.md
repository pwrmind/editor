# editor

Headless transactional editor for LLMs, via MCP.

**Status: P0 + P1 + P2 + P3 + P4** — read, search, atomic batch edit, transactions with backups, undo/redo via snapshots, auto-rollback.

## Tools

| Tool | Phase | Purpose |
|---|---|---|
| `read_file` | P1 | Read full file or line range. Returns `hash`, `eol`, `totalLines`, `isBinary`. |
| `search_file` | P1 | Plain-text find with line/column positions and context. Returns `hash`. |
| `edit_file` | P2 | Atomic batch of `replace`/`insert_before`/`insert_after`/`delete`. Returns unified diff. Starts/appends to a transaction. |
| `undo_edit` | P4 | Step back N edits inside the active transaction. |
| `redo_edit` | P4 | Step forward N previously-undone edits. |
| `commit_file` | P3 | Finalize the transaction. Deletes backup + snapshots. |
| `rollback_file` | P3 | Restore the original content (before the first edit). Deletes backup + snapshots. |
| `list_transactions` | P3 | List active transactions with `pointer`, `snapshotCount`, `canUndo`, `canRedo`. |

## Guarantees

### Per-edit (P2)
- **Atomic batch** — all edits or none; validation before write.
- **Sequential edits** — each edit sees the previous one's result.
- **Full-line anchors** for insert operations.
- **Stale-context detection** via `expectedHash`.
- **EOL preservation**, **atomic write**, **per-file mutex**.
- **Unified diff** in responses.

### Per-transaction (P3)
- **Backups on disk** — byte-for-byte original, survives crash/restart.
- **Persistent state** — `state.json` reloaded on startup.
- **Cross-process advisory lock** with stale-lock takeover.
- **External change detection** — `STALE_CONTENT` when disk diverges from `currentHash`.
- **Auto-rollback** — idle transactions roll back *only if the disk still matches*; dirty transactions stay, logged, manual intervention.
- **Startup recovery** — broken state cleaned up; orphaned backups logged, not deleted.

### Undo/redo (P4)
- **Snapshot stack** — every successful `edit_file` writes `snapshots/NNNN`.
- **`pointer`** = how many edits are currently applied (0 = original, N = after Nth edit).
- **Undo/redo** are O(1) pointer moves + one file write; no replay of edits.
- **New edit after undo truncates redo history** — response includes `redoDiscarded: N`.
- **Undo/redo respect `disk == currentHash`** — refuse if the file changed externally.

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
| `MCP_EDIT_BACKUP_DIR` | `<root>/.editor` | Backups + `state.json` + locks. |
| `MCP_EDIT_TIMEOUT_MS` | `600000` (10 min) | Auto-rollback TTL for idle transactions. |
| `MCP_EDIT_MAX_FILE_SIZE` | `10485760` (10 MiB) | Per-file size cap. |

## Workflow for the LLM

```
read_file(path)                                 → content + hash
  ↓
edit_file(path, [edits], hash)                  → diff + hash + transactionId + pointer
  ↓ (repeat, or:)
undo_edit(path, steps=1)                        → diff + pointer-- + snapshotCount
redo_edit(path, steps=1)                        → diff + pointer++ + snapshotCount
  ↓
commit_file(path)              or               rollback_file(path)
```

Rules:
- `edit_file` **writes to disk immediately**; the transaction is a safety net.
- `undo_edit` / `redo_edit` are **only** within the active transaction — they operate on the snapshot stack.
- `edit_file` after `undo_edit` **discards** the redo history (`redoDiscarded: N` in the response).
- External change detection: if disk diverges from `currentHash`, `edit_file`/`undo_edit`/`redo_edit`/`commit_file` return `STALE_CONTENT`. Use `rollback_file` or re-read.
- Auto-rollback fires on idle past `MCP_EDIT_TIMEOUT_MS` **only if** disk matches `currentHash`.

## On-disk layout

```
<workspace>/.editor/
├── state.json                          # active transactions
├── backups/
│   └── <sha256-16-of-path>/
│       ├── original                    # byte-for-byte (pre-transaction)
│       └── snapshots/
│           ├── 0001                    # state after edit #1
│           ├── 0002
│           └── 0003
└── locks/
    └── <sha256-16-of-path>.lock
```

`state.json` (v2):

```json
{
  "version": 2,
  "transactions": [
    {
      "transactionId": "tx-...",
      "filePath": "/abs/path.ts",
      "fileHash": "<sha256-16>",
      "backupPath": ".../backups/<hash>/original",
      "snapshotsDir": ".../backups/<hash>/snapshots",
      "pointer": 2,
      "snapshotCount": 3,
      "originalHash": "sha256:...",
      "currentHash": "sha256:...",
      "createdAt": 1699999999999,
      "lastEditedAt": 1699999999999
    }
  ]
}
```

## Roadmap

- **P5**: `search_file` regex (re2), `replace_all` with `confirm: true`, optional `MCP_EDIT_MAX_SNAPSHOTS`.
- **P6**: docs, examples, few-shot refinement.
- **P7**: test suite (>90% on `edits` & `transaction`, property-based `undo(N)+redo(N)=id`).

## Design principles (locked in)

1. **Closed read↔write loop** — `read_file` and `edit_file` in the same server.
2. **8 tools, not 30**.
3. **Block operations, not line positions** — search/anchor beats `insert_at_line`.
4. **`expectedHash` + advisory lock** — two independent guards.
5. **Structured errors with `hint`** — the LLM self-corrects from `hint`, acts programmatically on `details`.
6. **No UI concepts** — no cursor, viewport, selection, LSP.