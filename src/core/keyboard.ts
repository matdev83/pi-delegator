export function isEscapeKey(data: string): boolean {
	return (
		data === "\u001b" ||
		data === "escape" ||
		data === "esc" ||
		data === "Esc" ||
		data === "ctrl+[" ||
		data.startsWith("escape") ||
		data.startsWith("esc") ||
		/^\u001b\[27(?:;\d+)?(?::\d+)?u$/.test(data)
	);
}

export function isEnterKey(data: string): boolean {
	return (
		data === "\r" ||
		data === "\n" ||
		data === "enter" ||
		data === "return" ||
		data === "\u001b[13u"
	);
}

export function isTabKey(data: string): boolean {
	return data === "\t" || data === "tab" || data === "\u001b[9u";
}

export function isPageKey(data: string, direction: "up" | "down"): boolean {
	if (direction === "up")
		return data === "pageup" || data === "pgup" || data === "\u001b[5~";
	return data === "pagedown" || data === "pgdown" || data === "\u001b[6~";
}

export function isArrowKey(
	data: string,
	direction: "up" | "down" | "left" | "right",
): boolean {
	if (data === direction) return true;
	const legacy: Record<typeof direction, string[]> = {
		up: ["\u001b[A", "\u001bOA", "\u001b[a"],
		down: ["\u001b[B", "\u001bOB", "\u001b[b"],
		left: ["\u001b[D", "\u001bOD", "\u001b[d"],
		right: ["\u001b[C", "\u001bOC", "\u001b[c"],
	};
	if (legacy[direction].includes(data)) return true;
	const suffix: Record<typeof direction, string> = {
		up: "A",
		down: "B",
		right: "C",
		left: "D",
	};
	return new RegExp(`^\\u001b\\[1;\\d+(?::\\d+)?${suffix[direction]}$`).test(
		data,
	);
}
