import { existsSync, realpathSync } from "node:fs";
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

export function isPiCliScript(p: string): boolean {
	const base = basename(p).toLowerCase();
	if (base !== "cli.js" && base !== "cli") return false;
	return /pi-coding-agent/.test(p.replaceAll("\\", "/"));
}

export function resolvePiCliFromPath(): string | undefined {
	try {
		const found = execFileSync(
			process.platform === "win32" ? "where" : "which",
			["pi"],
			{ encoding: "utf8", timeout: 2_000 },
		)
			.trim()
			.split(/\r?\n/)[0];
		if (found.length === 0) return undefined;
		const real = realpathSync(normalizeHostPath(found));
		if (isPiCliScript(real) && existsSync(real)) return real;
		const siblingCli = join(
			dirname(real),
			"node_modules",
			"@earendil-works",
			"pi-coding-agent",
			"dist",
			"cli.js",
		);
		if (existsSync(siblingCli)) return siblingCli;
		return undefined;
	} catch {
		return undefined;
	}
}

export function resolvePiInvocation(): { command: string; args: string[] } {
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: [] };
	}
	const currentScript = process.argv[1];
	if (currentScript && isPiCliScript(currentScript) && existsSync(currentScript)) {
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
	const model = options.model ?? options.agentDefinition?.model;
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
