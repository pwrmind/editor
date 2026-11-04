import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { StructuredError, ErrorCode } from "./errors.js";

// ---- Mutex ----

export class Mutex {
  private queue: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ---- EOL ----

export function detectEol(content: string): "\n" | "\r\n" {
  const crlf = content.split("\r\n").length - 1;
  const lf = content.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

export function normalizeEol(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export function denormalizeEol(
  content: string,
  eol: "\n" | "\r\n"
): string {
  return eol === "\n" ? content : content.replace(/\n/g, "\r\n");
}

// ---- Lines ----

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

export function countLines(text: string): number {
  return splitLines(text).length;
}

// ---- Hash ----

export function sha256(buf: Buffer | string): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

// ---- Existence / workspace boundary ----

export async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

export async function resolveWorkspacePath(
  input: string,
  workspaceRoot: string
): Promise<string> {
  const resolvedInput = path.isAbsolute(input)
    ? input
    : path.resolve(workspaceRoot, input);

  let realPath: string;
  try {
    realPath = await fs.realpath(resolvedInput);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      const parent = path.dirname(resolvedInput);
      const realParent = await fs.realpath(parent).catch(() => parent);
      realPath = path.join(realParent, path.basename(resolvedInput));
    } else {
      throw err;
    }
  }

  const realRoot = await fs.realpath(workspaceRoot);
  const rootWithSep = realRoot.endsWith(path.sep)
    ? realRoot
    : realRoot + path.sep;

  if (realPath !== realRoot && !realPath.startsWith(rootWithSep)) {
    throw new StructuredError(
      ErrorCode.WORKSPACE_VIOLATION,
      `Path "${input}" is outside workspace "${workspaceRoot}".`,
      "Use a path inside the workspace root.",
      { path: input, root: workspaceRoot }
    );
  }

  return realPath;
}

// ---- Binary guard ----

const BINARY_CHECK_BYTES = 8192;

export function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---- Read (internal, not exposed as a tool) ----

export interface ReadResult {
  content: string;
  rawSize: number;
  hash: string;
  eol: "\n" | "\r\n";
  totalLines: number;
  isBinary: boolean;
  exists: boolean;
}

export async function readTextFile(
  absolutePath: string,
  maxSizeBytes: number
): Promise<ReadResult> {
  if (!(await fileExists(absolutePath))) {
    return {
      content: "",
      rawSize: 0,
      hash: sha256(""),
      eol: "\n",
      totalLines: 0,
      isBinary: false,
      exists: false,
    };
  }

  const stat = await fs.stat(absolutePath);
  if (stat.size > maxSizeBytes) {
    throw new StructuredError(
      ErrorCode.FILE_TOO_LARGE,
      `File is ${stat.size} bytes, limit is ${maxSizeBytes}.`,
      "Use a different tool for large files.",
      { path: absolutePath, size: stat.size, limit: maxSizeBytes }
    );
  }

  const raw = await fs.readFile(absolutePath);
  const hash = sha256(raw);

  if (looksBinary(raw)) {
    return {
      content: "",
      rawSize: raw.length,
      hash,
      eol: "\n",
      totalLines: 0,
      isBinary: true,
      exists: true,
    };
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new StructuredError(
      ErrorCode.INVALID_ENCODING,
      "File is not valid UTF-8.",
      "Convert the file to UTF-8.",
      { path: absolutePath }
    );
  }

  const eol = detectEol(content);
  const normalized = normalizeEol(content);

  return {
    content: normalized,
    rawSize: raw.length,
    hash,
    eol,
    totalLines: countLines(normalized),
    isBinary: false,
    exists: true,
  };
}

// ---- Atomic write ----

export async function atomicWriteFile(
  filePath: string,
  content: string
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const base = path.basename(filePath);
  const tmp = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`
  );

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    if (handle) await handle.close().catch(() => {});
  }

  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}