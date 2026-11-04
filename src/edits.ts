import { createTwoFilesPatch } from "diff";
import { ErrorCode, StructuredError } from "./errors.js";
import { normalizeEol } from "./fs.js";

export type Edit =
  | { kind: "replace"; search: string; replacement: string }
  | { kind: "insert_before"; anchor: string; content: string }
  | { kind: "insert_after"; anchor: string; content: string }
  | { kind: "delete"; search: string };

/**
 * Applies edits to LF-normalized content SEQUENTIALLY.
 * Each edit sees the result of previous ones. On any error, throws
 * StructuredError — the caller MUST NOT write anything to disk.
 */
export function applyEdits(originalLf: string, edits: Edit[]): string {
  let current = originalLf;
  for (let i = 0; i < edits.length; i++) {
    current = applyOne(current, edits[i], i);
  }
  return current;
}

function applyOne(current: string, edit: Edit, editIndex: number): string {
  if (!edit || typeof edit !== "object" || typeof (edit as any).kind !== "string") {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `edit[${editIndex}] must be an object with a 'kind' field.`,
      "Each edit must have kind: 'replace' | 'insert_before' | 'insert_after' | 'delete'.",
      { editIndex }
    );
  }

  switch (edit.kind) {
    case "replace":
      return applyReplace(current, edit, editIndex);
    case "delete":
      return applyDelete(current, edit, editIndex);
    case "insert_before":
      return applyInsertBefore(current, edit, editIndex);
    case "insert_after":
      return applyInsertAfter(current, edit, editIndex);
    default:
      throw new StructuredError(
        ErrorCode.INVALID_ARGUMENT,
        `edit[${editIndex}]: unknown kind '${(edit as any).kind}'.`,
        "Supported kinds: replace, insert_before, insert_after, delete. " +
          "(replace_all is not supported yet.)",
        { editIndex, kind: (edit as any).kind }
      );
  }
}

// ---- replace ----

function applyReplace(
  current: string,
  edit: { search: string; replacement: string },
  editIndex: number
): string {
  const search = requireNonEmpty(normalizeEol(edit.search), "search", editIndex);
  const replacement = normalizeEol(edit.replacement ?? "");

  if (search === replacement) {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `edit[${editIndex}]: 'search' and 'replacement' are identical.`,
      "Provide a different 'replacement', or omit this edit.",
      { editIndex }
    );
  }

  requireUnique(current, search, editIndex, "search");
  return current.replace(search, replacement);
}

// ---- delete ----

function applyDelete(
  current: string,
  edit: { search: string },
  editIndex: number
): string {
  const search = requireNonEmpty(normalizeEol(edit.search), "search", editIndex);
  requireUnique(current, search, editIndex, "search");
  return current.replace(search, "");
}

// ---- insert_before ----

function applyInsertBefore(
  current: string,
  edit: { anchor: string; content: string },
  editIndex: number
): string {
  const anchor = requireNonEmpty(normalizeEol(edit.anchor), "anchor", editIndex);
  const content = requireNonEmpty(
    normalizeEol(edit.content ?? ""),
    "content",
    editIndex
  );

  requireUnique(current, anchor, editIndex, "anchor");

  const pos = current.indexOf(anchor);

  // Anchor must START at a line boundary (column 0 of a line, or file start).
  if (pos !== 0 && current[pos - 1] !== "\n") {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `edit[${editIndex}]: 'anchor' does not start at the beginning of a line.`,
      "insert_before requires 'anchor' to be a full line starting at column 0. " +
        "Include the line's leading whitespace (indentation).",
      { editIndex, anchorPreview: preview(anchor), position: pos }
    );
  }

  const body = content.endsWith("\n") ? content : content + "\n";
  return current.slice(0, pos) + body + current.slice(pos);
}

// ---- insert_after ----

function applyInsertAfter(
  current: string,
  edit: { anchor: string; content: string },
  editIndex: number
): string {
  const anchor = requireNonEmpty(normalizeEol(edit.anchor), "anchor", editIndex);
  const content = requireNonEmpty(
    normalizeEol(edit.content ?? ""),
    "content",
    editIndex
  );

  requireUnique(current, anchor, editIndex, "anchor");

  const anchorEnd = current.indexOf(anchor) + anchor.length;
  let insertAt: number;
  let needsLeadingNewline = false;

  if (anchor.endsWith("\n")) {
    // Anchor already ends at a line terminator; insert straight after it.
    insertAt = anchorEnd;
  } else if (anchorEnd === current.length) {
    // Anchor ends at EOF without trailing newline.
    insertAt = anchorEnd;
    needsLeadingNewline = true;
  } else if (current[anchorEnd] === "\n") {
    // Anchor ends at end-of-line; skip the terminator so the new content
    // starts on its own line.
    insertAt = anchorEnd + 1;
  } else {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `edit[${editIndex}]: 'anchor' does not end at the end of a line.`,
      "insert_after requires 'anchor' to be a full line (end with '\\n' or reach EOF, " +
        "or be followed by '\\n'). Extend the anchor to a complete line.",
      { editIndex, anchorPreview: preview(anchor), position: anchorEnd }
    );
  }

  const body = content.endsWith("\n") ? content : content + "\n";
  const insert = needsLeadingNewline ? "\n" + body : body;
  return current.slice(0, insertAt) + insert + current.slice(insertAt);
}

// ---- validation helpers ----

function requireNonEmpty(
  value: string,
  field: string,
  editIndex: number
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `edit[${editIndex}]: '${field}' must be a non-empty string.`,
      `Provide a non-empty '${field}'.`,
      { editIndex, field }
    );
  }
  return value;
}

function requireUnique(
  haystack: string,
  needle: string,
  editIndex: number,
  field: "search" | "anchor"
): void {
  const count = haystack.split(needle).length - 1;

  if (count === 0) {
    const code =
      field === "search" ? ErrorCode.SEARCH_NOT_FOUND : ErrorCode.ANCHOR_NOT_FOUND;
    throw new StructuredError(
      code,
      `edit[${editIndex}]: '${field}' not found.`,
      `Verify exact text: indentation (spaces vs tabs), case, EOL. ` +
        `Re-read the file (read_file) and copy the block verbatim.`,
      { editIndex, [`${field}Preview`]: preview(needle) }
    );
  }

  if (count > 1) {
    const code =
      field === "search" ? ErrorCode.SEARCH_AMBIGUOUS : ErrorCode.ANCHOR_AMBIGUOUS;
    throw new StructuredError(
      code,
      `edit[${editIndex}]: '${field}' found ${count} times.`,
      `Extend '${field}' with 2-3 adjacent lines for uniqueness. ` +
        `Candidate line numbers: ${findOccurrenceLines(haystack, needle).join(", ")}.`,
      {
        editIndex,
        occurrences: count,
        lines: findOccurrenceLines(haystack, needle),
      }
    );
  }
}

function findOccurrenceLines(haystack: string, needle: string): number[] {
  const lines: number[] = [];
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx < 0) break;
    lines.push(haystack.slice(0, idx).split("\n").length);
    from = idx + Math.max(1, needle.length);
  }
  return lines;
}

function preview(s: string, maxLen = 80): string {
  const first = s.split("\n")[0];
  return first.length > maxLen ? first.slice(0, maxLen) + "…" : first;
}

// ---- unified diff ----

/**
 * Unified diff between two LF-normalized strings, in git format.
 * Returns an empty string if there are no changes.
 */
export function formatUnifiedDiff(
  oldLf: string,
  newLf: string,
  fileName: string
): string {
  return createTwoFilesPatch(
    "a/" + fileName,
    "b/" + fileName,
    oldLf,
    newLf,
    "",
    "",
    { context: 3 }
  );
}