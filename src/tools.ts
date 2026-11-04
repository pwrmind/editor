import * as path from "path";
import { ErrorCode, StructuredError } from "./errors.js";
import {
  countLines,
  denormalizeEol,
  readTextFile,
  resolveWorkspacePath,
  sha256,
} from "./fs.js";
import { applyEdits, Edit, formatUnifiedDiff } from "./edits.js";
import { ServerState } from "./state.js";

// ============================================================
// Descriptions (short, actionable)
// ============================================================

const EDIT_DESCRIPTION = `
Apply one or more text edits to a file as an ATOMIC BATCH. Either all edits
succeed and the file is written, or none apply.

EDIT FORMAT: { search: string, replacement: string }
  • 'search' must occur EXACTLY ONCE in the file (after applying any earlier
    edits in the same call). It is replaced verbatim.
  • 'replacement' can be empty — that deletes the block.
  • Edits run in array order. Each edit sees the previous edit's result.

CREATING A FILE — special case for 'search: ""':
  • Call edit(path, [{ search: "", replacement: <full content> }]).
  • 'search: ""' means "the file is empty / new". Valid only as the FIRST
    edit on a file that is empty or doesn't exist.
  • For an empty file: [{ search: "", replacement: "" }].
  • If the file already has content and you use 'search: ""', the server
    returns INVALID_ARGUMENT with guidance.

FINDING A UNIQUE 'search' BLOCK:
  • Read the file via shell first: 'cat file' (Linux/macOS) or
    'Get-Content file' / 'type file' (Windows). Or 'grep -n' / 'Select-String'
    for targeted lookups.
  • Copy the block VERBATIM — whitespace, case, and line endings matter.
  • Include 2–3 adjacent lines of context to guarantee uniqueness.
  • 'search' matching 0 times → SEARCH_NOT_FOUND.
  • 'search' matching >1 times → SEARCH_AMBIGUOUS (line numbers in details).

TRANSACTIONS:
  • The first edit starts a transaction and writes a byte-for-byte backup
    under .editor/backups/<hash>/original.
  • Subsequent edits append to the active transaction.
  • The file is written to disk on every edit — the transaction is a safety
    net, not a staging area.
  • Call commit(path) to finalize, or rollback(path) to restore the original.
  • Auto-rollback on idle past MCP_EDIT_TIMEOUT_MS (default 10 min) — only if
    the disk still matches the transaction.
  • If the file is modified externally, subsequent edit/commit return
    STALE_CONTENT. Use rollback, or start over.

RESPONSE:
  • diff           — unified diff (git format);
  • hash           — current file hash;
  • transactionId  — transaction this edit belongs to;
  • editsCount     — cumulative edits in the transaction;
  • linesBefore, linesAfter.

FEW-SHOT EXAMPLES:

1. Fix a bug:
   edit("src/calc.ts", [
     { search: "return a - b;", replacement: "return a + b;" }
   ])

2. Add an import (unique anchor from the file):
   edit("src/user.ts", [
     { search: "export class User {",
       replacement: "import { isEmail } from './validators';\\n\\nexport class User {" }
   ])

3. Delete a block:
   edit("src/legacy.ts", [
     { search: "function unusedHelper() {\\n  return 42;\\n}\\n\\n",
       replacement: "" }
   ])

4. Create a file:
   edit("index.html", [
     { search: "", replacement: "<!DOCTYPE html>\\n<html lang=\\"en\\">...</html>" }
   ])

5. Create an empty file:
   edit("empty.txt", [{ search: "", replacement: "" }])
`.trim();

const COMMIT_DESCRIPTION = `
Finalize the ACTIVE transaction for a file. Deletes the backup.
The current on-disk content becomes permanent.

Call only when you're confident the edits are correct (tests/lint pass).
If the file was modified externally since the last edit, returns
STALE_CONTENT — roll back, or re-read and start over.

RESPONSE: transactionId, editsCount, durationMs, finalHash,
          diff (original → committed).

EXAMPLES:
  commit("src/calc.ts")
`.trim();

const ROLLBACK_DESCRIPTION = `
Discard the ACTIVE transaction for a file and restore its ORIGINAL content
byte-for-byte (as it was before the first edit). Deletes the backup.
If the file was created by edit() and didn't exist before, it is DELETED.

NOTE: any external changes made after the transaction started will be lost.
      Unlike undo, this always jumps back to the pre-transaction state.

RESPONSE: transactionId, editsRestored, restoredHash,
          diff (current → original).

EXAMPLES:
  rollback("src/calc.ts")
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
  return [
    {
      name: "edit",
      description: EDIT_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Path to the file (absolute, or relative to MCP_EDIT_ROOT).",
          },
          edits: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                search: {
                  type: "string",
                  description:
                    "Exact unique block to find. Empty string means 'create file' " +
                    "(only on empty or non-existent files).",
                },
                replacement: {
                  type: "string",
                  description:
                    "Replacement text. Empty string deletes the block.",
                },
              },
              required: ["search", "replacement"],
            },
          },
        },
        required: ["path", "edits"],
      },
    },
    {
      name: "commit",
      description: COMMIT_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
        },
        required: ["path"],
      },
    },
    {
      name: "rollback",
      description: ROLLBACK_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path to the file." },
        },
        required: ["path"],
      },
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

export async function handleEdit(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const editsRaw = args?.edits;

    if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
      throw new StructuredError(
        ErrorCode.INVALID_ARGUMENT,
        "'edits' must be a non-empty array of { search, replacement }.",
        "To create an empty file: [{ search: '', replacement: '' }]. " +
          "To create a file with content: [{ search: '', replacement: '<content>' }].",
        { field: "edits" }
      );
    }

    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);
    const mutex = state.getMutex(abs);

    return await mutex.run(async (): Promise<ToolResult> => {
      const r = await readTextFile(abs, state.config.maxFileSizeBytes);

      if (r.exists && r.isBinary) {
        throw new StructuredError(
          ErrorCode.BINARY_FILE,
          "File is binary.",
          "edit works only on text files.",
          { path: pathArg }
        );
      }

      // Creation pre-check: if file doesn't exist, first edit must be search: "".
      if (!r.exists) {
        const firstEdit = editsRaw[0];
        if (!firstEdit || firstEdit.search !== "") {
          throw new StructuredError(
            ErrorCode.FILE_NOT_FOUND,
            `File does not exist: ${pathArg}`,
            "To create it, call edit with [{ search: '', replacement: '<content>' }]. " +
              "If the file exists elsewhere, check that MCP_EDIT_ROOT matches " +
              "your shell's current working directory.",
            { path: pathArg, resolved: abs, workspaceRoot: state.config.workspaceRoot }
          );
        }
      }

      // Active transaction check.
      const existingTxn = state.transactions.get(abs);
      if (existingTxn) {
        if (r.hash !== existingTxn.currentHash) {
          throw new StructuredError(
            ErrorCode.STALE_CONTENT,
            "File changed externally since the last edit in this transaction.",
            "Roll back the transaction (rollback), or accept the external change " +
              "by calling rollback first and starting over.",
            {
              expectedHash: existingTxn.currentHash,
              actualHash: r.hash,
              transactionId: existingTxn.transactionId,
            }
          );
        }
      }

      // Apply edits.
      const normalizedOriginal = r.content;
      const newNormalized = applyEdits(normalizedOriginal, editsRaw as Edit[]);
      const newFinal = denormalizeEol(newNormalized, r.eol);
      const newHash = sha256(newFinal);

      // No net change + file exists → short-circuit.
      if (r.exists && newNormalized === normalizedOriginal) {
        const data: Record<string, unknown> = {
          diff: "",
          hash: r.hash,
          editsCount: existingTxn ? existingTxn.editsCount : 0,
          linesBefore: r.totalLines,
          linesAfter: r.totalLines,
          note: "No net text change — file unchanged on disk.",
        };
        if (existingTxn) data.transactionId = existingTxn.transactionId;
        return { ok: true, data };
      }

      const record = await state.transactions.applyEdit({
        filePath: abs,
        originalContent: denormalizeEol(normalizedOriginal, r.eol),
        originalHash: r.hash,
        originalExisted: r.exists,
        newContent: newFinal,
        newHash,
      });

      const displayName =
        path.relative(state.config.workspaceRoot, abs) || path.basename(abs);

      return {
        ok: true,
        data: {
          diff: formatUnifiedDiff(normalizedOriginal, newNormalized, displayName),
          hash: newHash,
          editsApplied: editsRaw.length,
          linesBefore: r.totalLines,
          linesAfter: countLines(newNormalized),
          transactionId: record.transactionId,
          editsCount: record.editsCount,
        },
      };
    });
  } catch (err) {
    return { ok: false, error: toStructured(err) };
  }
}

export async function handleCommit(
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

export async function handleRollback(
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