# mcp-edit

Headless transactional editor for LLMs, via MCP.

**3 tools: `edit`, `commit`, `rollback`.** Read and search go through your host's shell
(`cat`/`Get-Content`, `grep`/`Select-String`/`rg`) — those are not unique to a file editor,
transactionality is.

## Tools

| Tool | Purpose |
|---|---|
| `edit` | Atomic batch of `{search, replacement}`. Creates a transaction with backup. |
| `commit` | Finalize the transaction. Deletes backup. |
| `rollback` | Restore original content (pre-transaction). Deletes backup. |

## The `search` field

- **Non-empty** — must occur EXACTLY ONCE in the file (after applying any earlier edits
  in the same batch). Replaced verbatim. `replacement: ""` deletes the block.
- **Empty (`""`)** — only valid on a **new or empty file**. Writes `replacement` as the
  file content. Use this to create files.

To find a unique `search` block, read the file via shell first (`cat file` /
`Get-Content file`) and copy the block verbatim. Include 2–3 adjacent lines of context
to guarantee uniqueness.

## Workflow

```
1. (shell) cat file.ts                              → see content
2. edit("file.ts", [{ search: "...", replacement: "..." }])
                                                    → diff, hash, transactionId
3. Verify the diff in the response.
4. commit("file.ts") or rollback("file.ts")
```

**Creating a file:**
```
edit("index.html", [{ search: "", replacement: "<!DOCTYPE html>..." }])
commit("index.html")
```

**Creating an empty file:**
```
edit("empty.txt", [{ search: "", replacement: "" }])
```

**Deleting a block:**
```
edit("legacy.ts", [{ search: "function unused() {\n  return 42;\n}\n\n", replacement: "" }])
```

## Guarantees

- **Atomic batch** — all edits or none; validated before any write.
- **Sequential edits** — each edit sees the previous one's result.
- **Backups on disk** — byte-for-byte original under `.mcp-edit/backups/<hash>/original`,
  survives crash/restart.
- **Persistent state** — `state.json` reloaded on startup, active transactions resumed.
- **Cross-process advisory lock** with stale-lock takeover.
- **External change detection** — `STALE_CONTENT` when disk diverges from `currentHash`.
- **Auto-rollback** — idle transactions roll back *only if the disk still matches*;
  dirty transactions stay, logged, for manual intervention.
- **Atomic write** — tmp + `fsync` + `rename`.
- **EOL preservation** — CRLF/LF of the original is kept.
- **Workspace boundary** — paths outside `MCP_EDIT_ROOT` are rejected.
- **Binary / non-UTF-8 / size guards** on read-before-edit.
- **Rollback of a created file deletes it** (restores the "no file" state).

## Install

```bash
npm install
npm run build
MCP_EDIT_ROOT=/path/to/project node dist/index.js
```

## Env

| Var | Default | Purpose |
|---|---|---|
| `MCP_EDIT_ROOT` | `process.cwd()` | Workspace root. **Must match your shell CWD** — otherwise `cat` and `edit` see different files. |
| `MCP_EDIT_BACKUP_DIR` | `<root>/.mcp-edit` | Backups + `state.json` + locks. |
| `MCP_EDIT_TIMEOUT_MS` | `600000` (10 min) | Auto-rollback TTL for idle transactions. |
| `MCP_EDIT_MAX_FILE_SIZE` | `10485760` (10 MiB) | Per-file size cap. |

## On-disk layout

```
<workspace>/.mcp-edit/
├── state.json                    # active transactions (v3)
├── backups/
│   └── <sha256-16-of-path>/
│       └── original              # byte-for-byte (or "" if created new)
└── locks/
    └── <sha256-16-of-path>.lock  # { pid, host, transactionId, heartbeatAt }
```

## Design principles (locked in)

1. **3 tools, not 8.** LLMs pick poorly from big menus.
2. **One edit kind (`replace`).** `insert_*` and `delete` are sugar over `replace`.
3. **Shell for read/search.** `cat` and `grep` are universal; wrapping them is not unique.
4. **Disk-first.** Every `edit` writes immediately. Transaction is a safety net, not a staging area.
5. **No snapshots, no undo/redo.** `rollback` (whole transaction) + re-edit covers the use case.
6. **Structured errors with `hint`.** The LLM self-corrects from `hint`, acts on `details`.
7. **No UI concepts.** No cursor, viewport, line numbers, LSP.