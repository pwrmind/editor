import * as path from "path";
import { ErrorCode, StructuredError } from "./errors.js";
import {
  countLines,
  denormalizeEol,
  normalizeEol,
  readTextFile,
  resolveWorkspacePath,
  sha256,
} from "./fs.js";
import { applyEdits, Edit, formatUnifiedDiff } from "./edits.js";
import { ServerState } from "./state.js";

// ============================================================
// Descriptions
// ============================================================

export const READ_FILE_DESCRIPTION = `
Read a text file from the workspace. Returns:
  • content    — full file, or a slice if startLine/endLine given;
  • hash       — SHA-256 of the raw file bytes (ALWAYS over the FULL file,
                 even when slicing). Pass this hash as 'expectedHash' to
                 edit_file to guard against stale content;
  • eol        — "\\n" or "\\r\\n";
  • totalLines — line count in the full file;
  • isBinary   — if true, edit_file will refuse this path.

Use read_file to obtain ground truth before any edit.

EXAMPLES:
  read_file({ path: "src/app.ts" })
  read_file({ path: "src/app.ts", startLine: 40, endLine: 60 })
`.trim();

export const SEARCH_FILE_DESCRIPTION = `
Find occurrences of a plain-text pattern in a file (case-sensitive by default).
Returns:
  • matches      — [{ line, column, length, snippet, contextBefore, contextAfter }]
  • hash         — current file hash. Pass it to edit_file as 'expectedHash';
  • totalMatches;
  • truncated    — true if there are more matches than maxResults.

Use search_file to 'aim' before editing.

EXAMPLES:
  search_file({ path: "src/app.ts", pattern: "function foo" })
  search_file({ path: "src/app.ts", pattern: "TODO", options: { caseSensitive: false } })
`.trim();

export const EDIT_FILE_DESCRIPTION = `
Apply one or more text edits to a file as an ATOMIC BATCH. Either ALL edits
succeed and the file is written, or NONE apply (file untouched). Each edit
sees the result of the previous edits in the same call — ORDER MATTERS.

EDIT KINDS:
  • replace       — { kind, search, replacement }. 'search' must occur
                    EXACTLY ONCE; it is replaced verbatim.
  • delete        — { kind, search }. Same uniqueness rule; removes 'search'.
  • insert_before — { kind, anchor, content }. 'anchor' must START at a line
                    boundary (column 0) and be unique. 'content' goes on a
                    new line immediately before.
  • insert_after  — { kind, anchor, content }. 'anchor' must END at a line
                    boundary and be unique. 'content' goes on a new line
                    immediately after.

TRANSACTIONS:
  • The first edit_file for a file starts a transaction. A byte-for-byte
    backup of the original is saved under .editor/backups/<hash>/original,
    and each successful edit_file creates a snapshot under
    .editor/backups/<hash>/snapshots/NNNN.
  • Subsequent edit_file calls APPEND to the active transaction — UNLESS you
    have undone some edits: a new edit after undo_edit DISCARDS the redo
    history (response includes 'redoDiscarded: N').
  • The file is written to disk on every edit_file — the transaction is a
    safety net, not a staging area.
  • Call commit_file to finalize (delete backup + snapshots) or rollback_file
    to restore the original.
  • Call undo_edit / redo_edit to step back / forward within the transaction.
  • Auto-rollback fires on idle past MCP_EDIT_TIMEOUT_MS (default 10 min) —
    but ONLY if the disk still matches the transaction.
  • If the file is modified externally, subsequent edit_file/undo_edit/
    redo_edit/commit_file calls return STALE_CONTENT.

RULES:
  • 'search' and 'anchor' must match EXACTLY — whitespace, case, indentation.
  • Include 2–3 adjacent lines of context to guarantee uniqueness.
  • For insert_before/insert_after, 'anchor' must be a full line.
  • If any edit fails, the whole batch is rejected — nothing is written.
  • STRONGLY RECOMMENDED: pass 'expectedHash' from the preceding read_file /
    search_file / edit_file's returned 'hash'.
  • 'replace_all' is NOT supported. Use one 'replace' per unique context.

RESPONSE:
  • diff, hash, editsApplied (this call), linesBefore, linesAfter,
    transactionId, pointer (edits currently applied), snapshotCount (max),
    redoDiscarded (present only if a redo history was dropped).

FEW-SHOT EXAMPLES:

Example 1 — fix a bug:
  path: "src/calc.ts"
  edits: [
    { kind: "replace",
      search: "export function add(a: number, b: number): number {\\n  return a - b;\\n}",
      replacement: "export function add(a: number, b: number): number {\\n  return a + b;\\n}" }
  ]

Example 2 — add import AND field (order matters):
  path: "src/user.ts"
  edits: [
    { kind: "insert_before",
      anchor: "export class User {",
      content: "import { isEmail } from './validators';" },
    { kind: "replace",
      search: "  constructor(public name: string) {\\n    this.name = name;\\n  }",
      replacement: "  constructor(public name: string) {\\n    if (!isEmail(name)) throw new Error('invalid email');\\n    this.name = name;\\n    this.isActive = true;\\n  }" }
  ]

Example 3 — delete a dead block:
  path: "src/legacy.ts"
  edits: [
    { kind: "delete",
      search: "function unusedHelper() {\\n  return 42;\\n}\\n\\n" }
  ]

Example 4 — with hash guard:
  path: "src/calc.ts"
  expectedHash: "sha256:ab12…ef34"
  edits: [ { kind: "replace", search: "…", replacement: "…" } ]
`.trim();

export const UNDO_EDIT_DESCRIPTION = `
Step back N edits within the ACTIVE transaction (default: 1). Moves the
internal pointer from P to P-N and restores the file from the corresponding
snapshot. Returns the diff of what is being reverted (current → previous).

CONSTRAINTS:
  • Requires an active transaction (call edit_file first).
  • 'steps' must be <= current 'pointer'.
  • Fails with STALE_CONTENT if the file was modified externally since the
    last edit.
  • Does NOT delete the undone snapshots — they remain available via
    redo_edit. New edit_file calls will DISCARD them.

RESPONSE:
  • transactionId, undoneSteps, pointer (new), snapshotCount (max),
    hash (new current), diff (current → previous).

EXAMPLES:
  undo_edit({ path: "src/calc.ts" })              // undo 1 edit
  undo_edit({ path: "src/calc.ts", steps: 3 })    // undo last 3 edits
`.trim();

export const REDO_EDIT_DESCRIPTION = `
Step forward N edits within the ACTIVE transaction (default: 1). Re-applies
previously-undone edits by moving the internal pointer from P to P+N and
restoring the file from the corresponding snapshot. Returns the diff of what
is being re-applied (current → next).

CONSTRAINTS:
  • Requires an active transaction.
  • 'steps' must be <= (snapshotCount - pointer).
  • Fails with STALE_CONTENT if the file was modified externally since the
    last undo/redo/edit.

RESPONSE:
  • transactionId, redoneSteps, pointer (new), snapshotCount (max),
    hash (new current), diff (current → next).

EXAMPLES:
  redo_edit({ path: "src/calc.ts" })              // redo 1 edit
  redo_edit({ path: "src/calc.ts", steps: 3 })    // redo last 3 undone
`.trim();

export const COMMIT_FILE_DESCRIPTION = `
Finalize the ACTIVE transaction for a file. The current on-disk content
becomes the committed state. Deletes the backup (original) and all snapshots.

Call only when you're confident the edits are correct (tests/lint pass).
If the file was modified externally since the last edit, this returns
STALE_CONTENT — roll back, or re-read and start over.

RESPONSE:
  • transactionId, editsCount (= current pointer), durationMs, finalHash
  • diff — original → committed (the net change of the whole transaction)

EXAMPLES:
  commit_file({ path: "src/calc.ts" })
`.trim();

export const ROLLBACK_FILE_DESCRIPTION = `
Discard the ACTIVE transaction for a file and restore its ORIGINAL content
byte-for-byte (as it was before the first edit in the transaction). Deletes
the backup and all snapshots.

NOTE: this ignores the current pointer — it always jumps back to the
original, even if you had only undone some edits. Any external changes made
after the transaction started will be lost.

RESPONSE:
  • transactionId, editsReverted (= current pointer), restoredHash
  • diff — current → original (what is being reverted)

EXAMPLES:
  rollback_file({ path: "src/calc.ts" })
`.trim();

export const LIST_TRANSACTIONS_DESCRIPTION = `
List ACTIVE (uncommitted) transactions. Useful when you've lost track of
what's in flight across sessions, or to see which files have pending backups.

RESPONSE:
  • transactions: [{ transactionId, path, pointer, snapshotCount,
                     canUndo, canRedo, createdAt, lastEditedAt,
                     ageSec, ttlRemainingSec }]
  • timeoutMs: the auto-rollback timeout.

  • pointer === 0              → at original, only redo is possible
  • pointer === snapshotCount  → at latest, only undo is possible
  • snapshotCount - pointer > 0 → redo history available

EXAMPLES:
  list_transactions()
`.trim();

// ============================================================
// Descriptors
// ============================================================

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
}

export function toolDescriptors(): ToolDescriptor[] {
  const editSchema = {
    oneOf: [
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["replace"] },
          search: { type: "string" },
          replacement: { type: "string" },
        },
        required: ["kind", "search", "replacement"],
      },
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["insert_before"] },
          anchor: { type: "string" },
          content: { type: "string" },
        },
        required: ["kind", "anchor", "content"],
      },
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["insert_after"] },
          anchor: { type: "string" },
          content: { type: "string" },
        },
        required: ["kind", "anchor", "content"],
      },
      {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["delete"] },
          search: { type: "string" },
        },
        required: ["kind", "search"],
      },
    ],
  };

  return [
    {
      name: "read_file",
      description: READ_FILE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
        required: ["path"],
      },
    },
    {
      name: "search_file",
      description: SEARCH_FILE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          pattern: { type: "string" },
          options: {
            type: "object",
            properties: {
              caseSensitive: { type: "boolean", default: true },
              maxResults: { type: "number", default: 100 },
              contextLines: { type: "number", default: 2 },
            },
          },
        },
        required: ["path", "pattern"],
      },
    },
    {
      name: "edit_file",
      description: EDIT_FILE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          expectedHash: { type: "string" },
          edits: {
            type: "array",
            minItems: 1,
            items: editSchema,
          },
        },
        required: ["path", "edits"],
      },
    },
    {
      name: "undo_edit",
      description: UNDO_EDIT_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          steps: {
            type: "number",
            default: 1,
            description: "Number of edits to undo (>= 1).",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "redo_edit",
      description: REDO_EDIT_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          steps: {
            type: "number",
            default: 1,
            description: "Number of undone edits to redo (>= 1).",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "commit_file",
      description: COMMIT_FILE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      name: "rollback_file",
      description: ROLLBACK_FILE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_transactions",
      description: LIST_TRANSACTIONS_DESCRIPTION,
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

// ============================================================
// Handlers
// ============================================================

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: StructuredError;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `'${field}' must be a non-empty string.`,
      `Provide a non-empty '${field}'.`,
      { field }
    );
  }
  return value;
}

function requireSteps(value: unknown): number {
  if (value === undefined) return 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      "'steps' must be an integer >= 1.",
      "Provide a positive integer 'steps', or omit it (default 1).",
      { field: "steps" }
    );
  }
  return value;
}

// ---------- read_file ----------

export async function handleReadFile(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);

    const r = await readTextFile(abs, state.config.maxFileSizeBytes, {
      startLine: typeof args?.startLine === "number" ? args.startLine : undefined,
      endLine: typeof args?.endLine === "number" ? args.endLine : undefined,
    });

    return {
      ok: true,
      data: {
        content: r.content,
        hash: r.hash,
        eol: r.eol,
        totalLines: r.totalLines,
        encoding: "utf-8",
        isBinary: r.isBinary,
      },
    };
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

// ---------- search_file ----------

export async function handleSearchFile(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const pattern = requireString(args?.pattern, "pattern");

    const opts = args?.options ?? {};
    const caseSensitive: boolean = opts.caseSensitive ?? true;
    const maxResults: number = Math.max(1, opts.maxResults ?? 100);
    const contextLines: number = Math.max(0, opts.contextLines ?? 2);

    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);
    const r = await readTextFile(abs, state.config.maxFileSizeBytes);

    if (r.isBinary) {
      throw new StructuredError(
        ErrorCode.BINARY_FILE,
        "File is binary.",
        "search_file works only on text files.",
        { path: pathArg }
      );
    }

    const normalized = normalizeEol(r.content);
    const lines = normalized.split("\n");
    const needle = caseSensitive ? pattern : pattern.toLowerCase();

    const matches: Array<{
      line: number;
      column: number;
      length: number;
      snippet: string;
      contextBefore: string[];
      contextAfter: string[];
    }> = [];

    let totalMatches = 0;
    let truncated = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hay = caseSensitive ? line : line.toLowerCase();
      let from = 0;
      while (true) {
        const idx = hay.indexOf(needle, from);
        if (idx < 0) break;
        totalMatches++;
        if (matches.length < maxResults) {
          matches.push({
            line: i + 1,
            column: idx + 1,
            length: pattern.length,
            snippet: line,
            contextBefore: lines.slice(Math.max(0, i - contextLines), i),
            contextAfter: lines.slice(i + 1, i + 1 + contextLines),
          });
        } else {
          truncated = true;
        }
        from = idx + Math.max(1, pattern.length);
      }
    }

    return {
      ok: true,
      data: { matches, hash: r.hash, totalMatches, truncated },
    };
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

// ---------- edit_file ----------

export async function handleEditFile(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const editsRaw = args?.edits;

    if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
      throw new StructuredError(
        ErrorCode.INVALID_ARGUMENT,
        "'edits' must be a non-empty array of edit objects.",
        "Provide at least one edit: replace | insert_before | insert_after | delete.",
        { field: "edits" }
      );
    }

    const expectedHash =
      typeof args?.expectedHash === "string" && args.expectedHash.length > 0
        ? args.expectedHash
        : undefined;

    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);
    const mutex = state.getMutex(abs);

    return await mutex.run(async (): Promise<ToolResult> => {
      const r = await readTextFile(abs, state.config.maxFileSizeBytes);

      if (r.isBinary) {
        throw new StructuredError(
          ErrorCode.BINARY_FILE,
          "File is binary.",
          "edit_file works only on text files.",
          { path: pathArg }
        );
      }

      const existingTxn = state.transactions.get(abs);

      if (existingTxn) {
        if (r.hash !== existingTxn.currentHash) {
          throw new StructuredError(
            ErrorCode.STALE_CONTENT,
            "File changed externally since the last edit in this transaction.",
            "Roll back the transaction (rollback_file) to restore the original, " +
              "or accept the external change by calling rollback_file first, " +
              "then re-read and start over.",
            {
              expectedHash: existingTxn.currentHash,
              actualHash: r.hash,
              transactionId: existingTxn.transactionId,
            }
          );
        }
        if (
          expectedHash !== undefined &&
          expectedHash !== existingTxn.currentHash
        ) {
          throw new StructuredError(
            ErrorCode.STALE_CONTENT,
            "'expectedHash' does not match the active transaction's current hash.",
            "Use the 'hash' returned by the last edit_file / undo_edit / redo_edit call.",
            {
              expectedHash,
              transactionHash: existingTxn.currentHash,
              transactionId: existingTxn.transactionId,
            }
          );
        }
      } else if (expectedHash !== undefined && expectedHash !== r.hash) {
        throw new StructuredError(
          ErrorCode.STALE_CONTENT,
          "File hash mismatch — content has changed since you last read it.",
          "Re-read the file (read_file) to get a fresh 'hash', then retry with it as 'expectedHash'.",
          { expectedHash, actualHash: r.hash, path: pathArg }
        );
      }

      const normalized = normalizeEol(r.content);
      const newNormalized = applyEdits(normalized, editsRaw as Edit[]);
      const newFinal = denormalizeEol(newNormalized, r.eol);
      const newHash = sha256(newFinal);

      if (newFinal === r.content) {
        const data: Record<string, unknown> = {
          diff: "",
          hash: r.hash,
          editsApplied: editsRaw.length,
          linesBefore: r.totalLines,
          linesAfter: r.totalLines,
          note: "No net text change — file unchanged on disk.",
        };
        if (existingTxn) {
          data.transactionId = existingTxn.transactionId;
          data.pointer = existingTxn.pointer;
          data.snapshotCount = existingTxn.snapshotCount;
        }
        return { ok: true, data };
      }

      const discardedRedos =
        existingTxn && existingTxn.pointer < existingTxn.snapshotCount
          ? existingTxn.snapshotCount - existingTxn.pointer
          : 0;

      const record = await state.transactions.applyEdit({
        filePath: abs,
        originalContent: r.content,
        originalHash: r.hash,
        newContent: newFinal,
        newHash,
      });

      const displayName =
        path.relative(state.config.workspaceRoot, abs) || path.basename(abs);

      const data: Record<string, unknown> = {
        diff: formatUnifiedDiff(normalized, newNormalized, displayName),
        hash: newHash,
        editsApplied: editsRaw.length,
        linesBefore: r.totalLines,
        linesAfter: countLines(newNormalized),
        transactionId: record.transactionId,
        pointer: record.pointer,
        snapshotCount: record.snapshotCount,
      };
      if (discardedRedos > 0) data.redoDiscarded = discardedRedos;

      return { ok: true, data };
    });
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

// ---------- undo_edit ----------

export async function handleUndoEdit(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const steps = requireSteps(args?.steps);
    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);
    const mutex = state.getMutex(abs);

    return await mutex.run(async (): Promise<ToolResult> => {
      const result = await state.transactions.undo(abs, steps);
      return { ok: true, data: result };
    });
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

// ---------- redo_edit ----------

export async function handleRedoEdit(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const steps = requireSteps(args?.steps);
    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);
    const mutex = state.getMutex(abs);

    return await mutex.run(async (): Promise<ToolResult> => {
      const result = await state.transactions.redo(abs, steps);
      return { ok: true, data: result };
    });
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

// ---------- commit_file ----------

export async function handleCommitFile(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);
    const mutex = state.getMutex(abs);

    return await mutex.run(async (): Promise<ToolResult> => {
      const result = await state.transactions.commit(abs);
      return { ok: true, data: result };
    });
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

// ---------- rollback_file ----------

export async function handleRollbackFile(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);
    const mutex = state.getMutex(abs);

    return await mutex.run(async (): Promise<ToolResult> => {
      const result = await state.transactions.rollback(abs);
      return { ok: true, data: result };
    });
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

// ---------- list_transactions ----------

export async function handleListTransactions(
  _args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const now = Date.now();
    const transactions = state.transactions.all().map((t) => ({
      transactionId: t.transactionId,
      path:
        path.relative(state.config.workspaceRoot, t.filePath) || t.filePath,
      pointer: t.pointer,
      snapshotCount: t.snapshotCount,
      canUndo: t.pointer > 0,
      canRedo: t.pointer < t.snapshotCount,
      createdAt: t.createdAt,
      lastEditedAt: t.lastEditedAt,
      ageSec: Math.round((now - t.lastEditedAt) / 1000),
      ttlRemainingSec: Math.max(
        0,
        Math.round((t.lastEditedAt + state.config.timeoutMs - now) / 1000)
      ),
    }));

    return {
      ok: true,
      data: {
        transactions,
        timeoutMs: state.config.timeoutMs,
      },
    };
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

// ---------- util ----------

function toStructured(err: unknown): StructuredError {
  if (err instanceof StructuredError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  return new StructuredError(
    ErrorCode.INTERNAL,
    msg,
    "Report to the developer with the tool name and arguments.",
    {}
  );
}