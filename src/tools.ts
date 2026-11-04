import { Config } from "./config.js";
import { ErrorCode, StructuredError } from "./errors.js";
import {
  normalizeEol,
  readTextFile,
  resolveWorkspacePath,
} from "./fs.js";

// ---- Descriptors (few-shot здесь) ----

export const READ_FILE_DESCRIPTION = `
Read a text file from the workspace. Returns:
  • content   — full file, or a slice if startLine/endLine given;
  • hash      — SHA-256 of the raw file bytes (ALWAYS over the FULL file,
                even when slicing). Pass this hash verbatim as 'expectedHash'
                to edit_file later — it is the stale-context guard;
  • eol       — "\\n" or "\\r\\n". Use this exact style when composing
                'search'/'replace' strings later;
  • totalLines — line count in the full file (git convention);
  • isBinary  — if true, edit_file will refuse this path.

Use read_file to obtain ground truth before any edit. Do NOT guess file
content from memory: the file may have changed.

EXAMPLES:
  read_file({ path: "src/app.ts" })
  read_file({ path: "src/app.ts", startLine: 40, endLine: 60 })
`.trim();

export const SEARCH_FILE_DESCRIPTION = `
Find occurrences of a plain-text pattern in a file (P1: plain mode only,
case-sensitive by default). Returns:
  • matches     — [{ line, column, length, snippet, contextBefore, contextAfter }]
  • hash        — current file hash (same as read_file's hash). Pass it
                  straight to edit_file as 'expectedHash' later;
  • totalMatches;
  • truncated   — true if there are more matches than maxResults; refine the
                  pattern if you see this.

Use search_file to 'aim' before editing: confirm the exact text and its
position before calling edit_file. Fewer failed edits, fewer tokens.

EXAMPLES:
  search_file({ path: "src/app.ts", pattern: "function foo" })
  search_file({ path: "src/app.ts", pattern: "TODO", options: { caseSensitive: false } })
  search_file({ path: "src/app.ts", pattern: "return", options: { contextLines: 0, maxResults: 5 } })
`.trim();

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
            description:
              "Path to the file (absolute, or relative to the workspace root).",
          },
          startLine: {
            type: "number",
            description: "1-based first line (inclusive). Optional.",
          },
          endLine: {
            type: "number",
            description: "1-based last line (inclusive). Optional.",
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
          path: { type: "string", description: "Path to the file." },
          pattern: {
            type: "string",
            description: "Plain-text pattern (P1: no regex support yet).",
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
  ];
}

// ---- Handlers ----

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
  config: Config
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const abs = await resolveWorkspacePath(pathArg, config.workspaceRoot);

    const startLine =
      typeof args?.startLine === "number" ? args.startLine : undefined;
    const endLine =
      typeof args?.endLine === "number" ? args.endLine : undefined;

    const r = await readTextFile(abs, config.maxFileSizeBytes, {
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
  config: Config
): Promise<ToolResult> {
  try {
    const pathArg = requireString(args?.path, "path");
    const pattern = requireString(args?.pattern, "pattern");

    const opts = args?.options ?? {};
    const caseSensitive: boolean = opts.caseSensitive ?? true;
    const maxResults: number = Math.max(1, opts.maxResults ?? 100);
    const contextLines: number = Math.max(0, opts.contextLines ?? 2);

    const abs = await resolveWorkspacePath(pathArg, config.workspaceRoot);
    const r = await readTextFile(abs, config.maxFileSizeBytes);

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
          const before = lines.slice(Math.max(0, i - contextLines), i);
          const after = lines.slice(i + 1, i + 1 + contextLines);
          matches.push({
            line: i + 1,
            column: idx + 1,
            length: pattern.length,
            snippet: line,
            contextBefore: before,
            contextAfter: after,
          });
        } else {
          truncated = true;
        }
        from = idx + Math.max(1, pattern.length);
      }
    }

    return {
      ok: true,
      data: {
        matches,
        hash: r.hash,
        totalMatches,
        truncated,
      },
    };
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