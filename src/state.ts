import { Mutex } from "./fs.js";
import { Config } from "./config.js";

/**
 * Per-process runtime state. Passed to tool handlers.
 * In P2 it holds only config + per-file mutexes. P3 will add
 * TransactionManager here.
 */
export class ServerState {
  private mutexes = new Map<string, Mutex>();

  constructor(readonly config: Config) {}

  getMutex(filePath: string): Mutex {
    let m = this.mutexes.get(filePath);
    if (!m) {
      m = new Mutex();
      this.mutexes.set(filePath, m);
    }
    return m;
  }
}