import * as path from "path";
import { ErrorCode, StructuredError } from "./errors.js";
import {
  atomicWriteFile,
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
// Descriptions (few-shot lives here)
// ============================================================

export const READ_FILE_DESCRIPTION = `
Read a text file from the workspace. Returns:
  • content    — full file, or a slice if startLine/endLine given;
  • hash       — SHA-256 of the raw file bytes (ALWAYS over the FULL file,
                 even when slicing). Pass this hash as 'expectedHash' to
                 edit_file to guard against stale content;
  • eol        — "\\n" or "\\r\\n";
  • totalLines — line count in the full file (git convention);
  • isBinary   — if true, edit_file will refuse this path.

Use read_file to obtain ground truth before any edit. Do NOT guess file
content from memory: the file may have changed.

EXAMPLES:
  read_file({ path: "src/app.ts" })
  read_file({ path: "src/app.ts", startLine: 40, endLine: 60 })
`.trim();

export const SEARCH_FILE_DESCRIPTION = `
Find occurrences of a plain-text pattern in a file (case-sensitive by default).
Returns:
  • matches      — [{ line, column, length, snippet, contextBefore, contextAfter }]
  • hash         — current file hash (same as read_file's hash). Pass it
                   straight to edit_file as 'expectedHash';
  • totalMatches;
  • truncated    — true if there are more matches than maxResults.

Use search_file to 'aim' before editing — confirm the exact text and its
position before calling edit_file. Fewer failed edits, fewer tokens.

EXAMPLES:
  search_file({ path: "src/app.ts", pattern: "function foo" })
  search_file({ path: "src/app.ts", pattern: "TODO", options: { caseSensitive: false } })
`.trim();

export const EDIT_FILE_DESCRIPTION = `
Apply one or more text edits to a file as an ATOMIC BATCH. Either ALL edits
succeed and the file is written, or NONE apply (file untouched). Each edit
sees the result of the previous edits in the same call — ORDER MATTERS.

EDIT KINDS:
  • replace       — { kind, search, replacement }.
                    'search' must occur EXACTLY ONCE; it is replaced verbatim.
  • delete        — { kind, search }. Same uniqueness rule; removes 'search'.
  • insert_before — { kind, anchor, content }.
                    'anchor' must START at a line boundary (column 0 of a
                    line, or file start) and be unique. Include the line's
                    leading whitespace. 'content' is inserted as new line(s)
                    immediately BEFORE the anchor's line.
  • insert_after  — { kind, anchor, content }.
                    'anchor' must END at a line boundary (end with '\\n',
                    reach EOF, or be immediately followed by '\\n') and be
                    unique. 'content' is inserted as new line(s) immediately
                    AFTER the anchor's line.

RULES:
  • 'search' and 'anchor' must match EXACTLY — whitespace, case, indentation.
    Include 2-3 adjacent lines of context to guarantee uniqueness.
  • For insert_before/insert_after, 'anchor' must be a full line (not a
    partial-line substring).
  • Edits run in array order. A later edit may reference text inserted by an
    earlier edit in the same call.
  • If any edit fails (0 matches, >1 matches, mid-line anchor, empty field),
    the whole batch is rejected — nothing is written. Fix the failing edit
    and retry.
  • STRONGLY RECOMMENDED: pass 'expectedHash' from the preceding read_file
    or search_file call. On hash mismatch you get STALE_CONTENT — re-read
    the file (read_file), then retry with the fresh hash.
  • 'replace_all' is NOT supported. To replace multiple occurrences, issue
    one 'replace' edit per unique context block.

RESPONSE:
  • diff        — unified diff (same format as 'git diff');
  • hash        — new file hash. Pass it to the next edit_file call;
  • editsApplied, linesBefore, linesAfter.

FEW-SHOT EXAMPLES:

Example 1 — fix a bug (single replace):
  path: "src/calc.ts"
  edits: [
    { kind: "replace",
      search: "export function add(a: number, b: number): number {\\n  return a - b;\\n}",
      replacement: "export function add(a: number, b: number): number {\\n  return a + b;\\n}" }
  ]

Example 2 — add an import AND a field (batch; order matters — the replace
sees the import added by the first edit):
  path: "src/user.ts"
  edits: [
    { kind: "insert_before",
      anchor: "export class User {",
      content: "import { isEmail } from './validators';" },
    { kind: "replace",
      search: "  constructor(public name: string) {\\n    this.name = name;\\n  }",
      replacement: "  constructor(public name: string) {\\n    if (!isEmail(name)) throw new Error('invalid email');\\n    this.name = name;\\n    this.isActive = true;\\n  }" }
  ]

Example 3 — delete a dead block (include trailing blank line for clean removal):
  path: "src/legacy.ts"
  edits: [
    { kind: "delete",
      search: "function unusedHelper() {\\n  return 42;\\n}\\n\\n" }
  ]

Example 4 — with hash guard:
  path: "src/calc.ts"
  expectedHash: "sha256:ab12…ef34"   // from a prior read_file
  edits: [ { kind: "replace", search: "…", replacement: "…" } ]
`.trim();

// ============================================================
// Tool descriptors
// ============================================================

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
}

export function toolDescriptors(): ToolDescriptor[] {
  return [
    {
      name: "read_file",
      description: READ_FILE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute, or relative to workspace root.",
          },
          startLine: {
            type: "number",
            description: "1-based first line (inclusive).",
          },
          endLine: {
            type: "number",
            description: "1-based last line (inclusive).",
          },
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
          pattern: {
            type: "string",
            description: "Plain-text pattern (case-sensitive by default).",
          },
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
          path: { type: "string", description: "Path to the file." },
          expectedHash: {
            type: "string",
            description:
              "Optional SHA-256 of the file from a prior read_file/search_file. " +
              "If provided and mismatched, the edit is rejected with STALE_CONTENT.",
          },
          edits: {
            type: "array",
            minItems: 1,
            items: {
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
            },
          },
        },
        required: ["path", "edits"],
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

export async function handleReadFile(
  args: any,
  state: ServerState
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const abs = await resolveWorkspacePath(pathArg, state.config.workspaceRoot);

    const startLine =
      typeof args?.startLine === "number" ? args.startLine : undefined;
    const endLine =
      typeof args?.endLine === "number" ? args.endLine : undefined;

    const r = await readTextFile(abs, state.config.maxFileSizeBytes, {
      startLine,
      endLine,
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

      if (expectedHash !== undefined && expectedHash !== r.hash) {
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

      if (newFinal === r.content) {
        return {
          ok: true,
          data: {
            diff: "",
            hash: r.hash,
            editsApplied: editsRaw.length,
            linesBefore: r.totalLines,
            linesAfter: r.totalLines,
            note: "No net text change — file unchanged on disk.",
          },
        };
      }

      await atomicWriteFile(abs, newFinal);

      const newHash = sha256(newFinal);
      const displayName =
        path.relative(state.config.workspaceRoot, abs) || path.basename(abs);

      return {
        ok: true,
        data: {
          diff: formatUnifiedDiff(normalized, newNormalized, displayName),
          hash: newHash,
          editsApplied: editsRaw.length,
          linesBefore: r.totalLines,
          linesAfter: countLines(newNormalized),
        },
      };
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