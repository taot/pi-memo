/**
 * Single-writer lock per store. Readers never lock.
 *
 * The lock is a directory under `.local/`, so acquiring it is atomic on every
 * platform. A lock older than `STALE_MS` is assumed to belong to a crashed
 * session and is taken over.
 */
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { localDir } from "./paths.ts";

const STALE_MS = 60_000;
const RETRY_MS = 25;
const TIMEOUT_MS = 5_000;

function lockDir(storeDir: string): string {
	return path.join(localDir(storeDir), "lock");
}

function sleep(ms: number): void {
	// Synchronous wait: memory mutations are short and run outside the event loop hot path.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(storeDir: string): void {
	const dir = lockDir(storeDir);
	const deadline = Date.now() + TIMEOUT_MS;
	mkdirSync(localDir(storeDir), { recursive: true });

	for (;;) {
		try {
			mkdirSync(dir);
			writeFileSync(path.join(dir, "owner"), `${process.pid}\n`, "utf8");
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let age = 0;
			try {
				age = Date.now() - statSync(dir).mtimeMs;
			} catch {
				continue;
			}
			if (age > STALE_MS) {
				rmSync(dir, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) {
				let owner = "unknown";
				try {
					owner = readFileSync(path.join(dir, "owner"), "utf8").trim();
				} catch {
					/* ignore */
				}
				throw new Error(
					`memory store ${storeDir} is locked by another session (pid ${owner}); retry once it finishes`,
				);
			}
			sleep(RETRY_MS);
		}
	}
}

function release(storeDir: string): void {
	rmSync(lockDir(storeDir), { recursive: true, force: true });
}

/** Run `fn` while holding the store's write lock. */
export function withStoreLock<T>(storeDir: string, fn: () => T): T {
	acquire(storeDir);
	try {
		return fn();
	} finally {
		release(storeDir);
	}
}
