/**
 * Constants for the codex-auto-switch plugin
 *
 * Uses provider ID "openai" (same as opencode-openai-codex-auth) so it
 * appears in the standard auth login list. Distinction is via auth method
 * labels ("Auto-Switch Multi-Account").
 *
 * Only ONE of opencode-openai-codex-auth / opencode-codex-auto-switch
 * should be active at a time — the last-loaded plugin wins.
 */

/** Plugin identifier for logging */
export const PLUGIN_NAME = "codex-auto-switch";

/** Provider ID - uses "openai" so it appears in the standard auth login list */
export const PROVIDER_ID = "openai";

/** Base URL for ChatGPT backend API */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** Dummy API key (actual auth via OAuth, distinct from opencode-openai-codex-auth's "chatgpt-oauth") */
export const DUMMY_API_KEY = "codex-auto-switch-oauth";

/** HTTP Status Codes */
export const HTTP_STATUS = {
	OK: 200,
	UNAUTHORIZED: 401,
	NOT_FOUND: 404,
	TOO_MANY_REQUESTS: 429,
	SERVICE_UNAVAILABLE: 503,
} as const;

/** OpenAI-specific headers */
export const OPENAI_HEADERS = {
	BETA: "OpenAI-Beta",
	ACCOUNT_ID: "chatgpt-account-id",
	ORIGINATOR: "originator",
	SESSION_ID: "session_id",
	CONVERSATION_ID: "conversation_id",
} as const;

/** OpenAI-specific header values */
export const OPENAI_HEADER_VALUES = {
	BETA_RESPONSES: "responses=experimental",
	ORIGINATOR_CODEX: "codex_cli_rs",
} as const;

/** URL path segments */
export const URL_PATHS = {
	RESPONSES: "/responses",
	CODEX_RESPONSES: "/codex/responses",
} as const;

/** JWT claim path for ChatGPT account ID */
export const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;

/** Error messages */
export const ERROR_MESSAGES = {
	NO_ACCOUNT_ID: "Failed to extract accountId from token",
	TOKEN_REFRESH_FAILED: "Token refresh failed",
	NO_ACCOUNTS: "No accounts available",
	ALL_RATE_LIMITED: "All accounts are rate-limited",
	REQUEST_PARSE_ERROR: "Error parsing request",
} as const;

/** Log stages */
export const LOG_STAGES = {
	BEFORE_TRANSFORM: "before-transform",
	AFTER_TRANSFORM: "after-transform",
	RESPONSE: "response",
	ERROR_RESPONSE: "error-response",
	ACCOUNT_SWITCH: "account-switch",
	RATE_LIMIT: "rate-limit",
} as const;

/** Platform-specific browser opener commands */
export const PLATFORM_OPENERS = {
	darwin: "open",
	win32: "start",
	linux: "xdg-open",
} as const;

/** OAuth authorization labels */
export const AUTH_LABELS = {
	OAUTH: "ChatGPT Plus/Pro (Auto-Switch Multi-Account)",
	OAUTH_MANUAL: "ChatGPT Plus/Pro (Manual URL Paste - Multi-Account)",
	API_KEY: "Manually enter API Key",
	INSTRUCTIONS:
		"A browser window should open. If it doesn't, copy the URL and open it manually. Each login adds a new account to the rotation pool.",
	INSTRUCTIONS_MANUAL:
		"After logging in, copy the full redirect URL and paste it here. Each login adds a new account to the rotation pool.",
} as const;

/** Account storage file name (unique, not conflicting with antigravity-accounts.json) */
export const STORAGE_FILENAME = "codex-switch-accounts.json";

/** Plugin config file name */
export const CONFIG_FILENAME = "codex-switch-config.json";

/** Default backoff times */
export const BACKOFF = {
	/** Rate limit (429): 30 seconds */
	RATE_LIMIT_MS: 30_000,
	/** Usage limit exhausted: escalating backoffs */
	QUOTA_EXHAUSTED_MS: [60_000, 300_000, 1_800_000] as readonly number[],
	/** Server error (503): 20 seconds */
	SERVER_ERROR_MS: 20_000,
	/** Unknown: 60 seconds */
	UNKNOWN_MS: 60_000,
	/** Minimum backoff: 2 seconds */
	MIN_MS: 2_000,
} as const;
