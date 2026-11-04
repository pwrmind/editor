import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { ErrorCode, StructuredError } from "./errors.js";
import { atomicWriteFile, normalizeEol, sha256 } from "./fs.js";
import { formatUnifiedDiff } from "./edits.js";
import { LockManager } from "./lock.js";

export interface TransactionRecord {
  transactionId: string;
  filePath: string;
  fileHash: string;
  backupPath: string;
  originalExisted: boolean;
  originalHash: string;
  currentHash: string;
  createdAt: number;
  lastEditedAt: number;
  editsCount: number;
}

interface StoreData {
  version: 3;
  transactions: TransactionRecord[];
}

const STORE_VERSION = 3;

export class TransactionManager {
  private state: StoreData = { version: STORE_VERSION, transactions: [] };
  private statePath: string;
  private backupRoot: string;
  private timeoutMs: number;
  private locks: LockManager;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(opts: { backupRoot: string; timeoutMs: number }) {
    this.backupRoot = opts.backupRoot;
    this.timeoutMs = opts.timeoutMs;
    this.statePath = path.join(opts.backupRoot, "state.json");
    this.locks = new LockManager(
      path.join(opts.backupRoot, "locks"),
      opts.timeoutMs
    );
  }

  async init(): Promise<void> {
    await fs.mkdir(this.backupRoot, { recursive: true });
    await fs.mkdir(path.join(this.backupRoot, "backups"), { recursive: true });
    await this.locks.init();
    await this.load();
    await this.verifyOnStartup();
    await this.scanOrphans();
  }

  async shutdown(): Promise<void> {
    await this.saveQueue.catch(() => {});
  }

  // ---- persistence ----

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.version !== STORE_VERSION) {
        console.error(
          `[mcp-edit] state.json version ${parsed?.version} != ${STORE_VERSION}; ` +
            `starting empty. Orphaned backups will be logged and left on disk.`
        );
        return;
      }
      if (!Array.isArray(parsed.transactions)) {
        throw new Error("state.json: transactions is not an array");
      }
      this.state = parsed;
    } catch (err: any) {
      if (err.code === "ENOENT") return;
      console.error("[mcp-edit] failed to load state.json:", err.message);
      try {
        const corrupt = this.statePath + ".corrupt-" + Date.now();
        await fs.rename(this.statePath, corrupt);
        console.error(`[mcp-edit] corrupt state.json moved to ${corrupt}`);
      } catch {
        // ignore
      }
    }
  }

  private async save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2);
    this.saveQueue = this.saveQueue
      .then(async () => {
        await fs.mkdir(path.dirname(this.statePath), { recursive: true });
        await atomicWriteFile(this.statePath, snapshot);
      })
      .catch((err) => {
        console.error("[mcp-edit] failed to save state.json:", err);
      });
    await this.saveQueue;
  }

  private async verifyOnStartup(): Promise<void> {
    const toRemove = new Set<string>();

    for (const t of this.state.transactions) {
      const backupOk = await fileExists(t.backupPath);

      if (!backupOk) {
        console.error(
          `[mcp-edit] txn ${t.transactionId}: backup missing for ${t.filePath}; removing record (file untouched)`
        );
        toRemove.add(t.transactionId);
        continue;
      }

      // Disk vs currentHash.
      try {
        const stat = await fs.stat(t.filePath);
        if (stat.size <= 50 * 1024 * 1024) {
          const raw = await fs.readFile(t.filePath);
          const diskHash = sha256(raw);
          if (diskHash !== t.currentHash) {
            console.error(
              `[mcp-edit] txn ${t.transactionId}: ${t.filePath} changed externally ` +
                `(expected ${t.currentHash}, actual ${diskHash}). ` +
                `Transaction kept; use rollback to restore original, or commit to accept external.`
            );
          }
        }
      } catch {
        // file missing — for created files this is expected on rollback-only
      }
    }

    if (toRemove.size > 0) {
      this.state.transactions = this.state.transactions.filter(
        (t) => !toRemove.has(t.transactionId)
      );
      await this.save();
    }
  }

  private async scanOrphans(): Promise<void> {
    const backupsDir = path.join(this.backupRoot, "backups");
    try {
      const dirs = await fs.readdir(backupsDir);
      const known = new Set(this.state.transactions.map((t) => t.fileHash));
      for (const d of dirs) {
        if (!known.has(d)) {
          console.error(
            `[mcp-edit] orphaned backup directory: ${path.join(backupsDir, d)}`
          );
        }
      }
    } catch {
      // no backups dir
    }
  }

  // ---- queries ----

  get(filePath: string): TransactionRecord | undefined {
    return this.state.transactions.find((t) => t.filePath === filePath);
  }

  // ---- paths ----

  private backupPathFor(filePath: string): {
    dir: string;
    backupPath: string;
    fileHash: string;
  } {
    const fileHash = createHash("sha256")
      .update(filePath)
      .digest("hex")
      .slice(0, 16);
    const dir = path.join(this.backupRoot, "backups", fileHash);
    return { dir, backupPath: path.join(dir, "original"), fileHash };
  }

  // ---- applyEdit ----

  async applyEdit(opts: {
    filePath: string;
    originalContent: string;
    originalHash: string;
    originalExisted: boolean;
    newContent: string;
    newHash: string;
  }): Promise<TransactionRecord> {
    const existing = this.get(opts.filePath);
    if (!existing) return this.startTransaction(opts);
    return this.appendEdit(existing, opts.newContent, opts.newHash);
  }

  private async startTransaction(opts: {
    filePath: string;
    originalContent: string;
    originalHash: string;
    originalExisted: boolean;
    newContent: string;
    newHash: string;
  }): Promise<TransactionRecord> {
    const { dir, backupPath, fileHash } = this.backupPathFor(opts.filePath);
    const transactionId = `tx-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    await this.locks.acquire(fileHash, transactionId);

    try {
      // Race guard for existing files.
      if (opts.originalExisted) {
        const raw = await fs.readFile(opts.filePath);
        const checkHash = sha256(raw);
        if (checkHash !== opts.originalHash) {
          throw new StructuredError(
            ErrorCode.STALE_CONTENT,
            "File changed between read and lock acquisition.",
            "Re-read the file via shell and retry.",
            { expectedHash: opts.originalHash, actualHash: checkHash }
          );
        }
      } else {
        if (await fileExists(opts.filePath)) {
          throw new StructuredError(
            ErrorCode.STALE_CONTENT,
            "File was created by another process between read and lock.",
            "Re-read the file via shell and retry.",
            { path: opts.filePath }
          );
        }
      }

      await fs.mkdir(dir, { recursive: true });
      await atomicWriteFile(backupPath, opts.originalContent);
      await atomicWriteFile(opts.filePath, opts.newContent);

      const record: TransactionRecord = {
        transactionId,
        filePath: opts.filePath,
        fileHash,
        backupPath,
        originalExisted: opts.originalExisted,
        originalHash: opts.originalHash,
        currentHash: opts.newHash,
        createdAt: Date.now(),
        lastEditedAt: Date.now(),
        editsCount: 1,
      };
      this.state.transactions.push(record);
      await this.save();
      return record;
    } catch (err) {
      await this.locks.release(fileHash).catch(() => {});
      await fs.rm(dir, { recursive: true }).catch(() => {});
      throw err;
    }
  }

  private async appendEdit(
    existing: TransactionRecord,
    newContent: string,
    newHash: string
  ): Promise<TransactionRecord> {
    const lockOk = await this.locks.heartbeat(existing.fileHash);
    if (!lockOk) {
      throw new StructuredError(
        ErrorCode.TRANSACTION_CONFLICT,
        "Transaction lock was lost to another process.",
        "Roll back to a known state, or start a new transaction.",
        { filePath: existing.filePath, transactionId: existing.transactionId }
      );
    }

    await atomicWriteFile(existing.filePath, newContent);

    existing.currentHash = newHash;
    existing.lastEditedAt = Date.now();
    existing.editsCount += 1;
    await this.save();
    return existing;
  }

  // ---- commit / rollback ----

  async commit(filePath: string): Promise<{
    transactionId: string;
    editsCount: number;
    durationMs: number;
    finalHash: string;
    diff: string;
  }> {
    const record = this.get(filePath);
    if (!record) {
      throw new StructuredError(
        ErrorCode.NO_ACTIVE_TRANSACTION,
        `No active transaction for ${filePath}.`,
        "Call edit first to start a transaction.",
        { path: filePath }
      );
    }

    const currentRaw = await fs.readFile(record.filePath);
    const currentHash = sha256(currentRaw);
    if (currentHash !== record.currentHash) {
      throw new StructuredError(
        ErrorCode.STALE_CONTENT,
        "File changed externally since the last edit.",
        "Roll back to restore original, or accept the external change by " +
          "rolling back first and editing again.",
        { expectedHash: record.currentHash, actualHash: currentHash }
      );
    }

    const backupRaw = await fs.readFile(record.backupPath);
    const originalLf = normalizeEol(backupRaw.toString("utf-8"));
    const currentLf = normalizeEol(currentRaw.toString("utf-8"));
    const diff = formatUnifiedDiff(
      originalLf,
      currentLf,
      path.basename(record.filePath)
    );

    await fs.rm(path.dirname(record.backupPath), { recursive: true }).catch(() => {});
    await this.locks.release(record.fileHash);

    this.state.transactions = this.state.transactions.filter(
      (t) => t.transactionId !== record.transactionId
    );
    await this.save();

    return {
      transactionId: record.transactionId,
      editsCount: record.editsCount,
      durationMs: Date.now() - record.createdAt,
      finalHash: record.currentHash,
      diff,
    };
  }

  async rollback(filePath: string): Promise<{
    transactionId: string;
    editsRestored: number;
    restoredHash: string;
    diff: string;
  }> {
    const record = this.get(filePath);
    if (!record) {
      throw new StructuredError(
        ErrorCode.NO_ACTIVE_TRANSACTION,
        `No active transaction for ${filePath}.`,
        "Nothing to roll back.",
        { path: filePath }
      );
    }

    const backupRaw = await fs.readFile(record.backupPath);
    const backupContent = backupRaw.toString("utf-8");

    let currentLf = "";
    try {
      const currentRaw = await fs.readFile(record.filePath);
      currentLf = normalizeEol(currentRaw.toString("utf-8"));
    } catch {
      // file gone — diff against empty
    }
    const originalLf = normalizeEol(backupContent);
    const diff = formatUnifiedDiff(
      currentLf,
      originalLf,
      path.basename(record.filePath)
    );

    if (record.originalExisted) {
      await atomicWriteFile(record.filePath, backupContent);
    } else {
      // Created file → delete to restore "no file" state.
      await fs.unlink(record.filePath).catch(() => {});
    }

    await fs.rm(path.dirname(record.backupPath), { recursive: true }).catch(() => {});
    await this.locks.release(record.fileHash);

    this.state.transactions = this.state.transactions.filter(
      (t) => t.transactionId !== record.transactionId
    );
    await this.save();

    const restoredHash = record.originalExisted
      ? sha256(backupContent)
      : sha256("");

    return {
      transactionId: record.transactionId,
      editsRestored: record.editsCount,
      restoredHash,
      diff,
    };
  }

  // ---- cleanup ----

  async cleanupStale(): Promise<TransactionRecord[]> {
    const now = Date.now();
    const rolledBack: TransactionRecord[] = [];

    for (const t of [...this.state.transactions]) {
      if (now - t.lastEditedAt <= this.timeoutMs) continue;

      let diskHash: string | null = null;
      try {
        const raw = await fs.readFile(t.filePath);
        diskHash = sha256(raw);
      } catch {
        // file gone
      }

      if (diskHash !== t.currentHash) {
        console.error(
          `[mcp-edit] auto-rollback skipped for ${t.filePath}: ` +
            `disk hash differs (expected ${t.currentHash}, actual ${diskHash}). ` +
            `Manual rollback required.`
        );
        continue;
      }

      try {
        const backupRaw = await fs.readFile(t.backupPath);
        const backupContent = backupRaw.toString("utf-8");

        if (t.originalExisted) {
          await atomicWriteFile(t.filePath, backupContent);
        } else {
          await fs.unlink(t.filePath).catch(() => {});
        }

        await fs.rm(path.dirname(t.backupPath), { recursive: true }).catch(() => {});
        await this.locks.release(t.fileHash);

        this.state.transactions = this.state.transactions.filter(
          (x) => x.transactionId !== t.transactionId
        );
        rolledBack.push(t);
        console.error(
          `[mcp-edit] auto-rollback: ${t.filePath} ` +
            `(idle ${Math.round((now - t.lastEditedAt) / 1000)}s)`
        );
      } catch (err: any) {
        console.error(
          `[mcp-edit] auto-rollback failed for ${t.filePath}: ${err.message}`
        );
      }
    }

    if (rolledBack.length > 0) await this.save();
    await this.locks.cleanupStale();

    return rolledBack;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}