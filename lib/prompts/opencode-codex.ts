/**
 * OpenCode Codex Prompt Fetcher
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const OPENCODE_CODEX_URL =
	"https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/codex.txt";
const CACHE_DIR = join(homedir(), ".opencode", "cache");
const CACHE_FILE = join(CACHE_DIR, "opencode-codex.txt");
const CACHE_META_FILE = join(CACHE_DIR, "opencode-codex-meta.json");

interface CacheMeta {
	etag: string;
	lastFetch?: string;
	lastChecked: number;
}

export async function getOpenCodeCodexPrompt(): Promise<string> {
	await mkdir(CACHE_DIR, { recursive: true });

	let cachedContent: string | null = null;
	let cachedMeta: CacheMeta | null = null;

	try {
		cachedContent = await readFile(CACHE_FILE, "utf-8");
		const metaContent = await readFile(CACHE_META_FILE, "utf-8");
		cachedMeta = JSON.parse(metaContent);
	} catch {}

	const CACHE_TTL_MS = 15 * 60 * 1000;
	if (
		cachedMeta?.lastChecked &&
		Date.now() - cachedMeta.lastChecked < CACHE_TTL_MS &&
		cachedContent
	) {
		return cachedContent;
	}

	const headers: Record<string, string> = {};
	if (cachedMeta?.etag) headers["If-None-Match"] = cachedMeta.etag;

	try {
		const response = await fetch(OPENCODE_CODEX_URL, { headers });

		if (response.status === 304 && cachedContent) return cachedContent;

		if (response.ok) {
			const content = await response.text();
			const etag = response.headers.get("etag") || "";

			await writeFile(CACHE_FILE, content, "utf-8");
			await writeFile(
				CACHE_META_FILE,
				JSON.stringify(
					{
						etag,
						lastFetch: new Date().toISOString(),
						lastChecked: Date.now(),
					} satisfies CacheMeta,
					null,
					2,
				),
				"utf-8",
			);
			return content;
		}

		if (cachedContent) return cachedContent;
		throw new Error("Failed to fetch: " + response.status);
	} catch (error) {
		if (cachedContent) return cachedContent;
		throw new Error("Failed to fetch and no cache: " + error);
	}
}
