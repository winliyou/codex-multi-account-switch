/**
 * Request transformation for Codex API.
 *
 * Normalizes model names, configures reasoning, filters input,
 * and injects Codex system instructions.
 */

import { logDebug, logWarn } from "../logger.js";
import { TOOL_REMAP_MESSAGE } from "../prompts/codex.js";
import { CODEX_OPENCODE_BRIDGE } from "../prompts/bridge.js";
import { getOpenCodeCodexPrompt } from "../prompts/opencode-codex.js";
import { getNormalizedModel } from "./helpers/model-map.js";
import {
	filterOpenCodeSystemPromptsWithCachedPrompt,
	normalizeOrphanedToolOutputs,
} from "./helpers/input-utils.js";
import type {
	ConfigOptions,
	InputItem,
	ReasoningConfig,
	RequestBody,
	UserConfig,
} from "../types.js";

export {
	isOpenCodeSystemPrompt,
	filterOpenCodeSystemPromptsWithCachedPrompt,
} from "./helpers/input-utils.js";

/**
 * Normalize model name to Codex-supported variants.
 */
export function normalizeModel(model: string | undefined): string {
	if (!model) return "gpt-5.1";

	const modelId = model.includes("/") ? model.split("/").pop()! : model;
	const mapped = getNormalizedModel(modelId);
	if (mapped) return mapped;

	const n = modelId.toLowerCase();

	if (n.includes("gpt-5.2-codex") || n.includes("gpt 5.2 codex")) return "gpt-5.2-codex";
	if (n.includes("gpt-5.2") || n.includes("gpt 5.2")) return "gpt-5.2";
	if (n.includes("gpt-5.1-codex-max") || n.includes("gpt 5.1 codex max")) return "gpt-5.1-codex-max";
	if (n.includes("gpt-5.1-codex-mini") || n.includes("gpt 5.1 codex mini")) return "gpt-5.1-codex-mini";
	if (n.includes("codex-mini-latest") || n.includes("gpt-5-codex-mini") || n.includes("gpt 5 codex mini")) return "codex-mini-latest";
	if (n.includes("gpt-5.1-codex") || n.includes("gpt 5.1 codex")) return "gpt-5.1-codex";
	if (n.includes("gpt-5.1") || n.includes("gpt 5.1")) return "gpt-5.1";
	if (n.includes("codex")) return "gpt-5.1-codex";
	if (n.includes("gpt-5") || n.includes("gpt 5")) return "gpt-5.1";

	return "gpt-5.1";
}

export function getModelConfig(
	modelName: string,
	userConfig: UserConfig = { global: {}, models: {} },
): ConfigOptions {
	const globalOptions = userConfig.global || {};
	const modelOptions = userConfig.models?.[modelName]?.options || {};
	return { ...globalOptions, ...modelOptions };
}

function resolveReasoningConfig(
	modelName: string,
	modelConfig: ConfigOptions,
	body: RequestBody,
): ReasoningConfig {
	const providerOpts = body.providerOptions?.openai;
	const existingEffort =
		body.reasoning?.effort ?? (providerOpts as ConfigOptions | undefined)?.reasoningEffort;
	const existingSummary =
		body.reasoning?.summary ?? (providerOpts as ConfigOptions | undefined)?.reasoningSummary;

	const merged: ConfigOptions = {
		...modelConfig,
		...(existingEffort ? { reasoningEffort: existingEffort } : {}),
		...(existingSummary ? { reasoningSummary: existingSummary } : {}),
	};

	return getReasoningConfig(modelName, merged);
}

function resolveTextVerbosity(
	modelConfig: ConfigOptions,
	body: RequestBody,
): "low" | "medium" | "high" {
	const providerOpts = body.providerOptions?.openai;
	return (
		body.text?.verbosity ??
		(providerOpts as ConfigOptions | undefined)?.textVerbosity ??
		modelConfig.textVerbosity ??
		"medium"
	);
}

function resolveInclude(modelConfig: ConfigOptions, body: RequestBody): string[] {
	const providerOpts = body.providerOptions?.openai;
	const base =
		body.include ??
		(providerOpts as { include?: string[] } | undefined)?.include ??
		modelConfig.include ??
		["reasoning.encrypted_content"];
	const include = Array.from(new Set(base.filter(Boolean)));
	if (!include.includes("reasoning.encrypted_content")) {
		include.push("reasoning.encrypted_content");
	}
	return include;
}

export function getReasoningConfig(
	modelName: string | undefined,
	userConfig: ConfigOptions = {},
): ReasoningConfig {
	const n = modelName?.toLowerCase() ?? "";

	const isGpt52Codex = n.includes("gpt-5.2-codex") || n.includes("gpt 5.2 codex");
	const isGpt52General = (n.includes("gpt-5.2") || n.includes("gpt 5.2")) && !isGpt52Codex;
	const isCodexMax = n.includes("codex-max") || n.includes("codex max");
	const isCodexMini = n.includes("codex-mini") || n.includes("codex mini") || n.includes("codex_mini") || n.includes("codex-mini-latest");
	const isCodex = n.includes("codex") && !isCodexMini;
	const isLightweight = !isCodexMini && (n.includes("nano") || n.includes("mini"));
	const isGpt51General = (n.includes("gpt-5.1") || n.includes("gpt 5.1")) && !isCodex && !isCodexMax && !isCodexMini;

	const supportsXhigh = isGpt52General || isGpt52Codex || isCodexMax;
	const supportsNone = isGpt52General || isGpt51General;

	const defaultEffort: ReasoningConfig["effort"] = isCodexMini
		? "medium"
		: supportsXhigh
			? "high"
			: isLightweight
				? "minimal"
				: "medium";

	let effort = userConfig.reasoningEffort || defaultEffort;

	if (isCodexMini) {
		if (effort === "minimal" || effort === "low" || effort === "none") effort = "medium";
		if (effort === "xhigh") effort = "high";
		if (effort !== "high" && effort !== "medium") effort = "medium";
	}
	if (!supportsXhigh && effort === "xhigh") effort = "high";
	if (!supportsNone && effort === "none") effort = "low";
	if (effort === "minimal") effort = "low";

	return {
		effort,
		summary: userConfig.reasoningSummary || "auto",
	};
}

export function filterInput(input: InputItem[] | undefined): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input
		.filter((item) => {
			if (item.type === "item_reference") return false;
			return true;
		})
		.map((item) => {
			if (item.id) {
				const { id, ...rest } = item;
				return rest as InputItem;
			}
			return item;
		});
}

export async function filterOpenCodeSystemPrompts(
	input: InputItem[] | undefined,
): Promise<InputItem[] | undefined> {
	if (!Array.isArray(input)) return input;

	let cachedPrompt: string | null = null;
	try {
		cachedPrompt = await getOpenCodeCodexPrompt();
	} catch {}

	return filterOpenCodeSystemPromptsWithCachedPrompt(input, cachedPrompt);
}

export function addCodexBridgeMessage(
	input: InputItem[] | undefined,
	hasTools: boolean,
): InputItem[] | undefined {
	if (!hasTools || !Array.isArray(input)) return input;

	const bridgeMessage: InputItem = {
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text: CODEX_OPENCODE_BRIDGE }],
	};
	return [bridgeMessage, ...input];
}

export function addToolRemapMessage(
	input: InputItem[] | undefined,
	hasTools: boolean,
): InputItem[] | undefined {
	if (!hasTools || !Array.isArray(input)) return input;

	const toolRemapMessage: InputItem = {
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text: TOOL_REMAP_MESSAGE }],
	};
	return [toolRemapMessage, ...input];
}

/**
 * Transform request body for Codex API.
 */
export async function transformRequestBody(
	body: RequestBody,
	codexInstructions: string,
	userConfig: UserConfig = { global: {}, models: {} },
	codexMode = true,
): Promise<RequestBody> {
	const originalModel = body.model;
	const normalizedModel = normalizeModel(body.model);
	const lookupModel = originalModel || normalizedModel;
	const modelConfig = getModelConfig(lookupModel, userConfig);

	logDebug(`Model: "${lookupModel}" → "${normalizedModel}"`, {
		hasModelSpecificConfig: !!userConfig.models?.[lookupModel],
		resolvedConfig: modelConfig,
	});

	body.model = normalizedModel;
	body.store = false;
	body.stream = true;
	body.instructions = codexInstructions;

	if (body.input && Array.isArray(body.input)) {
		body.input = filterInput(body.input);

		if (codexMode) {
			body.input = await filterOpenCodeSystemPrompts(body.input);
			body.input = addCodexBridgeMessage(body.input, !!body.tools);
		} else {
			body.input = addToolRemapMessage(body.input, !!body.tools);
		}

		if (body.input) {
			body.input = normalizeOrphanedToolOutputs(body.input);
		}
	}

	const reasoningConfig = resolveReasoningConfig(normalizedModel, modelConfig, body);
	body.reasoning = { ...body.reasoning, ...reasoningConfig };

	body.text = {
		...body.text,
		verbosity: resolveTextVerbosity(modelConfig, body),
	};

	body.include = resolveInclude(modelConfig, body);

	body.max_output_tokens = undefined;
	body.max_completion_tokens = undefined;

	return body;
}
