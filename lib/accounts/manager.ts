/**
 * Account Manager
 *
 * Central coordinator for multi-account management:
 * - Account CRUD operations
 * - Token refresh per account
 * - Rate limit tracking and rotation
 * - Selection strategy dispatch
 */

import { decodeJWT, refreshAccessToken } from "../auth/auth.js";
import { JWT_CLAIM_PATH, BACKOFF, PLUGIN_NAME } from "../constants.js";
import { logDebug, logWarn } from "../logger.js";
import type {
	AccountSelectionStrategy,
	ManagedAccount,
	RateLimitReason,
	StoredAccount,
	TokenSuccess,
} from "../types.js";
import {
	HealthScoreTracker,
	TokenBucketTracker,
	selectHybridAccount,
	selectRoundRobin,
	selectSticky,
	type AccountMetrics,
} from "./rotation.js";
import { loadAccounts, saveAccounts } from "./storage.js";

export class AccountManager {
	private accounts: ManagedAccount[] = [];
	private activeIndex: number | null = null;
	private strategy: AccountSelectionStrategy;
	private healthTracker: HealthScoreTracker;
	private tokenTracker: TokenBucketTracker;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private loaded = false;

	constructor(strategy: AccountSelectionStrategy = "hybrid") {
		this.strategy = strategy;
		this.healthTracker = new HealthScoreTracker();
		this.tokenTracker = new TokenBucketTracker();
	}

	/**
	 * Load accounts from disk. Safe to call multiple times (idempotent).
	 */
	async load(): Promise<void> {
		if (this.loaded) return;
		const storage = await loadAccounts();
		this.accounts = storage.accounts.map((acc, i) => ({
			...acc,
			index: i,
		}));
		this.activeIndex =
			storage.accounts.length > 0 ? storage.activeIndex : null;
		this.loaded = true;
		logDebug(`Loaded ${this.accounts.length} accounts from disk`);
	}

	/**
	 * Get the total number of accounts.
	 */
	get count(): number {
		return this.accounts.length;
	}

	/**
	 * Get account summaries for logging.
	 */
	getSummary(): string {
		if (this.accounts.length === 0) return "No accounts";
		return this.accounts
			.map((a, i) => {
				const active = i === this.activeIndex ? " *" : "  ";
				const status = !a.enabled
					? "disabled"
					: this.isRateLimited(a)
						? "rate-limited"
						: "ok";
				const health = this.healthTracker.getScore(i);
				return `  [${i}]${active} ${a.email || a.accountId || "unknown"} (${status}, health=${health})`;
			})
			.join("\n");
	}

	/**
	 * Get a short label for the given account (for per-request logging).
	 */
	getAccountLabel(account: ManagedAccount): string {
		return `[${account.index}] ${account.email || account.accountId || "unknown"}`;
	}

	/**
	 * Add a new account from OAuth tokens.
	 * Returns the account index.
	 *
	 * IMPORTANT: This method loads existing accounts from disk first to prevent
	 * overwriting previously saved accounts (the authorize flow may call this
	 * before loader() has a chance to run).
	 */
	async addAccount(tokens: TokenSuccess): Promise<number> {
		// Ensure existing accounts are loaded from disk before modifying.
		// Without this, authorize → addAccount would start with an empty array
		// and overwrite all previously saved accounts.
		await this.load();

		const decoded = decodeJWT(tokens.access);
		const accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		// Email lives under the "https://api.openai.com/profile" claim, not top-level
		const profileClaim = decoded?.["https://api.openai.com/profile"] as
			| { email?: string }
			| undefined;
		const email = profileClaim?.email ?? (decoded?.email as string | undefined);

		// Check if account already exists (by refresh token or accountId)
		const existingIdx = this.accounts.findIndex(
			(a) =>
				a.refreshToken === tokens.refresh ||
				(accountId && a.accountId === accountId),
		);

		if (existingIdx >= 0) {
			// Update existing account
			const existing = this.accounts[existingIdx]!;
			existing.refreshToken = tokens.refresh;
			existing.accessToken = tokens.access;
			existing.accessTokenExpires = tokens.expires;
			existing.accountId = accountId;
			existing.email = email || existing.email;
			existing.enabled = true;
			existing.consecutiveFailures = 0;
			existing.rateLimitResetTime = undefined;
			existing.rateLimitReason = undefined;
			this.healthTracker.reset(existingIdx);

			logDebug(
				`Updated existing account [${existingIdx}] ${existing.email || accountId || "unknown"}`,
			);
			// Save immediately to prevent data loss (process may exit soon after auth)
			await this.saveToDisk();
			return existingIdx;
		}

		// Add new account
		const newAccount: ManagedAccount = {
			index: this.accounts.length,
			email,
			refreshToken: tokens.refresh,
			accessToken: tokens.access,
			accessTokenExpires: tokens.expires,
			accountId,
			addedAt: Date.now(),
			lastUsed: 0,
			enabled: true,
			consecutiveFailures: 0,
		};

		this.accounts.push(newAccount);

		// Set as active if first account
		if (this.accounts.length === 1) {
			this.activeIndex = 0;
		}

		logDebug(
			`Added account [${newAccount.index}] ${email || accountId || "unknown"} (total: ${this.accounts.length})`,
		);
		// Save immediately to prevent data loss (process may exit soon after auth)
		await this.saveToDisk();
		return newAccount.index;
	}

	/**
	 * Select the best account for the current request.
	 * Returns null if no accounts are available.
	 */
	selectAccount(): ManagedAccount | null {
		if (this.accounts.length === 0) return null;

		const metrics: AccountMetrics[] = this.accounts.map((acc) => ({
			index: acc.index,
			lastUsed: acc.lastUsed,
			healthScore: this.healthTracker.getScore(acc.index),
			isRateLimited: this.isRateLimited(acc),
			enabled: acc.enabled,
		}));

		let selectedIndex: number | null;

		// For single account, always use sticky
		const effectiveStrategy =
			this.accounts.length === 1 ? "sticky" : this.strategy;

		switch (effectiveStrategy) {
			case "round-robin":
				selectedIndex = selectRoundRobin(metrics, this.activeIndex);
				break;
			case "sticky":
				selectedIndex = selectSticky(metrics, this.activeIndex);
				break;
			case "hybrid":
			default:
				selectedIndex = selectHybridAccount(
					metrics,
					this.tokenTracker,
					this.activeIndex,
				);
				break;
		}

		if (selectedIndex === null) {
			// All accounts are rate-limited; try to find the one that resets soonest
			const enabledAccounts = this.accounts.filter((a) => a.enabled);
			if (enabledAccounts.length === 0) return null;

			const soonest = enabledAccounts.reduce((prev, curr) => {
				const prevReset = prev.rateLimitResetTime ?? Infinity;
				const currReset = curr.rateLimitResetTime ?? Infinity;
				return currReset < prevReset ? curr : prev;
			});

			logWarn(
				`All accounts rate-limited, using soonest-to-reset: [${soonest.index}] ${soonest.email || "unknown"}`,
			);
			selectedIndex = soonest.index;
		}

		// Track switch
		if (this.activeIndex !== selectedIndex) {
			const prev = this.activeIndex !== null ? this.accounts[this.activeIndex] : null;
			const next = this.accounts[selectedIndex!];
			logDebug(
				`Account switch: [${prev?.index ?? "none"}]${prev?.email ? ` ${prev.email}` : ""} → [${next?.index}]${next?.email ? ` ${next.email}` : ""}`,
			);
		}

		this.activeIndex = selectedIndex;
		return this.accounts[selectedIndex!] ?? null;
	}

	/**
	 * Ensure the given account has a valid access token.
	 * Refreshes if expired. Returns updated account or null on failure.
	 */
	async ensureAccessToken(account: ManagedAccount): Promise<ManagedAccount | null> {
		if (
			account.accessToken &&
			account.accessTokenExpires &&
			account.accessTokenExpires > Date.now() + 60_000 // 60s buffer
		) {
			return account;
		}

		logDebug(`Refreshing token for account [${account.index}] ${account.email || "unknown"}`);

		const result = await refreshAccessToken(account.refreshToken);
		if (result.type === "failed") {
			logWarn(
				`Token refresh failed for account [${account.index}] ${account.email || "unknown"}`,
			);
			this.recordFailure(account.index);
			return null;
		}

		// Update account
		account.refreshToken = result.refresh;
		account.accessToken = result.access;
		account.accessTokenExpires = result.expires;

		// Update accountId if not set
		if (!account.accountId) {
			const decoded = decodeJWT(result.access);
			account.accountId = decoded?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
			const profileClaim = decoded?.["https://api.openai.com/profile"] as
				| { email?: string }
				| undefined;
			account.email =
				profileClaim?.email ??
				(decoded?.email as string | undefined) ??
				account.email;
		}

		this.scheduleSave();
		return account;
	}

	/**
	 * Record a successful request for an account.
	 */
	recordSuccess(index: number): void {
		const account = this.accounts[index];
		if (!account) return;

		account.lastUsed = Date.now();
		account.consecutiveFailures = 0;
		this.healthTracker.recordSuccess(index);
		this.tokenTracker.consume(index);
		this.scheduleSave();
	}

	/**
	 * Mark an account as rate-limited.
	 */
	markRateLimited(index: number, reason: RateLimitReason): void {
		const account = this.accounts[index];
		if (!account) return;

		const backoffMs = this.calculateBackoff(reason, account.consecutiveFailures);
		account.rateLimitResetTime = Date.now() + backoffMs;
		account.rateLimitReason = reason;
		account.consecutiveFailures++;

		this.healthTracker.recordRateLimit(index);

		logDebug(
			`Account [${index}] ${account.email || "unknown"} rate-limited: ${reason}, backoff ${Math.round(backoffMs / 1000)}s, consecutive: ${account.consecutiveFailures}`,
		);
		this.scheduleSave();
	}

	/**
	 * Record a non-rate-limit failure (auth error, network error).
	 */
	recordFailure(index: number): void {
		const account = this.accounts[index];
		if (!account) return;

		account.consecutiveFailures++;
		this.healthTracker.recordFailure(index);

		// Disable account after too many failures
		if (account.consecutiveFailures >= 5) {
			account.enabled = false;
			logWarn(
				`Account [${index}] ${account.email || "unknown"} disabled after ${account.consecutiveFailures} consecutive failures`,
			);
		}

		this.scheduleSave();
	}

	/**
	 * Check if an account is currently rate-limited.
	 */
	private isRateLimited(account: ManagedAccount): boolean {
		if (!account.rateLimitResetTime) return false;
		if (Date.now() >= account.rateLimitResetTime) {
			// Rate limit expired, clear it
			account.rateLimitResetTime = undefined;
			account.rateLimitReason = undefined;
			return false;
		}
		return true;
	}

	/**
	 * Calculate backoff time based on reason and failure count.
	 */
	private calculateBackoff(reason: RateLimitReason, failures: number): number {
		switch (reason) {
			case "USAGE_LIMIT_REACHED": {
				const idx = Math.min(failures, BACKOFF.QUOTA_EXHAUSTED_MS.length - 1);
				return BACKOFF.QUOTA_EXHAUSTED_MS[idx] ?? BACKOFF.UNKNOWN_MS;
			}
			case "RATE_LIMIT_EXCEEDED":
				return BACKOFF.RATE_LIMIT_MS;
			case "SERVER_ERROR":
				return BACKOFF.SERVER_ERROR_MS;
			case "UNKNOWN":
			default:
				return BACKOFF.UNKNOWN_MS;
		}
	}

	/**
	 * Debounced save to disk (1 second delay).
	 */
	private scheduleSave(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			this.saveToDisk().catch((err) => {
				logWarn("Failed to save accounts", String(err));
			});
		}, 1000);
	}

	/**
	 * Persist current state to disk.
	 */
	async saveToDisk(): Promise<void> {
		const storedAccounts: StoredAccount[] = this.accounts.map((a) => ({
			email: a.email,
			refreshToken: a.refreshToken,
			accessToken: a.accessToken,
			accessTokenExpires: a.accessTokenExpires,
			accountId: a.accountId,
			addedAt: a.addedAt,
			lastUsed: a.lastUsed,
			enabled: a.enabled,
			rateLimitResetTime: a.rateLimitResetTime,
			rateLimitReason: a.rateLimitReason,
			consecutiveFailures: a.consecutiveFailures,
		}));

		await saveAccounts({
			version: 1,
			accounts: storedAccounts,
			activeIndex: this.activeIndex ?? 0,
		});
	}

	/**
	 * Get the currently active account (without selection logic).
	 */
	getActiveAccount(): ManagedAccount | null {
		if (this.activeIndex === null || this.accounts.length === 0) return null;
		return this.accounts[this.activeIndex] ?? null;
	}

	/**
	 * Get all enabled accounts.
	 */
	getEnabledAccounts(): ManagedAccount[] {
		return this.accounts.filter((a) => a.enabled);
	}
}
