/**
 * Response handling: SSE→JSON conversion for non-streaming requests,
 * content-type normalization.
 */

import { logRequest, LOGGING_ENABLED } from "../logger.js";
import type { SSEEventData } from "../types.js";

function parseSseStream(sseText: string): unknown | null {
	const lines = sseText.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			try {
				const data = JSON.parse(line.substring(6)) as SSEEventData;
				if (
					data.type === "response.done" ||
					data.type === "response.completed"
				) {
					return data.response;
				}
			} catch {}
		}
	}
	return null;
}

export async function convertSseToJson(
	response: Response,
	headers: Headers,
): Promise<Response> {
	if (!response.body) {
		throw new Error("[codex-auto-switch] Response has no body");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let fullText = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			fullText += decoder.decode(value, { stream: true });
		}

		if (LOGGING_ENABLED) {
			logRequest("stream-full", { fullContent: fullText });
		}

		const finalResponse = parseSseStream(fullText);
		if (!finalResponse) {
			console.error(
				"[codex-auto-switch] Could not find final response in SSE stream",
			);
			return new Response(fullText, {
				status: response.status,
				statusText: response.statusText,
				headers,
			});
		}

		const jsonHeaders = new Headers(headers);
		jsonHeaders.set("content-type", "application/json; charset=utf-8");
		return new Response(JSON.stringify(finalResponse), {
			status: response.status,
			statusText: response.statusText,
			headers: jsonHeaders,
		});
	} catch (error) {
		console.error("[codex-auto-switch] Error converting stream:", error);
		throw error;
	}
}

export function ensureContentType(headers: Headers): Headers {
	const h = new Headers(headers);
	if (!h.has("content-type")) {
		h.set("content-type", "text/event-stream; charset=utf-8");
	}
	return h;
}
