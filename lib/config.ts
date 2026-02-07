import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { PluginConfig } from "./types.js";
import { CONFIG_FILENAME } from "./constants.js";

const CONFIG_PATH = join(homedir(), ".opencode", CONFIG_FILENAME);

const DEFAULT_CONFIG: PluginConfig = {
	codexMode: true,
	strategy: "hybrid",
	debug: false,
};

/**
 * Load plugin configuration from ~/.opencode/codex-switch-config.json
 */
export function loadPluginConfig(): PluginConfig {
	try {
		if (!existsSync(CONFIG_PATH)) {
			return DEFAULT_CONFIG;
		}
		const fileContent = readFileSync(CONFIG_PATH, "utf-8");
		const userConfig = JSON.parse(fileContent) as Partial<PluginConfig>;
		return { ...DEFAULT_CONFIG, ...userConfig };
	} catch (error) {
		console.warn(
			`[codex-auto-switch] Failed to load config from ${CONFIG_PATH}:`,
			(error as Error).message,
		);
		return DEFAULT_CONFIG;
	}
}

/**
 * Get effective CODEX_MODE setting
 * Priority: env var > config > default (true)
 */
export function getCodexMode(config: PluginConfig): boolean {
	if (process.env.CODEX_MODE !== undefined) {
		return process.env.CODEX_MODE === "1";
	}
	return config.codexMode ?? true;
}
