/**
 * Model Configuration Map
 *
 * Maps model config IDs to their normalized API model names.
 */

export const MODEL_MAP: Record<string, string> = {
	// GPT-5.1 Codex
	"gpt-5.1-codex": "gpt-5.1-codex",
	"gpt-5.1-codex-low": "gpt-5.1-codex",
	"gpt-5.1-codex-medium": "gpt-5.1-codex",
	"gpt-5.1-codex-high": "gpt-5.1-codex",

	// GPT-5.1 Codex Max
	"gpt-5.1-codex-max": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-low": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-medium": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-high": "gpt-5.1-codex-max",
	"gpt-5.1-codex-max-xhigh": "gpt-5.1-codex-max",

	// GPT-5.2
	"gpt-5.2": "gpt-5.2",
	"gpt-5.2-none": "gpt-5.2",
	"gpt-5.2-low": "gpt-5.2",
	"gpt-5.2-medium": "gpt-5.2",
	"gpt-5.2-high": "gpt-5.2",
	"gpt-5.2-xhigh": "gpt-5.2",

	// GPT-5.2 Codex
	"gpt-5.2-codex": "gpt-5.2-codex",
	"gpt-5.2-codex-low": "gpt-5.2-codex",
	"gpt-5.2-codex-medium": "gpt-5.2-codex",
	"gpt-5.2-codex-high": "gpt-5.2-codex",
	"gpt-5.2-codex-xhigh": "gpt-5.2-codex",

	// GPT-5.1 Codex Mini
	"gpt-5.1-codex-mini": "gpt-5.1-codex-mini",
	"gpt-5.1-codex-mini-medium": "gpt-5.1-codex-mini",
	"gpt-5.1-codex-mini-high": "gpt-5.1-codex-mini",

	// GPT-5.1 General Purpose
	"gpt-5.1": "gpt-5.1",
	"gpt-5.1-none": "gpt-5.1",
	"gpt-5.1-low": "gpt-5.1",
	"gpt-5.1-medium": "gpt-5.1",
	"gpt-5.1-high": "gpt-5.1",
	"gpt-5.1-chat-latest": "gpt-5.1",

	// Legacy
	"gpt-5-codex": "gpt-5.1-codex",
	"codex-mini-latest": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini-medium": "gpt-5.1-codex-mini",
	"gpt-5-codex-mini-high": "gpt-5.1-codex-mini",
	"gpt-5": "gpt-5.1",
	"gpt-5-mini": "gpt-5.1",
	"gpt-5-nano": "gpt-5.1",
};

export function getNormalizedModel(modelId: string): string | undefined {
	if (MODEL_MAP[modelId]) return MODEL_MAP[modelId];
	const lower = modelId.toLowerCase();
	const match = Object.keys(MODEL_MAP).find((k) => k.toLowerCase() === lower);
	return match ? MODEL_MAP[match] : undefined;
}

export function isKnownModel(modelId: string): boolean {
	return getNormalizedModel(modelId) !== undefined;
}
