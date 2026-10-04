#!/usr/bin/env node
// Regression coverage for harness-SDK resolution.
//
// `pi-delegator` declares `@earendil-works/pi-coding-agent` as a peer dependency,
// so a package manager materialises a nested copy that drifts away from the
// harness. Detached async runs are plain `node` processes with no access to the
// host's virtualised module graph and used to load that nested copy, which made
// every async run fail on a stale model catalog. These assertions pin the
// resolution contract that keeps child processes on the harness SDK.
//
// Every mandatory case runs against fixture installations created in a temp
// directory, so this check never requires a globally installed pi and never
// depends on what happens to be on PATH (or on which pi is globally installed)
// on the machine or CI runner.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	PI_PACKAGE_NAME,
	piCliScriptInPackage,
	piPackageRootAt,
	piPackageRootBeside,
	resolvePiCliFromPath,
	resolvePiInvocation,
	runningPiPackageRoot,
} from "../../src/runners/argv-builder.ts";
import {
	harnessSdkEnv,
	importPiSdk,
	piSdkRootFromEnv,
	piSdkRootFromPiCli,
	resetPiSdkCache,
} from "../../src/runners/pi-sdk.ts";

const SDK_ROOT_ENV = "PI_DELEGATOR_SDK_ROOT";
const LEGACY_SDK_ROOT_ENV = "PI_SUBAGENT_SDK_ROOT";
const cases = [];

const STUB_SDK = [
	"export const VERSION = %VERSION%;",
	"export function getAgentDir() { return %ROOT%; }",
	"export function createAgentSession() { throw new Error('fixture stub'); }",
].join("\n");

/** A pi SDK package laid out as a source checkout (`packages/coding-agent`). */
async function makeSourceStylePackage(root, version, layout) {
	const pkg = join(root, "packages", "coding-agent");
	await mkdir(join(pkg, "dist", layout.cliDir), { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({
			name: PI_PACKAGE_NAME,
			version,
			type: "module",
			...(layout.bin === false ? {} : { bin: { pi: `dist/${layout.cliDir}/cli.js` } }),
		}),
	);
	await writeFile(
		join(pkg, "dist", "index.js"),
		STUB_SDK.replace("%VERSION%", JSON.stringify(version)).replace(
			"%ROOT%",
			JSON.stringify(pkg),
		),
	);
	await writeFile(join(pkg, "dist", layout.cliDir, "cli.js"), "");
	return { pkg, cli: join(pkg, "dist", layout.cliDir, "cli.js") };
}

/** A pi SDK package installed under node_modules, plus a `pi` shim beside it. */
async function makeGlobalInstall(root, version) {
	const binDir = join(root, "bin");
	const pkg = join(binDir, "node_modules", "@earendil-works", "pi-coding-agent");
	await mkdir(join(pkg, "dist", "bundle"), { recursive: true });
	await writeFile(
		join(pkg, "package.json"),
		JSON.stringify({
			name: PI_PACKAGE_NAME,
			version,
			type: "module",
			bin: { pi: "dist/bundle/cli.js" },
		}),
	);
	await writeFile(
		join(pkg, "dist", "index.js"),
		STUB_SDK.replace("%VERSION%", JSON.stringify(version)).replace(
			"%ROOT%",
			JSON.stringify(pkg),
		),
	);
	await writeFile(join(pkg, "dist", "bundle", "cli.js"), "");
	// Extensionless `pi` is what npm/fnm shims look like on Windows, and what a
	// POSIX `which pi` resolves to. Both must be discovered.
	const shim = join(binDir, "pi");
	await writeFile(shim, "#!/bin/sh\n");
	if (process.platform !== "win32") await chmod(shim, 0o755);
	return { binDir, pkg, shim, cli: join(pkg, "dist", "bundle", "cli.js") };
}

const nativeDirs =
	process.platform === "win32"
		? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
		: ["/usr/bin", "/bin"];

/** Run `body` with a controlled argv[1] and PATH, then restore both. */
async function withDiscoveryContext({ argv1, pathDirs }, body) {
	const originalArgv1 = process.argv[1];
	const originalPath = process.env.PATH;
	const originalRootEnv = process.env[SDK_ROOT_ENV];
	const originalLegacyRootEnv = process.env[LEGACY_SDK_ROOT_ENV];
	try {
		process.argv[1] = argv1;
		// `where`/`which` itself must stay resolvable, so keep the native dirs.
		process.env.PATH = [...pathDirs, ...nativeDirs].join(process.platform === "win32" ? ";" : ":");
		delete process.env[SDK_ROOT_ENV];
		delete process.env[LEGACY_SDK_ROOT_ENV];
		assert.equal(process.argv[1], argv1, "process.argv[1] must be writable");
		return await body();
	} finally {
		process.argv[1] = originalArgv1;
		process.env.PATH = originalPath;
		if (originalRootEnv === undefined) delete process.env[SDK_ROOT_ENV];
		else process.env[SDK_ROOT_ENV] = originalRootEnv;
		if (originalLegacyRootEnv === undefined) delete process.env[LEGACY_SDK_ROOT_ENV];
		else process.env[LEGACY_SDK_ROOT_ENV] = originalLegacyRootEnv;
	}
}

// ---- 1. Explicit override wins and trims; blank values are ignored. ----

assert.equal(piSdkRootFromEnv({ [SDK_ROOT_ENV]: "  /opt/pi  " }), "/opt/pi");
assert.equal(piSdkRootFromEnv({ [LEGACY_SDK_ROOT_ENV]: "/legacy/pi" }), "/legacy/pi");
assert.equal(
	piSdkRootFromEnv({ [SDK_ROOT_ENV]: "/opt/pi", [LEGACY_SDK_ROOT_ENV]: "/legacy/pi" }),
	"/opt/pi",
	"PI_DELEGATOR_SDK_ROOT must take precedence over the legacy alias",
);
assert.equal(piSdkRootFromEnv({ [SDK_ROOT_ENV]: "   " }), undefined);
assert.equal(piSdkRootFromEnv({}), undefined);
cases.push("env override precedence");

// Windows CI exposes TEMP through an 8.3 alias; discovery returns real paths.
const tempRoot = await realpath(await mkdtemp(join(tmpdir(), "pi-delegator-sdk-")));
try {
	const foreignScript = resolve("test/checks/pi-sdk-resolution.mjs");
	const emptyDir = join(tempRoot, "empty-path");
	await mkdir(emptyDir, { recursive: true });

	const source = await makeSourceStylePackage(join(tempRoot, "source"), "1.0.0", {
		cliDir: "bundle",
		bin: true,
	});
	const global = await makeGlobalInstall(join(tempRoot, "global"), "0.84.1");

	// ---- 2. A source-style running harness wins over an unrelated global pi.
	// Path-shape heuristics ("basename is cli.js and the path contains
	// pi-coding-agent") cannot see `packages/coding-agent`, so this is the exact
	// regression: discovery used to skip the running harness and pin the global
	// installation, giving inline runs and detached workers a different SDK.
	await withDiscoveryContext({ argv1: source.cli, pathDirs: [global.binDir] }, async () => {
		assert.equal(
			runningPiPackageRoot(),
			source.pkg,
			"the running script's owning package must be identified by name",
		);
		assert.equal(
			piSdkRootFromPiCli(),
			source.pkg,
			"the running harness's SDK must win over an unrelated global pi on PATH",
		);
		assert.equal(
			harnessSdkEnv({ EXISTING: "1" }).PI_DELEGATOR_SDK_ROOT,
			source.pkg,
			"child processes must be pinned to the running harness's SDK",
		);
		assert.deepEqual(
			resolvePiInvocation().args,
			[source.cli],
			"a source-style running harness must be reused for child pi invocations",
		);
	});
	cases.push("source-style running harness beats global install");

	// ---- 3. A script that is not owned by a pi package never resolves.
	await withDiscoveryContext(
		{ argv1: foreignScript, pathDirs: [global.binDir] },
		async () => {
			assert.equal(
				runningPiPackageRoot(),
				undefined,
				"a script owned by another package must not resolve to a pi SDK",
			);
			assert.equal(
				piSdkRootFromPiCli(),
				global.pkg,
				"without a pi-owned running script, discovery falls back to PATH",
			);
			assert.equal(resolvePiCliFromPath(), global.cli);
		},
	);
	cases.push("foreign running script falls back to PATH");

	// ---- 4. Discovery degrades cleanly with no pi anywhere (clean CI runner).
	await withDiscoveryContext(
		{ argv1: foreignScript, pathDirs: [emptyDir] },
		async () => {
			assert.equal(
				resolvePiCliFromPath(),
				undefined,
				"no pi on PATH must resolve to undefined, not throw",
			);
			assert.equal(piSdkRootFromPiCli(), undefined);
			const jiti = createJiti(import.meta.url, {
				moduleCache: false,
				alias: { [PI_PACKAGE_NAME]: join(tempRoot, "missing-sdk.js") },
			});
			const unavailable = await jiti.import("../../src/runners/pi-sdk.ts");
			const env = { EXISTING: "1" };
			assert.equal(
				unavailable.harnessSdkEnv(env).PI_DELEGATOR_SDK_ROOT,
				undefined,
				"an unresolvable SDK must leave the child environment untouched",
			);
			assert.deepEqual(
				unavailable.harnessSdkEnv(env).EXISTING,
				"1",
				"unrelated child environment variables must survive",
			);
		},
	);
	cases.push("no pi installed is not fatal");

	// ---- 5. An explicit pin always survives, whatever discovery would say.
	await withDiscoveryContext(
		{ argv1: source.cli, pathDirs: [global.binDir] },
		async () => {
			assert.equal(
				harnessSdkEnv({ [SDK_ROOT_ENV]: global.pkg }).PI_DELEGATOR_SDK_ROOT,
				global.pkg,
				"a caller-pinned SDK root must not be replaced by discovery",
			);
		},
	);
	cases.push("explicit pin wins over discovery");

	// ---- 6. The pinned root is what a child process actually loads.
	await withDiscoveryContext(
		{ argv1: foreignScript, pathDirs: [emptyDir] },
		async () => {
			process.env[SDK_ROOT_ENV] = source.pkg;
			resetPiSdkCache();
			const sdk = await importPiSdk();
			assert.equal(sdk.source, source.pkg);
			assert.equal(sdk.module.VERSION, "1.0.0");
			resetPiSdkCache();
			// With the pin removed, discovery must not silently fall back to a
			// different SDK than the caller asked for.
			delete process.env[SDK_ROOT_ENV];
			assert.equal(piSdkRootFromPiCli(), undefined);
		},
	);
	cases.push("pinned root is what children load");

	// Detached runners execute from this plugin, not the host's package. The
	// inherited pin must select the same CLI with or without a competing PATH pi.
	for (const pathDirs of [[global.binDir], [emptyDir]]) {
		await withDiscoveryContext({ argv1: foreignScript, pathDirs }, async () => {
			const env = harnessSdkEnv({ ...process.env, [SDK_ROOT_ENV]: source.pkg });
			const child = execFileSync(process.execPath, ["--input-type=module", "-e", `
				process.argv[1] = ${JSON.stringify(foreignScript)};
				const { resolvePiInvocation, buildPiArgv } = await import(
					${JSON.stringify(new URL("../../src/runners/argv-builder.ts", import.meta.url).href)});
				console.log(JSON.stringify({ invocation: resolvePiInvocation(),
					argv: buildPiArgv({ agent: "worker", task: "fixture task" }),
					explicit: buildPiArgv({ agent: "worker", task: "fixture task", piCommand: "custom-pi" }) }));
			`], { env, encoding: "utf8" });
			const result = JSON.parse(child);
			assert.deepEqual(result.invocation, { command: process.execPath, args: [source.cli] },
				"detached runners must use the pinned package's declared CLI before PATH");
			assert.deepEqual(result.argv.slice(0, 2), [process.execPath, source.cli]);
			assert.equal(result.explicit[0], "custom-pi", "explicit piCommand still wins");
		});
	}
	await withDiscoveryContext({ argv1: global.cli, pathDirs: [global.binDir] }, async () => {
		process.env[LEGACY_SDK_ROOT_ENV] = source.pkg;
		assert.deepEqual(resolvePiInvocation().args, [source.cli], "legacy pins beat the running CLI");
		process.env[SDK_ROOT_ENV] = global.pkg;
		assert.deepEqual(resolvePiInvocation().args, [global.cli], "modern pins beat legacy pins");
	});
	cases.push("detached child CLI honors SDK pins with and without PATH pi");

	await withDiscoveryContext({ argv1: foreignScript, pathDirs: [global.binDir] }, async () => {
		const originalExecPath = process.execPath;
		try {
			process.execPath = join(tempRoot, "pi.exe");
			process.env[SDK_ROOT_ENV] = source.pkg;
			assert.deepEqual(resolvePiInvocation(), { command: process.execPath, args: [] },
				"a compiled Pi executable must not receive a JavaScript entry as a prompt");
		} finally {
			process.execPath = originalExecPath;
		}
	});
	cases.push("compiled host retains native invocation with a pin");

	if (process.platform === "win32") {
		await withDiscoveryContext({ argv1: foreignScript, pathDirs: [global.binDir] }, async () => {
			process.env[SDK_ROOT_ENV] = source.pkg.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
				.replaceAll("\\", "/");
			resetPiSdkCache();
			assert.equal((await importPiSdk()).module.VERSION, "1.0.0",
				"MSYS SDK roots must select the same package for inline and CLI runs");
			assert.deepEqual(resolvePiInvocation().args, [source.cli]);
		});
		cases.push("Windows MSYS roots honor inline and CLI pins");
	}

	const local = await makeGlobalInstall(join(tempRoot, "standalone"), "1.0.1");
	await writeFile(join(local.pkg, "package.json"), JSON.stringify({
		name: PI_PACKAGE_NAME, type: "module", main: "dist/index.js",
	}));
	await writeFile(join(local.binDir, "package.json"), JSON.stringify({ name: "standalone-fixture", type: "module" }));
	const standaloneSdk = join(local.binDir, "pi-sdk.ts");
	const sdkUrl = new URL("../../src/runners/pi-sdk.ts", import.meta.url);
	await writeFile(standaloneSdk, (await readFile(sdkUrl, "utf8")).replaceAll(
		'"./argv-builder.ts"', JSON.stringify(new URL("../../src/runners/argv-builder.ts", import.meta.url).href)));
	await withDiscoveryContext({ argv1: foreignScript, pathDirs: [global.binDir] }, async () => {
		const child = execFileSync(process.execPath, ["--input-type=module", "-e", `
			process.argv[1] = ${JSON.stringify(foreignScript)};
			const { importPiSdk, harnessSdkEnv } = await import(${JSON.stringify(pathToFileURL(standaloneSdk).href)});
			const parent = await importPiSdk();
			const env = harnessSdkEnv();
			process.env.PI_DELEGATOR_SDK_ROOT = env.PI_DELEGATOR_SDK_ROOT;
			const worker = await import(${JSON.stringify(sdkUrl.href)});
			const child = await worker.importPiSdk();
			console.log(JSON.stringify({ parent: parent.module.VERSION, child: child.module.VERSION, root: env.PI_DELEGATOR_SDK_ROOT }));
		`], { env: process.env, encoding: "utf8" });
		assert.deepEqual(JSON.parse(child), { parent: "1.0.1", child: "1.0.1", root: local.pkg },
			"standalone callers must pin their disk-backed runtime SDK before PATH");
	});
	cases.push("standalone runtime SDK is pinned before global PATH SDK");

	// An embedded/compiled host has no pi-owned entry script, but supplies its
	// live SDK through Jiti. PATH discovery is still useful for detached workers;
	// it must not displace that virtual SDK in the host process.
	await withDiscoveryContext(
		{ argv1: foreignScript, pathDirs: [global.binDir] },
		async () => {
			const hostSdk = {
				VERSION: "live-host",
				createAgentSession() { throw new Error("fixture stub"); },
			};
			const jiti = createJiti(import.meta.url, {
				moduleCache: false,
				virtualModules: { [PI_PACKAGE_NAME]: hostSdk },
				alias: { [PI_PACKAGE_NAME]: join(tempRoot, "virtual-sdk-without-disk.js") },
			});
			assert.equal((await jiti.import(PI_PACKAGE_NAME)).VERSION, "live-host");
			const hosted = await jiti.import("../../src/runners/pi-sdk.ts");
			const sdk = await hosted.importPiSdk();
			assert.equal(sdk.module.VERSION, "live-host",
				"the live virtual SDK must win over an unrelated PATH installation");
			assert.equal(sdk.source, "runtime");
			assert.equal(hosted.harnessSdkEnv({}).PI_DELEGATOR_SDK_ROOT, global.pkg,
				"detached workers still need a discoverable disk root");
			process.env[SDK_ROOT_ENV] = source.pkg;
			hosted.resetPiSdkCache();
			assert.equal((await hosted.importPiSdk()).module.VERSION, "1.0.0",
				"an explicit worker pin must win even when a virtual SDK is available");
		},
	);
	cases.push("live virtual SDK beats PATH while workers retain disk pins");
	await withDiscoveryContext(
		{ argv1: foreignScript, pathDirs: [global.binDir] },
		async () => {
			const jiti = createJiti(import.meta.url, {
				moduleCache: false,
				alias: { [PI_PACKAGE_NAME]: join(tempRoot, "missing-sdk.js") },
			});
			await assert.rejects(jiti.import(PI_PACKAGE_NAME));
			const standalone = await jiti.import("../../src/runners/pi-sdk.ts");
			const sdk = await standalone.importPiSdk();
			assert.equal(sdk.source, global.pkg);
			assert.equal(sdk.module.VERSION, "0.84.1",
				"PATH remains a fallback when the bare SDK import is unavailable");
		},
	);
	cases.push("PATH fallback after unavailable runtime import");

	// ---- 7. Package-root detection validates by name, not by path shape.
	assert.equal(piPackageRootAt(source.cli), source.pkg);
	assert.equal(piPackageRootAt(source.pkg), source.pkg);
	assert.equal(
		piPackageRootAt(foreignScript),
		undefined,
		"this plugin's own script must not resolve to a pi SDK",
	);
	assert.equal(
		piPackageRootAt(join(tempRoot, "missing", "cli.js")),
		undefined,
		"a non-existent entry must resolve to undefined, not throw",
	);
	assert.equal(piPackageRootBeside(global.binDir), global.pkg);
	assert.equal(
		piPackageRootBeside(source.pkg),
		undefined,
		"a pi package is not its own node_modules sibling",
	);
	cases.push("package detection by name");

	// ---- 8. CLI entry discovery follows bin.pi across layouts.
	assert.equal(
		piCliScriptInPackage(source.pkg),
		source.cli,
		"the declared bin.pi entry must be used",
	);
	const legacyLayout = await makeSourceStylePackage(join(tempRoot, "legacy"), "0.84.1", {
		cliDir: "cli-root",
		bin: false,
	});
	await writeFile(join(legacyLayout.pkg, "dist", "cli.js"), "");
	assert.equal(
		piCliScriptInPackage(legacyLayout.pkg),
		join(legacyLayout.pkg, "dist", "cli.js"),
		"a package without bin.pi must fall back to a known layout",
	);
	await rm(join(legacyLayout.pkg, "dist", "cli.js"), { force: true });
	await rm(join(legacyLayout.pkg, "dist", "cli-root"), {
		recursive: true,
		force: true,
	});
	assert.equal(
		piCliScriptInPackage(legacyLayout.pkg),
		undefined,
		"a package with no CLI entry at all must resolve to undefined",
	);
	assert.equal(
		piCliScriptInPackage(join(tempRoot, "no-such-package")),
		undefined,
		"a non-existent package must resolve to undefined, not throw",
	);
	cases.push("cli entry discovery by layout");

	console.log(
		JSON.stringify({ name: "check-pi-sdk-resolution", status: "completed", cases }, null, 2),
	);
} finally {
	resetPiSdkCache();
	await rm(tempRoot, { recursive: true, force: true });
}
