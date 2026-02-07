/**
 * Fetch helpers for the Codex API.
 *
 * URL rewriting, header creation, request transformation, response handling.
 */

import { logRequest, logDebug } from "../logger.js";
import { getCodexInstructions, getModelFamily } from "../prompts/codex.js";
import { transformRequestBody, normalizeModel } from "./request-transformer.js";
import { convertSseToJson, ensureContentType } from "./response-handler.js";
import type { UserConfig, RequestBody } from "../types.js";
import {
	PLUGIN_NAME,
	HTTP_STATUS,
	OPENAI_HEADERS,
	OPENAI_HEADER_VALUES,
	URL_PATHS,
	ERROR_MESSAGES,
	LOG_STAGES,
} from "../constants.js";

/**
 * Extract URL string from various input types.
 */
export function extractRequestUrl(input: Request | string | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

/**
 * Rewrite /responses → /codex/responses.
 */
export function rewriteUrlForCodex(url: string): string {
	return url.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
}

/**
 * Transform request body and fetch model-specific Codex instructions.
 */
export async function transformRequestForCodex(
	init: RequestInit | undefined,
	url: string,
	userConfig: UserConfig,
	codexMode = true,
): Promise<{ body: RequestBody; updatedInit: RequestInit } | undefined> {
	if (!init?.body) return undefined;

	try {
		const body = JSON.parse(init.body as string) as RequestBody;
		const originalModel = body.model;
		const normalizedModel = normalizeModel(originalModel);
		const modelFamily = getModelFamily(normalizedModel);

		logRequest(LOG_STAGES.BEFORE_TRANSFORM, {
			url,
			originalModel,
			model: body.model,
			hasTools: !!body.tools,
			hasInput: !!body.input,
			inputLength: body.input?.length,
			codexMode,
		});

		const codexInstructions = await getCodexInstructions(normalizedModel);
		const transformedBody = await transformRequestBody(
			body,
			codexInstructions,
			userConfig,
			codexMode,
		);

		logRequest(LOG_STAGES.AFTER_TRANSFORM, {
			url,
			originalModel,
			normalizedModel: transformedBody.model,
			modelFamily,
			hasTools: !!transformedBody.tools,
			reasoning: transformedBody.reasoning as unknown,
			textVerbosity: transformedBody.text?.verbosity,
			include: transformedBody.include,
		});

		return {
			body: transformedBody,
			updatedInit: { ...init, body: JSON.stringify(transformedBody) },
		};
	} catch (e) {
		console.error(`[${PLUGIN_NAME}] ${ERROR_MESSAGES.REQUEST_PARSE_ERROR}:`, e);
		return undefined;
	}
}

/**
 * Create headers for Codex API requests.
 */
export function createCodexHeaders(
	init: RequestInit | undefined,
	accountId: string,
	accessToken: string,
	opts?: { model?: string; promptCacheKey?: string },
): Headers {
	const headers = new Headers(init?.headers ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);

	const cacheKey = opts?.promptCacheKey;
	if (cacheKey) {
		headers.set(OPENAI_HEADERS.CONVERSATION_ID, cacheKey);
		headers.set(OPENAI_HEADERS.SESSION_ID, cacheKey);
	} else {
		headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
		headers.delete(OPENAI_HEADERS.SESSION_ID);
	}

	headers.set("accept", "text/event-stream");
	return headers;
}

/**
 * Handle error responses: detect usage limit 404 → remap to 429.
 */
export async function handleErrorResponse(
	response: Response,
): Promise<Response> {
	const mapped = await mapUsageLimit404(response);
	const final = mapped ?? response;

	logRequest(LOG_STAGES.ERROR_RESPONSE, {
		status: final.status,
		statusText: final.statusText,
	});

	return final;
}

/**
 * Handle successful responses.
 * Converts SSE to JSON for non-streaming requests.
 */
export async function handleSuccessResponse(
	response: Response,
	isStreaming: boolean,
): Promise<Response> {
	const responseHeaders = ensureContentType(response.headers);

	if (!isStreaming) {
		return await convertSseToJson(response, responseHeaders);
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders,
	});
}

async function mapUsageLimit404(response: Response): Promise<Response | null> {
	if (response.status !== HTTP_STATUS.NOT_FOUND) return null;

	const clone = response.clone();
	let text = "";
	try {
		text = await clone.text();
	} catch {
		return null;
	}
	if (!text) return null;

	let code = "";
	try {
		const parsed = JSON.parse(text) as { error?: { code?: string; type?: string } };
		code = (parsed?.error?.code ?? parsed?.error?.type ?? "").toString();
	} catch {}

	const haystack = `${code} ${text}`.toLowerCase();
	if (
		!/usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/i.test(
			haystack,
		)
	) {
		return null;
	}

	const headers = new Headers(response.headers);
	return new Response(response.body, {
		status: HTTP_STATUS.TOO_MANY_REQUESTS,
		statusText: "Too Many Requests",
		headers,
	});
}

/**
 * Classify rate limit reason from response body.
 */
export function classifyRateLimitReason(
	status: number,
	bodyText: string,
): import("../types.js").RateLimitReason {
	if (status === HTTP_STATUS.SERVICE_UNAVAILABLE || status === 529) {
		return "SERVER_ERROR";
	}

	const lower = bodyText.toLowerCase();

	if (
		lower.includes("usage_limit_reached") ||
		lower.includes("usage_not_included") ||
		lower.includes("usage limit") ||
		lower.includes("exhausted") ||
		lower.includes("quota")
	) {
		return "USAGE_LIMIT_REACHED";
	}

	if (
		lower.includes("rate_limit") ||
		lower.includes("rate limit") ||
		lower.includes("too many requests") ||
		lower.includes("per minute")
	) {
		return "RATE_LIMIT_EXCEEDED";
	}

	return "UNKNOWN";
}
