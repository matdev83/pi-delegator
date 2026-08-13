#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync as readTextFileSync } from "node:fs";

function capture(command, args) {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function captureNpm(args) {
	const npmExecPath = process.env.npm_execpath;
	if (npmExecPath) return capture(process.execPath, [npmExecPath, ...args]);
	return capture("npm", args);
}

const pkg = JSON.parse(
	readTextFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

if (pkg.name !== "pi-delegator") {
	throw new Error(`Unexpected package name: ${pkg.name}`);
}
if (pkg.private === true) throw new Error("Refusing to release a private package.");
if (!pkg.keywords?.includes("pi-package")) {
	throw new Error('package keywords must include "pi-package".');
}
if (!pkg.pi?.extensions?.length) {
	throw new Error("package.json must declare pi.extensions.");
}
for (const requiredPath of ["README.md", "LICENSE", "NOTICE.md", "CHANGELOG.md"]) {
	if (!existsSync(new URL(`../${requiredPath}`, import.meta.url))) {
		throw new Error(`Missing release file: ${requiredPath}`);
	}
}

const registryResult = await fetch(
	`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`,
);
if (registryResult.ok) {
	throw new Error(`${pkg.name}@${pkg.version} already exists on npm.`);
}
if (registryResult.status !== 404) {
	throw new Error(
		`Could not verify npm availability: registry returned ${registryResult.status}.`,
	);
}

console.log("$ npm run validate");
captureNpm(["run", "validate"]);

console.log("$ npm pack --dry-run --json");
const packResult = JSON.parse(captureNpm(["pack", "--dry-run", "--json"]));
const summary = Array.isArray(packResult)
	? packResult[0]
	: (packResult[pkg.name] ?? Object.values(packResult)[0]);
if (!summary || !Array.isArray(summary.files)) {
	throw new Error("npm pack returned an unsupported JSON summary.");
}
const files = summary.files.map((file) => file.path);
const requiredPackageFiles = [
	"README.md",
	"LICENSE",
	"NOTICE.md",
	"CHANGELOG.md",
	"docs/usage.md",
	"assets/subagent-panel.png",
	"api.mjs",
	"src/api.ts",
	"src/index.ts",
	"package.json",
];
const missing = requiredPackageFiles.filter((path) => !files.includes(path));
if (missing.length > 0) {
	throw new Error(`Package is missing required files: ${missing.join(", ")}`);
}
if (
	files.some(
		(path) =>
			path.startsWith("internal/") ||
			path.startsWith("node_modules/") ||
			path.startsWith(".pi/") ||
			path.startsWith(".harness/"),
	)
) {
	throw new Error("Package contains local or internal files.");
}

console.log(
	JSON.stringify(
		{
			name: summary.name,
			version: summary.version,
			filename: summary.filename,
			entryCount: summary.entryCount,
			packageSize: summary.size,
			unpackedSize: summary.unpackedSize,
		},
		null,
		2,
	),
);
console.log("Release check passed. Publish manually with: npm publish");
