/**
 * OpenCode Codex Auto-Switch Plugin
 *
 * Combines multi-account management with ChatGPT Codex backend authentication.
 * Supports automatic account rotation on rate limits with health scoring.
 *
 * Provider ID: "openai" (replaces opencode-openai-codex-auth when active)
 *
 * @license MIT
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Auth } from "@opencode-ai/sdk";
import {
	createAuthorizationFlow,
	decodeJWT,
	exchangeAuthorizationCode,
	parseAuthorizationInput,
	REDIRECT_URI,
} from "./lib/auth/auth.js";
import { openBrowserUrl } from "./lib/auth/browser.js";
import { startLocalOAuthServer } from "./lib/auth/server.js";
import { loadPluginConfig, getCodexMode } from "./lib/config.js";
import {
	AUTH_LABELS,
	CODEX_BASE_URL,
	DUMMY_API_KEY,
	ERROR_MESSAGES,
	HTTP_STATUS,
	JWT_CLAIM_PATH,
	LOG_STAGES,
	PLUGIN_NAME,
	PROVIDER_ID,
} from "./lib/constants.js";
import { logRequest, logDebug } from "./lib/logger.js";
import { AccountManager } from "./lib/accounts/manager.js";
import {
	createCodexHeaders,
	extractRequestUrl,
	handleErrorResponse,
	handleSuccessResponse,
	rewriteUrlForCodex,
	transformRequestForCodex,
	classifyRateLimitReason,
} from "./lib/request/fetch-helpers.js";
import type { UserConfig, TokenSuccess } from "./lib/types.js";

/** Maximum retries on rate limit before giving up */
const MAX_RETRIES = 3;

/**
 * OpenCode Codex Auto-Switch Plugin
 *
 * Features:
 * - Multiple ChatGPT Plus/Pro accounts in a rotation pool
 * - Automatic failover on rate limits (429, usage_limit_reached)
 * - Health scoring, token bucket, and hybrid selection strategies
 * - Same Codex API transformation as opencode-openai-codex-auth
 *
 * @example
 * ```json
 * {
 *   "plugin": ["file:///path/to/opencode-codex-auto-switch/dist/index.js"],
 *   "provider": {
 *     "openai": {
 *       "models": {
 *         "gpt-5.1-codex": {}
 *       }
 *     }
 *   }
 * }
 * ```
 */
export const CodexAutoSwitchPlugin: Plugin = async ({
	client,
}: PluginInput) => {
	// Initialize account manager
	const pluginConfig = loadPluginConfig();
	const accountManager = new AccountManager(pluginConfig.strategy);

	const buildManualOAuthFlow = (pkce: { verifier: string }, url: string) => ({
		url,
		method: "code" as const,
		instructions: AUTH_LABELS.INSTRUCTIONS_MANUAL,
		callback: async (input: string) => {
			const parsed = parseAuthorizationInput(input);
			if (!parsed.code) {
				return { type: "failed" as const };
			}
			const tokens = await exchangeAuthorizationCode(
				parsed.code,
				pkce.verifier,
				REDIRECT_URI,
			);
			if (tokens?.type === "success") {
				// Add to rotation pool
				await accountManager.addAccount(tokens);
				return tokens;
			}
			return { type: "failed" as const };
		},
	});

	return {
		auth: {
			provider: PROVIDER_ID,

			/**
			 * Loader: configures multi-account fetch for Codex API.
			 */
			async loader(getAuth: () => Promise<Auth>, provider: unknown) {
				// Load accounts from disk
				await accountManager.load();

				// Bootstrap: if no accounts in storage, try to import from opencode's auth
				const auth = await getAuth();
				if (accountManager.count === 0 && auth.type === "oauth") {
					logDebug("No accounts in storage, importing from opencode auth");
					const tokens: TokenSuccess = {
						type: "success",
						access: auth.access,
						refresh: auth.refresh,
						expires: auth.expires,
					};
					await accountManager.addAccount(tokens);
				}

				if (accountManager.count === 0) {
					logDebug("No accounts available, skipping plugin");
					return {};
				}

				logDebug(
					`Loaded ${accountManager.count} account(s), strategy: ${pluginConfig.strategy}\n` +
					accountManager.getSummary(),
				);

				// Track which account was last synced to opencode to avoid redundant updates
				let lastSyncedAccountIndex: number | null = null;

				/**
				 * Sync the active account's tokens to opencode's auth store.
				 * This lets opencode's status view display the current provider auth.
				 */
				async function syncActiveAccountToOpencode(
					account: { index: number; email?: string; accountId?: string; refreshToken: string; accessToken?: string; accessTokenExpires?: number },
				): Promise<void> {
					if (account.index === lastSyncedAccountIndex) return;
					if (!account.accessToken || !account.accessTokenExpires) return;
					try {
						// Include accountId (v2 SDK field) so opencode can display the active account
						const authBody = {
							type: "oauth" as const,
							refresh: account.refreshToken,
							access: account.accessToken,
							expires: account.accessTokenExpires,
							// v2 OAuth supports accountId — use email for human readability
							accountId: account.email || account.accountId || undefined,
						};
						await client.auth.set({
							path: { id: PROVIDER_ID },
							body: authBody as Parameters<typeof client.auth.set>[0]["body"],
						});
						lastSyncedAccountIndex = account.index;
					} catch {
						// Non-critical: don't break the request flow
					}
				}

				/**
				 * Show a toast notification in the opencode TUI.
				 * Non-blocking; failures are silently ignored.
				 */
				function showToast(
					message: string,
					variant: "info" | "success" | "warning" | "error" = "info",
					duration = 3000,
				): void {
					client.tui.showToast({
						body: { message, variant, duration },
					}).catch(() => {});
				}

				/**
				 * Write a structured log entry to opencode's log system.
				 * Non-blocking; failures are silently ignored.
				 */
				function appLog(
					level: "debug" | "info" | "warn" | "error",
					message: string,
				): void {
					client.app.log({
						body: { service: PLUGIN_NAME, level, message },
					}).catch(() => {});
				}

				// Notify user about loaded accounts
				showToast(
					`Codex auto-switch: ${accountManager.count} account(s) loaded`,
					"success",
					3000,
				);
				appLog("info", `Loaded ${accountManager.count} account(s), strategy: ${pluginConfig.strategy}`);

				// Extract user configuration
				const providerConfig = provider as
					| { options?: Record<string, unknown>; models?: UserConfig["models"] }
					| undefined;
				const userConfig: UserConfig = {
					global: (providerConfig?.options || {}) as UserConfig["global"],
					models: providerConfig?.models || {},
				};

				const codexMode = getCodexMode(pluginConfig);

				return {
					apiKey: DUMMY_API_KEY,
					baseURL: CODEX_BASE_URL,

					/**
					 * Custom fetch: selects best account, refreshes tokens,
					 * transforms request, retries on rate limit with account rotation.
					 */
					async fetch(
						input: Request | string | URL,
						init?: RequestInit,
					): Promise<Response> {
						// Step 1: Select best account
						let account = accountManager.selectAccount();
						if (!account) {
							throw new Error(
								`[${PLUGIN_NAME}] ${ERROR_MESSAGES.NO_ACCOUNTS}`,
							);
						}

						// Step 2: Transform request (only once, reuse across retries)
						const originalUrl = extractRequestUrl(input);
						const url = rewriteUrlForCodex(originalUrl);

						const originalBody = init?.body
							? JSON.parse(init.body as string)
							: {};
						const isStreaming = originalBody.stream === true;

						const transformation = await transformRequestForCodex(
							init,
							url,
							userConfig,
							codexMode,
						);
						const requestInit = transformation?.updatedInit ?? init;

						// Step 3: Try request with account rotation on failure
						for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
							// Ensure fresh access token
							const refreshed =
								await accountManager.ensureAccessToken(account);
							if (!refreshed) {
								// Token refresh failed, try next account
								appLog("warn", `Token refresh failed for ${accountManager.getAccountLabel(account)}, switching account`);
								showToast(`Token refresh failed for ${account.email || `account #${account.index}`}, switching...`, "warning");
								account = accountManager.selectAccount()!;
								if (!account) {
									throw new Error(
										`[${PLUGIN_NAME}] ${ERROR_MESSAGES.NO_ACCOUNTS}`,
									);
								}
								continue;
							}
							account = refreshed;

							// Sync active account to opencode so the UI reflects the current account
							await syncActiveAccountToOpencode(account);

							// Create headers with this account's credentials
							const headers = createCodexHeaders(
								requestInit,
								account.accountId || "",
								account.accessToken || "",
								{
									model: transformation?.body.model,
									promptCacheKey: (transformation?.body as Record<string, unknown>)
										?.prompt_cache_key as string | undefined,
								},
							);

							// Make request
							const response = await fetch(url, {
								...requestInit,
								headers,
							});

							logRequest(LOG_STAGES.RESPONSE, {
								status: response.status,
								ok: response.ok,
								account: account.index,
								email: account.email,
								attempt,
							});

							// Success
							if (response.ok) {
								accountManager.recordSuccess(account.index);
								return await handleSuccessResponse(
									response,
									isStreaming,
								);
							}

							// Rate limit or usage limit
							if (
								response.status === HTTP_STATUS.TOO_MANY_REQUESTS ||
								response.status === HTTP_STATUS.NOT_FOUND ||
								response.status === HTTP_STATUS.SERVICE_UNAVAILABLE ||
								response.status === 529
							) {
								// Read body to classify the error
								const clone = response.clone();
								let bodyText = "";
								try {
									bodyText = await clone.text();
								} catch {}

								const reason = classifyRateLimitReason(
									response.status,
									bodyText,
								);

								// Special handling: 404 that's NOT a usage limit → return as-is
								if (
									response.status === HTTP_STATUS.NOT_FOUND &&
									reason === "UNKNOWN"
								) {
									return response;
								}

								appLog("warn", `Rate limit on [${account.index}] ${account.email || "unknown"}: ${reason} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);

								// Mark account and try next
								accountManager.markRateLimited(
									account.index,
									reason,
								);

								if (attempt < MAX_RETRIES) {
									const nextAccount =
										accountManager.selectAccount();
									if (nextAccount) {
										const fromLabel = account.email || `account #${account.index}`;
										const toLabel = nextAccount.email || `account #${nextAccount.index}`;
										showToast(`Rate limited → switching ${fromLabel} → ${toLabel}`, "warning");
										appLog("info", `Account switched: [${account.index}] → [${nextAccount.index}] ${nextAccount.email || "unknown"}`);
										account = nextAccount;
										// Force re-sync to opencode on next iteration
										lastSyncedAccountIndex = null;
										continue;
									}
								}

								// No more accounts or retries → return the error response
								return await handleErrorResponse(response);
							}

							// Auth error → disable account and try next
							if (response.status === HTTP_STATUS.UNAUTHORIZED) {
								appLog("warn", `Auth error on [${account.index}] ${account.email || "unknown"}`);
								accountManager.recordFailure(account.index);

								if (attempt < MAX_RETRIES) {
									const nextAccount =
										accountManager.selectAccount();
									if (nextAccount) {
										showToast(`Auth error → switching to ${nextAccount.email || `account #${nextAccount.index}`}`, "warning");
										appLog("info", `Account switched: [${account.index}] → [${nextAccount.index}] ${nextAccount.email || "unknown"}`);
										account = nextAccount;
										lastSyncedAccountIndex = null;
										continue;
									}
								}
								return await handleErrorResponse(response);
							}

							// Other error → return as-is
							return await handleErrorResponse(response);
						}

						// Should not reach here, but just in case
						throw new Error(
							`[${PLUGIN_NAME}] Exhausted all retry attempts`,
						);
					},
				};
			},

			methods: [
				{
					label: AUTH_LABELS.OAUTH,
					type: "oauth" as const,
					/**
					 * OAuth flow: adds account to rotation pool.
					 */
					authorize: async () => {
						const { pkce, state, url } =
							await createAuthorizationFlow();
						const serverInfo = await startLocalOAuthServer({
							state,
						});

						openBrowserUrl(url);

						if (!serverInfo.ready) {
							serverInfo.close();
							return buildManualOAuthFlow(pkce, url);
						}

						return {
							url,
							method: "auto" as const,
							instructions: AUTH_LABELS.INSTRUCTIONS,
							callback: async () => {
								const result =
									await serverInfo.waitForCode(state);
								serverInfo.close();

								if (!result) {
									return { type: "failed" as const };
								}

								const tokens =
									await exchangeAuthorizationCode(
										result.code,
										pkce.verifier,
										REDIRECT_URI,
									);

								if (tokens?.type === "success") {
									// Add to rotation pool
									await accountManager.addAccount(tokens);
									return tokens;
								}
								return { type: "failed" as const };
							},
						};
					},
				},
				{
					label: AUTH_LABELS.OAUTH_MANUAL,
					type: "oauth" as const,
					authorize: async () => {
						const { pkce, url } = await createAuthorizationFlow();
						return buildManualOAuthFlow(pkce, url);
					},
				},
				{
					label: AUTH_LABELS.API_KEY,
					type: "api" as const,
				},
			],
		},
	};
};

export default CodexAutoSwitchPlugin;
