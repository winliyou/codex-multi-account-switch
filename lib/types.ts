import type { Auth, Provider, Model } from "@opencode-ai/sdk";

// Re-export SDK types
export type { Auth, Provider, Model };

/** Plugin configuration */
export interface PluginConfig {
	/** Enable CODEX_MODE (Codex bridge prompt) @default true */
	codexMode?: boolean;
	/** Account selection strategy @default "hybrid" */
	strategy?: AccountSelectionStrategy;
	/** Whether to log debug info @default false */
	debug?: boolean;
}

/** Account selection strategy */
export type AccountSelectionStrategy = "sticky" | "round-robin" | "hybrid";

/** Rate limit reason classification */
export type RateLimitReason =
	| "RATE_LIMIT_EXCEEDED"
	| "USAGE_LIMIT_REACHED"
	| "SERVER_ERROR"
	| "UNKNOWN";

/** User configuration from opencode.json provider options */
export interface UserConfig {
	global: ConfigOptions;
	models: {
		[modelName: string]: {
			options?: ConfigOptions;
			variants?: Record<string, (ConfigOptions & { disabled?: boolean }) | undefined>;
			[key: string]: unknown;
		};
	};
}

/** Configuration options for reasoning and text settings */
export interface ConfigOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on";
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
}

/** Reasoning configuration for requests */
export interface ReasoningConfig {
	effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
	summary: "auto" | "concise" | "detailed" | "off" | "on";
}

/** OAuth server info */
export interface OAuthServerInfo {
	port: number;
	ready: boolean;
	close: () => void;
	waitForCode: (state: string) => Promise<{ code: string } | null>;
}

/** PKCE pair */
export interface PKCEPair {
	challenge: string;
	verifier: string;
}

/** Authorization flow result */
export interface AuthorizationFlow {
	pkce: PKCEPair;
	state: string;
	url: string;
}

/** Token exchange results */
export interface TokenSuccess {
	type: "success";
	access: string;
	refresh: string;
	expires: number;
}

export interface TokenFailure {
	type: "failed";
}

export type TokenResult = TokenSuccess | TokenFailure;

/** Parsed authorization input */
export interface ParsedAuthInput {
	code?: string;
	state?: string;
}

/** JWT payload with ChatGPT account info */
export interface JWTPayload {
	"https://api.openai.com/auth"?: {
		chatgpt_account_id?: string;
	};
	email?: string;
	[key: string]: unknown;
}

/** Message input item */
export interface InputItem {
	id?: string;
	type: string;
	role: string;
	content?: unknown;
	[key: string]: unknown;
}

/** Request body structure */
export interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	input?: InputItem[];
	tools?: unknown;
	reasoning?: Partial<ReasoningConfig>;
	text?: { verbosity?: "low" | "medium" | "high" };
	include?: string[];
	providerOptions?: {
		[key: string]: Partial<ConfigOptions> & { store?: boolean; include?: string[] } | undefined;
	};
	prompt_cache_key?: string;
	max_output_tokens?: number;
	max_completion_tokens?: number;
	[key: string]: unknown;
}

/** SSE event data */
export interface SSEEventData {
	type: string;
	response?: unknown;
	[key: string]: unknown;
}

/** Cache metadata for Codex instructions */
export interface CacheMetadata {
	etag: string | null;
	tag: string;
	lastChecked: number;
	url: string;
}

/** GitHub release data */
export interface GitHubRelease {
	tag_name: string;
	[key: string]: unknown;
}

// ==========================================
// Account management types
// ==========================================

/** Stored account metadata */
export interface StoredAccount {
	/** User email (from JWT) */
	email?: string;
	/** OAuth refresh token */
	refreshToken: string;
	/** Cached access token */
	accessToken?: string;
	/** Access token expiry (ms timestamp) */
	accessTokenExpires?: number;
	/** ChatGPT account ID (from JWT) */
	accountId?: string;
	/** Timestamp when account was added */
	addedAt: number;
	/** Timestamp of last successful use */
	lastUsed: number;
	/** Whether account is enabled */
	enabled: boolean;
	/** Rate limit reset time (ms timestamp), null if not limited */
	rateLimitResetTime?: number;
	/** Reason for rate limit */
	rateLimitReason?: RateLimitReason;
	/** Number of consecutive failures */
	consecutiveFailures: number;
}

/** Account storage format */
export interface AccountStorage {
	version: 1;
	accounts: StoredAccount[];
	activeIndex: number;
}

/** Runtime managed account (extends stored with runtime state) */
export interface ManagedAccount extends StoredAccount {
	/** Index in the accounts array */
	index: number;
}
