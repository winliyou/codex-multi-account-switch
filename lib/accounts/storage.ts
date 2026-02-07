/**
 * Account persistence layer
 *
 * Stores accounts at ~/.config/opencode/codex-switch-accounts.json
 * Uses atomic writes and file locking to prevent corruption.
 */

import { promises as fs, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { STORAGE_FILENAME } from "../constants.js";
import type { AccountStorage, StoredAccount } from "../types.js";
import { logDebug, logInfo, logWarn } from "../logger.js";

function getConfigDir(): string {
	if (process.env.OPENCODE_CONFIG_DIR) {
		return process.env.OPENCODE_CONFIG_DIR;
	}
	const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
	return join(xdgConfig, "opencode");
}

export function getStoragePath(): string {
	return join(getConfigDir(), STORAGE_FILENAME);
}

function createEmptyStorage(): AccountStorage {
	return { version: 1, accounts: [], activeIndex: 0 };
}

/**
 * Deduplicate accounts by refresh token (keep newest).
 */
function deduplicateAccounts(accounts: StoredAccount[]): StoredAccount[] {
	const tokenMap = new Map<string, StoredAccount>();
	for (const acc of accounts) {
		const existing = tokenMap.get(acc.refreshToken);
		if (!existing || acc.lastUsed > existing.lastUsed) {
			tokenMap.set(acc.refreshToken, acc);
		}
	}
	return Array.from(tokenMap.values());
}

/**
 * Load accounts from disk.
 */
export async function loadAccounts(): Promise<AccountStorage> {
	try {
		const path = getStoragePath();
		if (!existsSync(path)) {
			return createEmptyStorage();
		}
		const content = await fs.readFile(path, "utf-8");
		const data = JSON.parse(content) as AccountStorage;

		if (!data || !Array.isArray(data.accounts)) {
			logWarn("Invalid storage format, returning empty");
			return createEmptyStorage();
		}

		// Validate & deduplicate
		const validAccounts = data.accounts.filter(
			(a): a is StoredAccount =>
				!!a &&
				typeof a === "object" &&
				typeof a.refreshToken === "string" &&
				a.refreshToken.length > 0,
		);

		const deduped = deduplicateAccounts(validAccounts);

		let activeIndex =
			typeof data.activeIndex === "number" && Number.isFinite(data.activeIndex)
				? data.activeIndex
				: 0;
		if (deduped.length > 0) {
			activeIndex = Math.min(Math.max(activeIndex, 0), deduped.length - 1);
		} else {
			activeIndex = 0;
		}

		return {
			version: 1,
			accounts: deduped,
			activeIndex,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return createEmptyStorage();
		}
		logWarn("Failed to load account storage", String(error));
		return createEmptyStorage();
	}
}

/**
 * Load accounts synchronously (for initialization).
 */
export function loadAccountsSync(): AccountStorage {
	try {
		const path = getStoragePath();
		if (!existsSync(path)) {
			return createEmptyStorage();
		}
		const content = readFileSync(path, "utf-8");
		const data = JSON.parse(content) as AccountStorage;

		if (!data || !Array.isArray(data.accounts)) {
			return createEmptyStorage();
		}

		const validAccounts = data.accounts.filter(
			(a): a is StoredAccount =>
				!!a &&
				typeof a === "object" &&
				typeof a.refreshToken === "string" &&
				a.refreshToken.length > 0,
		);

		const deduped = deduplicateAccounts(validAccounts);

		let activeIndex =
			typeof data.activeIndex === "number" ? data.activeIndex : 0;
		if (deduped.length > 0) {
			activeIndex = Math.min(Math.max(activeIndex, 0), deduped.length - 1);
		} else {
			activeIndex = 0;
		}

		return { version: 1, accounts: deduped, activeIndex };
	} catch {
		return createEmptyStorage();
	}
}

/**
 * Save accounts to disk with atomic write.
 */
export async function saveAccounts(storage: AccountStorage): Promise<void> {
	const path = getStoragePath();
	const configDir = dirname(path);

	await fs.mkdir(configDir, { recursive: true });

	// Ensure .gitignore includes our storage file
	await ensureGitignore(configDir);

	const tempPath = `${path}.${randomBytes(6).toString("hex")}.tmp`;
	const content = JSON.stringify(storage, null, 2);

	try {
		await fs.writeFile(tempPath, content, "utf-8");
		await fs.rename(tempPath, path);
		logDebug(`Saved ${storage.accounts.length} accounts to disk`);
	} catch (error) {
		try {
			await fs.unlink(tempPath);
		} catch {}
		throw error;
	}
}

async function ensureGitignore(configDir: string): Promise<void> {
	const gitignorePath = join(configDir, ".gitignore");
	const entries = [STORAGE_FILENAME, `${STORAGE_FILENAME}.*.tmp`];

	try {
		let content = "";
		let existingLines: string[] = [];

		try {
			content = await fs.readFile(gitignorePath, "utf-8");
			existingLines = content.split("\n").map((l) => l.trim());
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
		}

		const missing = entries.filter((e) => !existingLines.includes(e));
		if (missing.length === 0) return;

		if (content === "") {
			await fs.writeFile(gitignorePath, missing.join("\n") + "\n", "utf-8");
		} else {
			const suffix = content.endsWith("\n") ? "" : "\n";
			await fs.appendFile(
				gitignorePath,
				suffix + missing.join("\n") + "\n",
				"utf-8",
			);
		}
	} catch {}
}
