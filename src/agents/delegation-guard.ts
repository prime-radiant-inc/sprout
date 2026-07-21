/**
 * Delegation secret guard (workshop lever 2): text bound for a child —
 * goals, hints, follow-up messages — that carries a pattern-detectable
 * credential is rejected BEFORE dispatch with a corrective error steering to
 * env grants / ⟦ref⟧ passing.
 *
 * Honest scope: this cannot un-emit what the model already wrote into its
 * tool call (preventing first emission is the tool descriptions' job); it
 * keeps the secret out of the child's context and process, and converts the
 * mistake into an immediate, teachable retry.
 */
import { redactSensitiveTranscriptContent } from "../kernel/redaction.ts";

export function secretBearingDelegationError(text: string): string | undefined {
	if (redactSensitiveTranscriptContent(text) === text) return undefined;
	return (
		"Rejected: this delegation text contains a raw credential/secret. Never paste " +
		"credentials into goals, hints, or messages — bind the content and grant it via " +
		"env {alias: 'value_name'} (the child receives it in scope), or reference it as " +
		"⟦name⟧. Retry without the secret."
	);
}
