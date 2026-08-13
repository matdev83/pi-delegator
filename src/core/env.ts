/**
 * Read a pi-delegator environment option while accepting the historical
 * PI_SUBAGENT_* spelling for compatibility with existing installations.
 */
export function readDelegatorEnv(
	suffix: string,
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env[`PI_DELEGATOR_${suffix}`] ?? env[`PI_SUBAGENT_${suffix}`];
}
