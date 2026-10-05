import { join } from "node:path";
import {
	importPiSdk,
	type AssistantMessageLike,
	type ModelRuntimeLike,
	type PiSdkModule,
} from "../runners/pi-sdk.ts";
import type { SessionTitleGenerator } from "./session-title.ts";

// The auxiliary request behind automatic session titles.
//
// Titles must be cheap and must not share the parent session, so this issues a
// single short chat completion against the configured lightweight model through
// the same Pi SDK the inline backend uses. That keeps provider auth, the model
// catalog, and virtual hosts consistent with the rest of the plugin instead of
// hand-rolling HTTP calls.

const MAX_PROMPT_CHARS = 1_200;
const MAX_OUTPUT_TOKENS = 32;

const TITLE_SYSTEM_PROMPT = [
	"You name software engineering work batches for a task list.",
	"Reply with the title only: 3 to 6 words, no quotes, no punctuation",
	"at the end, and no explanation.",
].join(" ");


function buildTitlePrompt(dispatch: string, agent?: string): string {
	const clippedDispatch =
		dispatch.length > MAX_PROMPT_CHARS
			? `${dispatch.slice(0, MAX_PROMPT_CHARS)}…`
			: dispatch;
	return [
		"Task given to the subagent:",
		clippedDispatch,
		agent === undefined || agent.length === 0
			? undefined
			: `Subagent profile: ${agent}`,
		"Title (3-6 words):",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

function textFromAssistantMessage(message: AssistantMessageLike): string {
	if (!Array.isArray(message.content)) return "";
	const text = message.content
		.map((part) =>
			part !== null && part.type === "text" && typeof part.text === "string"
				? part.text
				: "",
		)
		.join("");
	return text;
}

let runtime: Promise<ModelRuntimeLike> | undefined;

/**
 * Shared model runtime for title requests. Catalog and credential state are
 * stable for the lifetime of the process, so repeated dispatches must not
 * re-read auth.json/models.json.
 */
async function titleModelRuntime(): Promise<ModelRuntimeLike> {
	runtime ??= (async () => {
		const { module: piSdk } = await importPiSdk();
		return await piSdk.ModelRuntime.create({
			authPath: join(piSdk.getAgentDir(), "auth.json"),
			modelsPath: join(piSdk.getAgentDir(), "models.json"),
			refreshOnCreate: false,
		});
	})().catch((error: unknown) => {
		// Never memoize a failure: a later dispatch may find a usable SDK.
		runtime = undefined;
		throw error;
	});
	return await runtime;
}

/** Drop the memoized title runtime (tests, host reloads). */
export function resetSessionTitleRuntime(): void {
	runtime = undefined;
}

async function completeTitle(
	piSdk: PiSdkModule,
	modelRuntime: ModelRuntimeLike,
	model: string,
	prompt: string,
	signal: AbortSignal,
): Promise<string> {
	const resolved = await piSdk.resolveModelScopeWithDiagnostics(
		[model],
		modelRuntime,
	);
	const scoped = resolved.scopedModels[0];
	if (scoped === undefined) {
		const detail = resolved.diagnostics?.[0]?.message ?? "";
		throw new Error(
			(`title model ${JSON.stringify(model)} was not found or is not` +
				` available. ${detail}`).trim(),
		);
	}
	if (typeof modelRuntime.completeSimple !== "function")
		throw new Error("the resolved Pi SDK cannot issue a title request.");
	const message = await modelRuntime.completeSimple(
		scoped.model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		},
		{ maxTokens: MAX_OUTPUT_TOKENS, temperature: 0, signal },
	);
	if (message.stopReason === "error" || message.stopReason === "aborted")
		throw new Error(
			`title request ${message.stopReason}: ${
				message.errorMessage ?? "no detail"
			}`,
		);
	return textFromAssistantMessage(message);
}

/**
 * Request one short title from the configured lightweight model.
 *
 * Failures propagate to generateSessionTitle, which converts them into the
 * dispatch proxy title. Nothing here retries or blocks the dispatch.
 */
export const requestModelSessionTitle: SessionTitleGenerator = async (
	request,
) => {
	const { module: piSdk } = await importPiSdk();
	const modelRuntime = await titleModelRuntime();
	return await completeTitle(
		piSdk,
		modelRuntime,
		request.model,
		buildTitlePrompt(request.dispatch, request.agent),
		request.signal,
	);
};
