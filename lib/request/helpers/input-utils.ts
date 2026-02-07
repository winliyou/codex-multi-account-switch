/**
 * Input filtering utilities for Codex API compatibility.
 * Handles OpenCode system prompt detection and orphaned tool output normalization.
 */

import type { InputItem } from "../../types.js";

const OPENCODE_PROMPT_SIGNATURES = [
	"you are a coding agent running in the opencode",
	"you are opencode, an agent",
	"you are opencode, an interactive cli agent",
	"you are opencode, an interactive cli tool",
	"you are opencode, the best coding agent on the planet",
].map((s) => s.toLowerCase());

const OPENCODE_CONTEXT_MARKERS = [
	"here is some useful information about the environment you are running in:",
	"<env>",
	"instructions from:",
	"<instructions>",
].map((m) => m.toLowerCase());

export const getContentText = (item: InputItem): string => {
	if (typeof item.content === "string") return item.content;
	if (Array.isArray(item.content)) {
		return (item.content as Array<{ type: string; text?: string }>)
			.filter((c) => c.type === "input_text" && c.text)
			.map((c) => c.text!)
			.join("\n");
	}
	return "";
};

const replaceContentText = (item: InputItem, text: string): InputItem => {
	if (typeof item.content === "string") return { ...item, content: text };
	if (Array.isArray(item.content)) {
		return { ...item, content: [{ type: "input_text", text }] };
	}
	return { ...item, content: text };
};

const extractOpenCodeContext = (text: string): string | null => {
	const lower = text.toLowerCase();
	let earliest = -1;
	for (const marker of OPENCODE_CONTEXT_MARKERS) {
		const idx = lower.indexOf(marker);
		if (idx >= 0 && (earliest === -1 || idx < earliest)) {
			earliest = idx;
		}
	}
	if (earliest === -1) return null;
	return text.slice(earliest).trimStart();
};

export function isOpenCodeSystemPrompt(
	item: InputItem,
	cachedPrompt: string | null,
): boolean {
	const isSystemRole = item.role === "developer" || item.role === "system";
	if (!isSystemRole) return false;

	const contentText = getContentText(item);
	if (!contentText) return false;

	if (cachedPrompt) {
		const ct = contentText.trim();
		const cp = cachedPrompt.trim();
		if (ct === cp || ct.startsWith(cp)) return true;
		if (ct.substring(0, 200) === cp.substring(0, 200)) return true;
	}

	const normalized = contentText.trimStart().toLowerCase();
	return OPENCODE_PROMPT_SIGNATURES.some((sig) => normalized.startsWith(sig));
}

export function filterOpenCodeSystemPromptsWithCachedPrompt(
	input: InputItem[] | undefined,
	cachedPrompt: string | null,
): InputItem[] | undefined {
	if (!Array.isArray(input)) return input;

	return input.flatMap((item) => {
		if (item.role === "user") return [item];
		if (!isOpenCodeSystemPrompt(item, cachedPrompt)) return [item];

		const contentText = getContentText(item);
		const preserved = extractOpenCodeContext(contentText);
		if (preserved) return [replaceContentText(item, preserved)];
		return [];
	});
}

const getCallId = (item: InputItem): string | null => {
	const rawId = (item as { call_id?: unknown }).call_id;
	if (typeof rawId !== "string") return null;
	const trimmed = rawId.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const convertOrphanedOutputToMessage = (
	item: InputItem,
	callId: string | null,
): InputItem => {
	const toolName =
		typeof (item as { name?: unknown }).name === "string"
			? ((item as { name?: string }).name as string)
			: "tool";
	let text: string;
	try {
		const out = (item as { output?: unknown }).output;
		text = typeof out === "string" ? out : JSON.stringify(out);
	} catch {
		text = String((item as { output?: unknown }).output ?? "");
	}
	if (text.length > 16000) text = text.slice(0, 16000) + "\n...[truncated]";
	return {
		type: "message",
		role: "assistant",
		content: `[Previous ${toolName} result; call_id=${callId ?? "unknown"}]: ${text}`,
	} as InputItem;
};

export const normalizeOrphanedToolOutputs = (input: InputItem[]): InputItem[] => {
	const functionCallIds = new Set<string>();
	const localShellCallIds = new Set<string>();
	const customToolCallIds = new Set<string>();

	for (const item of input) {
		const callId = getCallId(item);
		if (!callId) continue;
		if (item.type === "function_call") functionCallIds.add(callId);
		else if (item.type === "local_shell_call") localShellCallIds.add(callId);
		else if (item.type === "custom_tool_call") customToolCallIds.add(callId);
	}

	return input.map((item) => {
		if (item.type === "function_call_output") {
			const cid = getCallId(item);
			if (!cid || (!functionCallIds.has(cid) && !localShellCallIds.has(cid))) {
				return convertOrphanedOutputToMessage(item, cid);
			}
		}
		if (item.type === "custom_tool_call_output") {
			const cid = getCallId(item);
			if (!cid || !customToolCallIds.has(cid)) {
				return convertOrphanedOutputToMessage(item, cid);
			}
		}
		if (item.type === "local_shell_call_output") {
			const cid = getCallId(item);
			if (!cid || !localShellCallIds.has(cid)) {
				return convertOrphanedOutputToMessage(item, cid);
			}
		}
		return item;
	});
};
