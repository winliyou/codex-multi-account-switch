/**
 * Account Rotation System
 *
 * Implements account selection algorithms:
 * - Health Score: Track account wellness based on success/failure
 * - Token Bucket: Client-side rate limiting
 * - Hybrid Selection: Combines health, tokens, and LRU freshness
 */

// ============================================================================
// HEALTH SCORE SYSTEM
// ============================================================================

export interface HealthScoreConfig {
	initial: number;
	successReward: number;
	rateLimitPenalty: number;
	failurePenalty: number;
	recoveryRatePerHour: number;
	minUsable: number;
	maxScore: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthScoreConfig = {
	initial: 70,
	successReward: 1,
	rateLimitPenalty: -10,
	failurePenalty: -20,
	recoveryRatePerHour: 2,
	minUsable: 50,
	maxScore: 100,
};

interface HealthState {
	score: number;
	lastUpdated: number;
	consecutiveFailures: number;
}

export class HealthScoreTracker {
	private readonly scores = new Map<number, HealthState>();
	private readonly config: HealthScoreConfig;

	constructor(config: Partial<HealthScoreConfig> = {}) {
		this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
	}

	getScore(index: number): number {
		const state = this.scores.get(index);
		if (!state) return this.config.initial;

		const hoursSince = (Date.now() - state.lastUpdated) / (1000 * 60 * 60);
		const recovered = Math.floor(hoursSince * this.config.recoveryRatePerHour);
		return Math.min(this.config.maxScore, state.score + recovered);
	}

	recordSuccess(index: number): void {
		const current = this.getScore(index);
		this.scores.set(index, {
			score: Math.min(this.config.maxScore, current + this.config.successReward),
			lastUpdated: Date.now(),
			consecutiveFailures: 0,
		});
	}

	recordRateLimit(index: number): void {
		const state = this.scores.get(index);
		const current = this.getScore(index);
		this.scores.set(index, {
			score: Math.max(0, current + this.config.rateLimitPenalty),
			lastUpdated: Date.now(),
			consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
		});
	}

	recordFailure(index: number): void {
		const state = this.scores.get(index);
		const current = this.getScore(index);
		this.scores.set(index, {
			score: Math.max(0, current + this.config.failurePenalty),
			lastUpdated: Date.now(),
			consecutiveFailures: (state?.consecutiveFailures ?? 0) + 1,
		});
	}

	isUsable(index: number): boolean {
		return this.getScore(index) >= this.config.minUsable;
	}

	getConsecutiveFailures(index: number): number {
		return this.scores.get(index)?.consecutiveFailures ?? 0;
	}

	reset(index: number): void {
		this.scores.delete(index);
	}
}

// ============================================================================
// TOKEN BUCKET SYSTEM
// ============================================================================

export interface TokenBucketConfig {
	maxTokens: number;
	regenerationRatePerMinute: number;
	initialTokens: number;
}

export const DEFAULT_TOKEN_BUCKET_CONFIG: TokenBucketConfig = {
	maxTokens: 50,
	regenerationRatePerMinute: 6,
	initialTokens: 50,
};

interface TokenBucketState {
	tokens: number;
	lastUpdated: number;
}

export class TokenBucketTracker {
	private readonly buckets = new Map<number, TokenBucketState>();
	private readonly config: TokenBucketConfig;

	constructor(config: Partial<TokenBucketConfig> = {}) {
		this.config = { ...DEFAULT_TOKEN_BUCKET_CONFIG, ...config };
	}

	getTokens(index: number): number {
		const state = this.buckets.get(index);
		if (!state) return this.config.initialTokens;

		const minutesSince = (Date.now() - state.lastUpdated) / (1000 * 60);
		const recovered = minutesSince * this.config.regenerationRatePerMinute;
		return Math.min(this.config.maxTokens, state.tokens + recovered);
	}

	hasTokens(index: number, cost = 1): boolean {
		return this.getTokens(index) >= cost;
	}

	consume(index: number, cost = 1): boolean {
		const current = this.getTokens(index);
		if (current < cost) return false;
		this.buckets.set(index, { tokens: current - cost, lastUpdated: Date.now() });
		return true;
	}

	refund(index: number, amount = 1): void {
		const current = this.getTokens(index);
		this.buckets.set(index, {
			tokens: Math.min(this.config.maxTokens, current + amount),
			lastUpdated: Date.now(),
		});
	}

	getMaxTokens(): number {
		return this.config.maxTokens;
	}
}

// ============================================================================
// HYBRID SELECTION
// ============================================================================

export interface AccountMetrics {
	index: number;
	lastUsed: number;
	healthScore: number;
	isRateLimited: boolean;
	enabled: boolean;
}

const STICKINESS_BONUS = 150;
const SWITCH_THRESHOLD = 100;

/**
 * Select the best account using hybrid strategy:
 * 1. Filter available accounts (not rate-limited, enabled, healthy, has tokens)
 * 2. Score: health (2x) + tokens (5x) + freshness (0.1x)
 * 3. Apply stickiness bonus to current account
 * 4. Only switch if another account beats current by SWITCH_THRESHOLD
 */
export function selectHybridAccount(
	accounts: AccountMetrics[],
	tokenTracker: TokenBucketTracker,
	currentIndex: number | null = null,
	minHealthScore = 50,
): number | null {
	const candidates = accounts
		.filter(
			(acc) =>
				!acc.isRateLimited &&
				acc.enabled &&
				acc.healthScore >= minHealthScore &&
				tokenTracker.hasTokens(acc.index),
		)
		.map((acc) => ({
			...acc,
			tokens: tokenTracker.getTokens(acc.index),
		}));

	if (candidates.length === 0) return null;

	const maxTokens = tokenTracker.getMaxTokens();
	const scored = candidates
		.map((acc) => {
			const healthComponent = acc.healthScore * 2;
			const tokenComponent = (acc.tokens / maxTokens) * 100 * 5;
			const secondsSinceUsed = (Date.now() - acc.lastUsed) / 1000;
			const freshnessComponent = Math.min(secondsSinceUsed, 3600) * 0.1;
			const baseScore = Math.max(
				0,
				healthComponent + tokenComponent + freshnessComponent,
			);
			const stickinessBonus =
				acc.index === currentIndex ? STICKINESS_BONUS : 0;
			return {
				index: acc.index,
				baseScore,
				score: baseScore + stickinessBonus,
				isCurrent: acc.index === currentIndex,
			};
		})
		.sort((a, b) => b.score - a.score);

	const best = scored[0];
	if (!best) return null;

	// Check if switch is warranted
	const currentCandidate = scored.find((s) => s.isCurrent);
	if (currentCandidate && !best.isCurrent) {
		const advantage = best.baseScore - currentCandidate.baseScore;
		if (advantage < SWITCH_THRESHOLD) {
			return currentCandidate.index;
		}
	}

	return best.index;
}

/**
 * Simple round-robin selection: pick the next non-rate-limited account.
 */
export function selectRoundRobin(
	accounts: AccountMetrics[],
	currentIndex: number | null,
): number | null {
	const available = accounts.filter((a) => !a.isRateLimited && a.enabled);
	if (available.length === 0) return null;

	if (currentIndex === null) return available[0]!.index;

	// Find next after current
	const currentPos = available.findIndex((a) => a.index === currentIndex);
	const nextPos = (currentPos + 1) % available.length;
	return available[nextPos]!.index;
}

/**
 * Sticky selection: keep current until rate-limited, then switch.
 */
export function selectSticky(
	accounts: AccountMetrics[],
	currentIndex: number | null,
): number | null {
	const available = accounts.filter((a) => !a.isRateLimited && a.enabled);
	if (available.length === 0) return null;

	// If current is still usable, keep it
	if (currentIndex !== null) {
		const current = available.find((a) => a.index === currentIndex);
		if (current) return current.index;
	}

	// Otherwise pick first available
	return available[0]!.index;
}
