// Resolution of the Pi SDK that subagent runs must use.
//
// The plugin declares `@earendil-works/pi-coding-agent` as a peer dependency,
// so a package manager materialises its own nested copy inside
// `<plugin>/node_modules`. That copy is version-pinned at install time and
// drifts as soon as the harness upgrades: an async run spawns
// `src/workers/durable-worker.mjs` as a detached `node` process, which has no
// access to the host's virtualised module graph and therefore falls back to the
// nested copy. A stale SDK means a stale model catalog, so profile-declared
// models (`model: openai/gpt-6.1-sol`) resolve to "no models match pattern" and
// every detached run fails immediately.
//
// Resolution order below always prefers the SDK that belongs to the harness that
// launched the run:
//   1. explicit override (`PI_DELEGATOR_SDK_ROOT`, legacy `PI_SUBAGENT_SDK_ROOT`)
//   2. the package that owns the script running this process (by package name,
//      so source-style installs such as `packages/coding-agent/dist/...` are
//      recognised and never shadowed by an unrelated global install)
//   3. bare `import("@earendil-works/pi-coding-agent")` (including the live
//      virtual SDK supplied by compiled/embedded hosts)
//   4. the package owning a `pi` CLI on PATH, if the runtime import fails
// Detached workers receive a disk-root pin through harnessSdkEnv instead:
// virtual modules cannot be transferred to another process.

import fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	PI_PACKAGE_NAME as SDK_PACKAGE_NAME,
	normalizeHostPath,
	piPackageRootAt,
	piPackageRootBeside,
	piSdkRootFromEnv,
	resolvePiCliFromPath,
	runningPiPackageRoot,
} from "./argv-builder.ts";
import type { ThinkingLevel } from "../core/constants.ts";

export { piSdkRootFromEnv } from "./argv-builder.ts";

const SDK_ENTRY = join("dist", "index.js");
const SDK_ROOT_ENV = "PI_DELEGATOR_SDK_ROOT";

export interface ResourceLoaderLike {
	reload(options?: unknown): Promise<void>;
}

export interface DefaultResourceLoaderOptionsLike {
	cwd: string;
	agentDir: string;
	additionalExtensionPaths?: string[];
	additionalSkillPaths?: string[];
	noExtensions?: boolean;
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export interface PiSdkModule {
	SessionManager: { inMemory(cwd?: string): unknown };
	DefaultResourceLoader: new (
		options: DefaultResourceLoaderOptionsLike,
	) => ResourceLoaderLike;
	getAgentDir: () => string;
	ModelRuntime: {
		create(options?: Record<string, unknown>): Promise<ModelRuntimeLike>;
	};
	SettingsManager: {
		create(cwd?: string, agentDir?: string): SettingsManagerLike;
	};
	resolveModelScopeWithDiagnostics(
		patterns: string[],
		modelRuntime: ModelRuntimeLike,
		options?: Record<string, unknown>,
	): Promise<ResolveModelScopeResultLike>;
	createAgentSession(
		options: Record<string, unknown>,
	): Promise<{ session: AgentSessionLike }>;
}

export interface ModelLike {
	provider?: string;
	id?: string;
}

export interface AssistantMessageLike {
	role?: string;
	content?: Array<{ type?: string; text?: string } | null>;
	stopReason?: string;
	errorMessage?: string;
}

export interface CompletionContextLike {
	systemPrompt?: string;
	messages: unknown[];
}

export interface CompletionOptionsLike {
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
}

export interface ModelRuntimeLike {
	completeSimple?: (
		model: ModelLike,
		context: CompletionContextLike,
		options?: CompletionOptionsLike,
	) => Promise<AssistantMessageLike>;
	getAvailable?: () => Promise<ModelLike[]>;
	getModels?: () => ModelLike[];
	getModel?: (provider: string, modelId: string) => ModelLike | undefined;
}

export interface SettingsManagerLike {
	getDefaultProvider?: () => string | undefined;
	getDefaultModel?: () => string | undefined;
}

export interface ResolveModelScopeResultLike {
	scopedModels: Array<{
		model: ModelLike;
		thinkingLevel?: ThinkingLevel;
	}>;
	diagnostics?: Array<{ message?: string }>;
}

export interface AgentSessionLike {
	prompt(text: string): Promise<void>;
	subscribe?: (listener: (event: unknown) => void) => () => void;
	abort?: () => Promise<void>;
	dispose?: () => void;
	messages?: unknown[];
}

export interface SdkImportResult {
	module: PiSdkModule;
	source: string;
}

/**
 * Package root of the SDK that belongs to the harness running this process.
 *
 * The running script is checked first and identified purely by owning-package
 * metadata, so a source-style install (`packages/coding-agent/dist/...`) wins
 * over anything on PATH. Getting this wrong selects a different SDK version
 * than the host, which is precisely the model-catalog skew this module exists to
 * prevent.
 */
export function piSdkRootFromPiCli(): string | undefined {
	const running = runningPiPackageRoot();
	if (running !== undefined) return running;
	const cli = resolvePiCliFromPath();
	if (cli === undefined) return undefined;
	return piPackageRootAt(cli) ?? piPackageRootBeside(dirname(cli));
}

async function importPiSdkFromRoot(
	root: string,
): Promise<SdkImportResult | undefined> {
	root = normalizeHostPath(root);
	const entry = join(root, SDK_ENTRY);
	if (!fs.existsSync(entry)) return undefined;
	try {
		const module = (await import(pathToFileURL(entry).href)) as PiSdkModule;
		if (typeof module.createAgentSession !== "function") return undefined;
		return { module, source: root };
	} catch {
		return undefined;
	}
}

let cached: Promise<SdkImportResult> | undefined;

/**
 * Import the Pi SDK that matches the running harness. Cached because the result
 * is stable for the lifetime of the process and repeated resolution would pay
 * filesystem lookups on every subagent run.
 */
export function importPiSdk(): Promise<SdkImportResult> {
	cached ??= resolvePiSdk();
	return cached;
}

/** Drop the memoized SDK import (tests and host reloads). */
export function resetPiSdkCache(): void {
	cached = undefined;
}

async function resolvePiSdk(): Promise<SdkImportResult> {
	const overridden = piSdkRootFromEnv();
	if (overridden !== undefined) {
		const fromOverride = await importPiSdkFromRoot(overridden);
		if (fromOverride !== undefined) return fromOverride;
	}
	const running = runningPiPackageRoot();
	if (running !== undefined && running !== overridden) {
		const fromHarness = await importPiSdkFromRoot(running);
		if (fromHarness !== undefined) return fromHarness;
	}
	try {
		const module = (await import(SDK_PACKAGE_NAME)) as unknown as PiSdkModule;
		return { module, source: "runtime" };
	} catch (projectError) {
		// A compiled/embedded host can provide the bare specifier virtually even
		// though argv[1] belongs to another package. Only use PATH after that
		// live import fails, otherwise an unrelated install can replace the host.
		const fromCli = piSdkRootFromPiCli();
		if (fromCli !== undefined && fromCli !== overridden && fromCli !== running) {
			const fromPath = await importPiSdkFromRoot(fromCli);
			if (fromPath !== undefined) return fromPath;
		}
		const message =
			projectError instanceof Error
				? projectError.message
				: String(projectError);
		throw new Error(
			`Could not import ${SDK_PACKAGE_NAME}: no running pi CLI owns this process, no pi CLI was found on PATH, and the local package is unusable (${message}). Install pi, or set ${SDK_ROOT_ENV} to an installed ${SDK_PACKAGE_NAME} package root.`,
		);
	}
}

function diskRuntimeSdkRoot(): string | undefined {
	try {
		// Native ESM resolution follows the same peer import used by standalone
		// API calls. Virtual hosts need not expose a resolvable file URL.
		return piPackageRootAt(fileURLToPath(import.meta.resolve(SDK_PACKAGE_NAME)));
	} catch {
		// A virtual/missing runtime has no disk root to transfer to the worker.
		return undefined;
	}
}

/**
 * Environment for a child process that must load the same SDK as this process.
 * Child processes have no access to the host's virtualised module graph, so the
 * resolved package root is pinned explicitly.
 */
export function harnessSdkEnv(
	env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const root = piSdkRootFromEnv(env) ?? runningPiPackageRoot() ?? diskRuntimeSdkRoot() ?? piSdkRootFromPiCli();
	if (root === undefined) return env;
	return { ...env, [SDK_ROOT_ENV]: root };
}
