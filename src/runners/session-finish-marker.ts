export const SESSION_FINISH_MARKER =
	"I HAVE FULLY FINISHED ALL TASKS FROM THIS SESSION";

export const SESSION_FINISH_PROMPT =
	'Please continue if you have any remaining tasks from this session to execute. If not, just respond with exactly following words as a session finish marker: "I HAVE FULLY FINISHED ALL TASKS FROM THIS SESSION."';

const NON_ALPHANUMERIC_PATTERN = /[^A-Z0-9]+/g;

export function normalizeMarkerText(text: string): string {
	return text.toUpperCase().replace(NON_ALPHANUMERIC_PATTERN, " ").trim();
}

const EXACT_MARKER = normalizeMarkerText(SESSION_FINISH_MARKER);

export function matchesSessionFinishMarker(text: string): boolean {
	const normalized = normalizeMarkerText(text);
	if (normalized.length === 0) return false;
	if (normalized === EXACT_MARKER || normalized.includes(EXACT_MARKER))
		return true;
	if (
		normalized.includes("FULLY FINISHED") &&
		normalized.includes("ALL TASKS") &&
		normalized.includes("THIS SESSION")
	)
		return true;
	if (
		normalized.includes("FINISHED ALL TASKS") &&
		(normalized.includes("THIS SESSION") ||
			normalized.includes("FROM THIS SESSION") ||
			normalized.includes("THE SESSION"))
	)
		return true;
	if (normalized.includes("NO REMAINING TASKS")) return true;
	if (normalized.includes("NO MORE TASKS")) return true;
	if (normalized.includes("ALL TASKS COMPLETE")) return true;
	if (normalized.includes("ALL TASKS COMPLETED")) return true;
	if (normalized.includes("ALL TASKS DONE")) return true;
	return false;
}
