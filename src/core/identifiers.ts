const SAFE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isSafeId(value: string): boolean {
	return SAFE_ID_PATTERN.test(value);
}

export function assertSafeId(name: string, value: string): void {
	if (!isSafeId(value))
		throw new Error(
			`${name} must contain only letters, numbers, dots, underscores, or dashes.`,
		);
}
