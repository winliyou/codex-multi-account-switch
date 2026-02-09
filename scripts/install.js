#!/usr/bin/env node

/**
 * opencode-codex-auto-switch installer
 *
 * Automatically configures opencode.json with:
 * - Plugin entry in the plugin array
 * - OpenAI provider models/options for Codex backend
 * - Removes conflicting opencode-openai-codex-auth plugin
 *
 * Usage:
 *   node scripts/install.js              # Install/update config
 *   node scripts/install.js --uninstall  # Remove plugin from config
 *   node scripts/install.js --dry-run    # Preview changes
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse, modify, applyEdits, printParseErrorCode } from "jsonc-parser";

const PLUGIN_NAME = "opencode-codex-auto-switch";
const CONFLICTING_PLUGINS = [
	"opencode-openai-codex-auth",
];

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
	console.log(
		`Usage: ${PLUGIN_NAME} [--uninstall] [--dry-run] [--no-cache-clear]\n\n` +
		"Default behavior:\n" +
		"  - Installs/updates global config at ~/.config/opencode/opencode.json (or .jsonc)\n" +
		"  - Adds plugin and OpenAI provider config with Codex models\n" +
		"  - Removes conflicting plugins (opencode-openai-codex-auth)\n" +
		"  - Clears OpenCode plugin cache\n\n" +
		"Options:\n" +
		"  --uninstall        Remove plugin + OpenAI config from global config\n" +
		"  --dry-run          Show actions without writing\n" +
		"  --no-cache-clear   Skip clearing OpenCode cache\n"
	);
	process.exit(0);
}

const uninstallRequested = args.has("--uninstall");
const dryRun = args.has("--dry-run");
const skipCacheClear = args.has("--no-cache-clear");

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const templatePath = join(repoRoot, "config", "opencode-modern.json");

const configDir = join(homedir(), ".config", "opencode");
const configPathJson = join(configDir, "opencode.json");
const configPathJsonc = join(configDir, "opencode.jsonc");
const cacheDir = join(homedir(), ".cache", "opencode");

function log(message) {
	console.log(message);
}

function resolveConfigPath() {
	if (existsSync(configPathJsonc)) return configPathJsonc;
	if (existsSync(configPathJson)) return configPathJson;
	return configPathJson;
}

const JSONC_PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };
const JSONC_FORMAT_OPTIONS = { insertSpaces: true, tabSize: 2, eol: "\n" };

async function readJson(filePath) {
	const content = await readFile(filePath, "utf-8");
	return JSON.parse(content);
}

/**
 * Read a JSONC file, returning raw content + parsed data.
 */
async function readJsonc(filePath) {
	const content = await readFile(filePath, "utf-8");
	const errors = [];
	const data = parse(content, errors, JSONC_PARSE_OPTIONS);
	if (errors.length) {
		const formatted = errors
			.map((e) => printParseErrorCode(e.error))
			.join(", ");
		throw new Error(`Invalid JSONC (${formatted})`);
	}
	return { content, data: data ?? {} };
}

/**
 * Apply a list of JSONC modifications, preserving comments and formatting.
 */
function applyJsoncUpdates(content, updates) {
	let next = content;
	for (const update of updates) {
		const edits = modify(next, update.path, update.value, {
			formattingOptions: JSONC_FORMAT_OPTIONS,
		});
		next = applyEdits(next, edits);
	}
	return next.endsWith("\n") ? next : `${next}\n`;
}

function formatJson(obj) {
	return `${JSON.stringify(obj, null, 2)}\n`;
}

async function backupConfig(sourcePath) {
	const timestamp = new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.replace("T", "_")
		.replace("Z", "");
	const backupPath = `${sourcePath}.bak-${timestamp}`;
	if (!dryRun) {
		await copyFile(sourcePath, backupPath);
	}
	return backupPath;
}

/**
 * Check if a plugin entry matches a given name (with or without version pinning).
 */
function pluginMatches(entry, name) {
	if (typeof entry !== "string") return false;
	return entry === name || entry.startsWith(`${name}@`);
}

/**
 * Check if a plugin entry is a file:// path pointing to our plugin.
 */
function isLocalPluginEntry(entry) {
	if (typeof entry !== "string") return false;
	return entry.startsWith("file://") && entry.includes("codex-multi-account-switch");
}

/**
 * Normalize plugin list:
 * - Remove conflicting plugins
 * - Remove old entries of our own plugin
 * - Add our plugin (keeps file:// path if already present)
 */
function normalizePluginList(list) {
	const entries = Array.isArray(list) ? list.filter(Boolean) : [];

	// Find if there's an existing local file:// entry for our plugin
	const existingLocalEntry = entries.find(isLocalPluginEntry);

	const filtered = entries.filter((entry) => {
		if (typeof entry !== "string") return true;
		// Remove conflicting plugins
		for (const conflict of CONFLICTING_PLUGINS) {
			if (pluginMatches(entry, conflict)) return false;
		}
		// Remove our own entries (will re-add below)
		if (pluginMatches(entry, PLUGIN_NAME)) return false;
		if (isLocalPluginEntry(entry)) return false;
		return true;
	});

	// Keep the local file:// path if it was there, otherwise use the npm name
	const pluginEntry = existingLocalEntry || PLUGIN_NAME;
	return [...filtered, pluginEntry];
}

/**
 * Remove our plugin and restore conflicting plugins list (for uninstall).
 */
function removePluginEntries(list) {
	const entries = Array.isArray(list) ? list.filter(Boolean) : [];
	return entries.filter((entry) => {
		if (typeof entry !== "string") return true;
		if (pluginMatches(entry, PLUGIN_NAME)) return false;
		if (isLocalPluginEntry(entry)) return false;
		return true;
	});
}

/**
 * Deep merge OpenAI provider config: merge options and models separately.
 */
function mergeOpenAIConfig(existingOpenAI, templateOpenAI) {
	const existing = existingOpenAI && typeof existingOpenAI === "object"
		? existingOpenAI
		: {};
	const template = templateOpenAI && typeof templateOpenAI === "object"
		? templateOpenAI
		: {};
	const existingOptions =
		existing.options && typeof existing.options === "object"
			? existing.options
			: {};
	const templateOptions =
		template.options && typeof template.options === "object"
			? template.options
			: {};
	const existingModels =
		existing.models && typeof existing.models === "object"
			? existing.models
			: {};
	const templateModels =
		template.models && typeof template.models === "object"
			? template.models
			: {};

	return {
		...existing,
		...template,
		options: { ...existingOptions, ...templateOptions },
		models: { ...existingModels, ...templateModels },
	};
}

/**
 * Get all known model IDs from the template (for clean uninstall).
 */
function getKnownModelIds(template) {
	return new Set(Object.keys(template?.provider?.openai?.models || {}));
}

/**
 * Clear opencode's plugin cache so it picks up the new config.
 */
async function clearCache() {
	if (skipCacheClear) {
		log("Skipping cache clear (--no-cache-clear).");
		return;
	}

	const cacheNodeModules = join(cacheDir, "node_modules", PLUGIN_NAME);
	const cacheBunLock = join(cacheDir, "bun.lock");
	const cachePackageJson = join(cacheDir, "package.json");

	// Also clear conflicting plugin caches
	const conflictCaches = CONFLICTING_PLUGINS.map((p) =>
		join(cacheDir, "node_modules", p)
	);

	if (dryRun) {
		log(`[dry-run] Would clear plugin caches`);
		return;
	}

	await rm(cacheNodeModules, { recursive: true, force: true });
	await rm(cacheBunLock, { force: true });
	for (const cache of conflictCaches) {
		await rm(cache, { recursive: true, force: true });
	}

	// Remove from cache package.json
	if (existsSync(cachePackageJson)) {
		try {
			const cacheData = await readJson(cachePackageJson);
			const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
			let changed = false;
			for (const section of sections) {
				const deps = cacheData?.[section];
				if (deps && typeof deps === "object") {
					for (const name of [PLUGIN_NAME, ...CONFLICTING_PLUGINS]) {
						if (name in deps) {
							delete deps[name];
							changed = true;
						}
					}
				}
			}
			if (changed) {
				await writeFile(cachePackageJson, formatJson(cacheData), "utf-8");
			}
		} catch {}
	}
}

async function main() {
	if (!existsSync(templatePath)) {
		throw new Error(`Config template not found at ${templatePath}`);
	}

	const configPath = resolveConfigPath();
	const configExists = existsSync(configPath);
	const template = await readJson(templatePath);

	if (uninstallRequested) {
		if (!configExists) {
			log("No existing config found. Nothing to uninstall.");
			return;
		}

		const backupPath = await backupConfig(configPath);
		log(`${dryRun ? "[dry-run] Would backup" : "Backup created"}: ${backupPath}`);

		try {
			const { content, data } = await readJsonc(configPath);
			const existing = data ?? {};
			const pluginList = removePluginEntries(existing.plugin);

			// Remove known models from openai provider
			const provider = existing.provider && typeof existing.provider === "object"
				? { ...existing.provider }
				: {};
			const openai = provider.openai && typeof provider.openai === "object"
				? { ...provider.openai }
				: {};

			const knownModelIds = getKnownModelIds(template);
			const existingModels = openai.models && typeof openai.models === "object"
				? { ...openai.models }
				: {};
			for (const modelId of knownModelIds) {
				delete existingModels[modelId];
			}

			if (Object.keys(existingModels).length > 0) {
				openai.models = existingModels;
			} else {
				delete openai.models;
			}

			if (Object.keys(openai).length > 0) {
				provider.openai = openai;
			} else {
				delete provider.openai;
			}

			const updates = [];
			updates.push({
				path: ["plugin"],
				value: pluginList.length > 0 ? pluginList : undefined,
			});

			if (Object.keys(provider).length > 0) {
				updates.push({ path: ["provider"], value: provider });
			} else {
				updates.push({ path: ["provider"], value: undefined });
			}

			if (dryRun) {
				log(`[dry-run] Would write ${configPath} (uninstall)`);
			} else {
				const nextContent = applyJsoncUpdates(content, updates);
				await writeFile(configPath, nextContent, "utf-8");
				log(`Updated ${configPath} (plugin removed)`);
			}
		} catch (error) {
			log(`Warning: Could not parse config (${error}). Skipping.`);
		}

		await clearCache();
		log("\nDone. Restart OpenCode.");
		return;
	}

	// --- Install ---
	template.plugin = [PLUGIN_NAME];

	if (configExists) {
		const backupPath = await backupConfig(configPath);
		log(`${dryRun ? "[dry-run] Would backup" : "Backup created"}: ${backupPath}`);

		try {
			const { content, data } = await readJsonc(configPath);
			const existing = data ?? {};

			// Merge plugin list (removes conflicts, adds ours)
			const mergedPlugins = normalizePluginList(existing.plugin);

			// Merge OpenAI provider config
			const provider = existing.provider && typeof existing.provider === "object"
				? { ...existing.provider }
				: {};
			const mergedOpenAI = mergeOpenAIConfig(provider.openai, template.provider.openai);

			// Apply changes via JSONC modify to preserve comments and formatting
			const nextContent = applyJsoncUpdates(content, [
				{ path: ["plugin"], value: mergedPlugins },
				{ path: ["provider", "openai"], value: mergedOpenAI },
			]);

			if (dryRun) {
				log(`[dry-run] Would write ${configPath}`);
				log(`[dry-run] Plugin list: ${JSON.stringify(mergedPlugins)}`);
			} else {
				await writeFile(configPath, nextContent, "utf-8");
				log(`Updated ${configPath}`);
			}
		} catch (error) {
			log(`Warning: Could not parse existing config (${error}). Creating new config.`);
			if (!dryRun) {
				await writeFile(configPath, formatJson(template), "utf-8");
				log(`Wrote new ${configPath}`);
			}
		}
	} else {
		log("No existing config found. Creating new config.");
		if (!dryRun) {
			await mkdir(configDir, { recursive: true });
			await writeFile(configPath, formatJson(template), "utf-8");
			log(`Created ${configPath}`);
		}
	}

	await clearCache();

	log(`\nDone. ${PLUGIN_NAME} installed.`);
	log("Restart OpenCode, then run 'opencode auth login' to add accounts.");
}

main().catch((error) => {
	console.error(`Install failed: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
});
