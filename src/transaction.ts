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
  originalHash: string;
  currentHash: string;
  createdAt: number;
  lastEditedAt: number;
  editsCount: number;
}

interface StoreData {
  version: 1;
  transactions: TransactionRecord[];
}

export class TransactionManager {
  private state: StoreData = { version: 1, transactions: [] };
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
    // State is persisted on every mutation; nothing to flush.
    await this.saveQueue.catch(() => {});
  }

  // ---- persistence ----

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.statePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed?.version !== 1 || !Array.isArray(parsed.transactions)) {
        throw new Error("Unknown state.json format");
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
    this.saveQueue = this.saveQueue.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      await atomicWriteFile(this.statePath, snapshot);
    }).catch((err) => {
      console.error("[mcp-edit] failed to save state.json:", err);
    });
    await this.saveQueue;
  }

  private async verifyOnStartup(): Promise<void> {
    const toRemove = new Set<string>();
    for (const t of this.state.transactions) {
      const backupOk = await fileExists(t.backupPath);
      const fileOk = await fileExists(t.filePath);

      if (!backupOk) {
        console.error(
          `[mcp-edit] txn ${t.transactionId}: backup missing for ${t.filePath}; removing`
        );
        toRemove.add(t.transactionId);
        continue;
      }

      if (!fileOk) {
        console.error(
          `[mcp-edit] txn ${t.transactionId}: file missing for ${t.filePath}; restoring from backup`
        );
        try {
          const raw = await fs.readFile(t.backupPath);
          await fs.mkdir(path.dirname(t.filePath), { recursive: true });
          await atomicWriteFile(t.filePath, raw.toString("utf-8"));
          await fs.unlink(t.backupPath).catch(() => {});
          await fs.rmdir(path.dirname(t.backupPath)).catch(() => {});
        } catch (err: any) {
          console.error(`[mcp-edit] restore failed: ${err.message}`);
        }
        toRemove.add(t.transactionId);
        continue;
      }

      try {
        const stat = await fs.stat(t.filePath);
        if (stat.size <= 50 * 1024 * 1024) {
          const raw = await fs.readFile(t.filePath);
          const currentHash = sha256(raw);
          if (currentHash !== t.currentHash) {
            console.error(
              `[mcp-edit] txn ${t.transactionId}: ${t.filePath} changed externally ` +
                `(expected ${t.currentHash}, actual ${currentHash}). ` +
                `Transaction kept; use rollback_file to restore original.`
            );
          }
        }
      } catch {
        // ignore
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
            `[mcp-edit] orphaned backup directory: ${path.join(backupsDir, d)} ` +
              `(not referenced by state.json)`
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

  all(): TransactionRecord[] {
    return [...this.state.transactions];
  }

  // ---- mutation ----

  private backupPathFor(filePath: string): {
    dir: string;
    path: string;
    fileHash: string;
  } {
    const fileHash = createHash("sha256")
      .update(filePath)
      .digest("hex")
      .slice(0, 16);
    const dir = path.join(this.backupRoot, "backups", fileHash);
    return { dir, path: path.join(dir, "original"), fileHash };
  }

  async applyEdit(opts: {
    filePath: string;
    originalContent: string;
    originalHash: string;
    newContent: string;
    newHash: string;
  }): Promise<TransactionRecord> {
    const existing = this.get(opts.filePath);

    if (!existing) {
      return this.startTransaction(opts);
    }

    return this.appendEdit(existing, opts.newContent, opts.newHash);
  }

  private async startTransaction(opts: {
    filePath: string;
    originalContent: string;
    originalHash: string;
    newContent: string;
    newHash: string;
  }): Promise<TransactionRecord> {
    const { dir, path: backupPath, fileHash } = this.backupPathFor(
      opts.filePath
    );
    const transactionId = `tx-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    await this.locks.acquire(fileHash, transactionId);

    try {
      // Race guard: re-read after acquiring the lock, verify the file
      // wasn't modified between the caller's read and our lock acquisition.
      const raw = await fs.readFile(opts.filePath);
      const checkHash = sha256(raw);
      if (checkHash !== opts.originalHash) {
        throw new StructuredError(
          ErrorCode.STALE_CONTENT,
          "File changed between read and lock acquisition.",
          "Re-read the file (read_file) and retry with the fresh hash.",
          { expectedHash: opts.originalHash, actualHash: checkHash }
        );
      }

      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(backupPath, opts.originalContent, "utf-8");

      await atomicWriteFile(opts.filePath, opts.newContent);

      const record: TransactionRecord = {
        transactionId,
        filePath: opts.filePath,
        fileHash,
        backupPath,
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
      await fs.unlink(backupPath).catch(() => {});
      await fs.rmdir(dir).catch(() => {});
      throw err;
    }
  }

  private async appendEdit(
    existing: TransactionRecord,
    newContent: string,
    newHash: string
  ): Promise<TransactionRecord> {
    // Verify we still own the lock (another process could have stolen it
    // if our heartbeat went stale, but cleanup should have rolled us back).
    const lockOk = await this.locks.heartbeat(existing.fileHash);
    if (!lockOk) {
      throw new StructuredError(
        ErrorCode.TRANSACTION_CONFLICT,
        "Transaction lock was lost to another process.",
        "Roll back to a known state, or re-read and start a new transaction.",
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
        "Call edit_file first to start a transaction.",
        { path: filePath }
      );
    }

    const currentRaw = await fs.readFile(record.filePath);
    const currentHash = sha256(currentRaw);
    if (currentHash !== record.currentHash) {
      throw new StructuredError(
        ErrorCode.STALE_CONTENT,
        "File changed externally since the last edit.",
        "Roll back the transaction (rollback_file), or re-read and start over.",
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

    await fs.unlink(record.backupPath).catch(() => {});
    await fs.rmdir(path.dirname(record.backupPath)).catch(() => {});
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
    editsReverted: number;
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
    const backupText = backupRaw.toString("utf-8");
    const restoredHash = sha256(backupRaw);

    let currentLf = "";
    try {
      const currentRaw = await fs.readFile(record.filePath);
      currentLf = normalizeEol(currentRaw.toString("utf-8"));
    } catch {
      // File gone — diff against empty
    }

    const originalLf = normalizeEol(backupText);
    const diff = formatUnifiedDiff(
      currentLf,
      originalLf,
      path.basename(record.filePath)
    );

    await atomicWriteFile(record.filePath, backupText);
    await fs.unlink(record.backupPath).catch(() => {});
    await fs.rmdir(path.dirname(record.backupPath)).catch(() => {});
    await this.locks.release(record.fileHash);

    this.state.transactions = this.state.transactions.filter(
      (t) => t.transactionId !== record.transactionId
    );
    await this.save();

    return {
      transactionId: record.transactionId,
      editsReverted: record.editsCount,
      restoredHash,
      diff,
    };
  }

  /**
   * Auto-rollback transactions idle past timeoutMs.
   * Only rolls back if the disk still matches the transaction's currentHash.
   * Dirty transactions are logged and left in place.
   */
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
        // file deleted externally
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
        await atomicWriteFile(t.filePath, backupRaw.toString("utf-8"));
        await fs.unlink(t.backupPath).catch(() => {});
        await fs.rmdir(path.dirname(t.backupPath)).catch(() => {});
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