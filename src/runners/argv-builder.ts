import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentSystemPrompt } from "../agents.ts";
import { normalizeToolResultBudget } from "./tool-result-budget.ts";
import type { RunHeadlessModelOptions } from "./headless-model.ts";

export function toolResultBudgetExtensionPath(): string {
	return fileURLToPath(
		new URL("./tool-result-budget-extension.ts", import.meta.url),
	);
}

export function buildPrompt(options: RunHeadlessModelOptions): string {
	if (options.systemPrompt !== undefined) return options.task;
	const sections = [
		`You are the Pi subagent named ${JSON.stringify(options.agent)}.`,
		options.roleContext ? `Role context:\n${options.roleContext}` : undefined,
		options.agentScope ? `Agent scope: ${options.agentScope}` : undefined,
		options.confirmProjectAgents === undefined
			? undefined
			: `confirmProjectAgents: ${String(options.confirmProjectAgents)}`,
		`Task:\n${options.task}`,
	];
	return sections
		.filter((section): section is string => section !== undefined)
		.join("\n\n");
}

export function effectiveSpawnCommand(
	argv: readonly [string, ...string[]],
): { command: string; args: string[] } {
	if (process.platform !== "win32") {
		return { command: argv[0], args: argv.slice(1) };
	}
	const extension = extname(argv[0]).toLowerCase();
	if (
		extension === ".exe" ||
		extension === ".com" ||
		extension === ".bat" ||
		extension === ".cmd"
	) {
		return { command: argv[0], args: argv.slice(1) };
	}
	return { command: process.execPath, args: [...argv] };
}

export function normalizeHostPath(p: string): string {
	if (process.platform !== "win32") return p;
	const m = /^\/[a-zA-Z]\//.exec(p);
	if (m) return `${m[0][1].toUpperCase()}:${p.slice(2)}`;
	return p;
}

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/** Shared SDK/CLI pin parsing, including the historical environment alias. */
export function piSdkRootFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	const raw = env.PI_DELEGATOR_SDK_ROOT ?? env.PI_SUBAGENT_SDK_ROOT;
	if (typeof raw !== "string") return undefined;
	const root = raw.trim();
	return root.length === 0 ? undefined : root;
}

export const PI_PACKAGE_SEGMENTS = [
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
] as const;

function readPackageJson(dir: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(
			readFileSync(join(dir, "package.json"), "utf8"),
		) as unknown;
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function isPiPackageDir(dir: string): boolean {
	if (!existsSync(join(dir, "package.json"))) return false;
	return readPackageJson(dir)?.name === PI_PACKAGE_NAME;
}

/**
 * Package root that owns `entry`, when that package is pi-coding-agent.
 *
 * Walks up to the nearest `package.json` and validates it by name rather than by
 * path shape. A path heuristic such as "basename is cli.js and the path contains
 * pi-coding-agent" cannot see source-style installs (`packages/coding-agent/
 * dist/bundle/cli.js`), which would make discovery skip the harness that is
 * actually running and fall back to an unrelated global install. A nearer
 * `package.json` of a different name shadows the search, so a foreign package
 * never resolves.
 */
export function piPackageRootAt(entry: string): string | undefined {
	let real: string;
	try {
		real = realpathSync(normalizeHostPath(entry));
	} catch {
		return undefined;
	}
	if (!existsSync(real)) return undefined;
	let current = statSync(real).isDirectory() ? real : dirname(real);
	for (;;) {
		if (existsSync(join(current, "package.json")))
			return isPiPackageDir(current) ? current : undefined;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Installed pi package root sitting next to a bin-shim directory, if present. */
export function piPackageRootBeside(binDir: string): string | undefined {
	const root = join(binDir, ...PI_PACKAGE_SEGMENTS);
	return isPiPackageDir(root) ? root : undefined;
}

/**
 * CLI entry for an installed pi package.
 *
 * Pi moved the entry from `dist/cli.js` to `dist/bundle/cli.js` in the 1.0
 * series, so the declared `bin.pi` is authoritative. The known layouts remain a
 * fallback for source checkouts that ship the SDK without a `bin` field.
 */
export function piCliScriptInPackage(packageRoot: string): string | undefined {
	const declared = readPackageJson(packageRoot)?.bin;
	const bin = typeof declared === "object" && declared !== null
		? (declared as { pi?: unknown }).pi
		: undefined;
	const candidates =
		typeof bin === "string" && bin.length > 0
			? [
					join(
						packageRoot,
						...bin.replace(/^[./\\]+/, "").split(/[\\/]/),
					),
				]
			: [];
	for (const fallback of ["dist/cli.js", "dist/bundle/cli.js"]) {
		candidates.push(join(packageRoot, ...fallback.split("/")));
	}
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	return undefined;
}

/**
 * Locate the `pi` CLI on PATH. Handles direct cli.js entries, npm/pnpm/yarn
 * shims (`pi`, `pi.cmd`) that sit beside the package, and multi-hit `where`
 * output where the first entry may be a shell wrapper. Each candidate is
 * validated by owning-package name, never by path shape.
 */
export function resolvePiCliFromPath(): string | undefined {
	let output: string;
	try {
		output = execFileSync(
			process.platform === "win32" ? "where" : "which",
			["pi"],
			// `where` prints an INFO line when nothing matches; that is a normal
			// outcome here, so keep it out of the check output.
			{ encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] },
		);
	} catch {
		return undefined;
	}
	for (const line of output.split(/\r?\n/)) {
		const entry = line.trim();
		if (entry.length === 0) continue;
		let real: string;
		try {
			real = realpathSync(normalizeHostPath(entry));
		} catch {
			continue;
		}
		if (!existsSync(real)) continue;
		// Either the entry is itself inside a pi package (a resolved cli.js), or
		// it is a shim sitting beside one.
		for (const root of [piPackageRootAt(real), piPackageRootBeside(dirname(real))]) {
			if (root === undefined) continue;
			const cli = piCliScriptInPackage(root);
			if (cli !== undefined) return cli;
		}
	}
	return undefined;
}

/**
 * Package root of the pi install that owns the script running this process.
 *
 * This is the authoritative answer for a hosted extension: it identifies the
 * exact SDK the harness loaded, independently of PATH, install layout, and
 * whether `pi` is on PATH at all.
 */
export function runningPiPackageRoot(): string | undefined {
	const currentScript = process.argv[1];
	if (typeof currentScript !== "string" || currentScript.length === 0)
		return undefined;
	return piPackageRootAt(currentScript);
}

export function resolvePiInvocation(): { command: string; args: string[] } {
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: [] };
	}
	const pinnedRoot = piSdkRootFromEnv();
	if (pinnedRoot !== undefined) {
		const pinnedCli = piCliScriptInPackage(normalizeHostPath(pinnedRoot));
		if (pinnedCli !== undefined) {
			return { command: process.execPath, args: [pinnedCli] };
		}
	}
	const currentScript = process.argv[1];
	if (
		currentScript &&
		existsSync(currentScript) &&
		piPackageRootAt(currentScript) !== undefined
	) {
		return { command: process.execPath, args: [currentScript] };
	}
	const fromPath = resolvePiCliFromPath();
	if (fromPath !== undefined) {
		return { command: process.execPath, args: [fromPath] };
	}
	return { command: "pi", args: [] };
}

export function buildPiArgv(
	options: RunHeadlessModelOptions,
): readonly [string, ...string[]] {
	const explicit = options.piCommand;
	const invocation =
		explicit === undefined
			? resolvePiInvocation()
			: { command: explicit, args: [] as string[] };
	const argv: string[] = [
		invocation.command,
		...invocation.args,
		"--mode",
		"json",
		"--print",
	];
	if (options.sessionId !== undefined) {
		argv.push("--session-id", options.sessionId);
	} else {
		argv.push("--no-session");
	}
	argv.push("--no-context-files", "--exclude-tools", "subagent");
	const model = options.model ?? options.agentDefinition?.model ?? options.hostModel;
	const thinking = options.thinking ?? options.agentDefinition?.thinking;
	const tools = options.tools ?? options.agentDefinition?.tools;
	const agentSystemPrompt =
		options.systemPrompt !== undefined
			? undefined
			: options.agentDefinition === undefined
				? undefined
				: buildAgentSystemPrompt(options.agentDefinition);

	if (options.systemPrompt !== undefined) {
		argv.push("--system-prompt", options.systemPrompt);
	} else if (agentSystemPrompt !== undefined) {
		argv.push(
			options.agentDefinition?.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			agentSystemPrompt,
		);
	}
	if (model !== undefined) argv.push("--model", model);
	if (thinking !== undefined) argv.push("--thinking", thinking);
	if (tools !== undefined && tools.length > 0)
		argv.push("--tools", tools.join(","));
	else if (tools !== undefined) argv.push("--no-tools");
	if (options.skills !== undefined && options.skills.length === 0)
		argv.push("--no-skills");
	else for (const skill of options.skills ?? []) argv.push("--skill", skill);
	if (options.extensions !== undefined && options.extensions.length === 0)
		argv.push("--no-extensions");
	else
		for (const extension of options.extensions ?? [])
			argv.push("--extension", extension);
	if (normalizeToolResultBudget(options.toolResultBudget).budget !== undefined)
		argv.push("--extension", toolResultBudgetExtensionPath());
	argv.push(buildPrompt(options));
	return argv as [string, ...string[]];
}
