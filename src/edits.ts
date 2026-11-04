import { createTwoFilesPatch } from "diff";
import { ErrorCode, StructuredError } from "./errors.js";
import { normalizeEol } from "./fs.js";

export interface Edit {
  search: string;
  replacement: string;
}

/**
 * Applies edits to LF-normalized content SEQUENTIALLY.
 * Each edit sees the result of previous ones. On any error, throws —
 * the caller MUST NOT write anything to disk.
 *
 * Special case: search === "" means "the file is empty/new".
 *   - current === "" → returns replacement (create / fill empty)
 *   - current !== "" → INVALID_ARGUMENT
 */
export function applyEdits(originalLf: string, edits: Edit[]): string {
  let current = originalLf;
  for (let i = 0; i < edits.length; i++) {
    current = applyOne(current, edits[i], i);
  }
  return current;
}

function applyOne(current: string, edit: Edit, editIndex: number): string {
  if (
    !edit ||
    typeof edit !== "object" ||
    typeof (edit as any).search !== "string" ||
    typeof (edit as any).replacement !== "string"
  ) {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `edit[${editIndex}] must be { search: string, replacement: string }.`,
      "Provide both fields as strings. To delete a block, use replacement: ''.",
      { editIndex }
    );
  }

  const search = normalizeEol(edit.search);
  const replacement = normalizeEol(edit.replacement);

  // ---- Special case: create / fill empty file ----
  if (search === "") {
    if (current === "") {
      return replacement;
    }
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `edit[${editIndex}]: 'search: ""' can only be used on an empty file.`,
      "The file already has content. To replace it, use the current content " +
        "as 'search' (read it via shell: cat / Get-Content). " +
        "To create a new file, ensure it doesn't exist yet.",
      { editIndex, fileHasContent: true, currentLength: current.length }
    );
  }

  // ---- Normal replace ----
  if (search === replacement) {
    throw new StructuredError(
      ErrorCode.INVALID_ARGUMENT,
      `edit[${editIndex}]: 'search' and 'replacement' are identical.`,
      "Provide a different 'replacement', or omit this edit.",
      { editIndex }
    );
  }

  const count = current.split(search).length - 1;

  if (count === 0) {
    throw new StructuredError(
      ErrorCode.SEARCH_NOT_FOUND,
      `edit[${editIndex}]: 'search' not found.`,
      "Verify exact text: indentation (spaces vs tabs), case, EOL. " +
        "Read the file via shell (cat / Get-Content) and copy the block verbatim, " +
        "including 2–3 adjacent lines for uniqueness.",
      { editIndex, searchPreview: preview(search) }
    );
  }

  if (count > 1) {
    const lines = findOccurrenceLines(current, search);
    throw new StructuredError(
      ErrorCode.SEARCH_AMBIGUOUS,
      `edit[${editIndex}]: 'search' found ${count} times.`,
      `Extend 'search' with 2–3 adjacent lines for uniqueness. ` +
        `Candidate line numbers: ${lines.join(", ")}.`,
      { editIndex, occurrences: count, lines }
    );
  }

  return current.replace(search, replacement);
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