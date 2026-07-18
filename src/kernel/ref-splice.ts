/**
 * $ref splice engine (sap spec §2). A string primitive argument whose entire
 * value (after trimming surrounding whitespace) is ⟦name⟧ resolves to the full
 * bound content at execution time, below the model. Pure module: no I/O — the
 * resolver is injected. A miss is a loud tool error, never a silent literal.
 */

/**
 * Frozen allowlist: $ref is accepted only in pure-content arguments.
 * exec commands, fetch URLs, file paths, grep patterns, apply_patch bodies: no
 * — arguments that address or act must keep transiting the authoring model's
 * context (and path constraints parse paths from the raw argument).
 */
export const REF_SPLICE_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	["write_file", new Set(["content"])],
	["edit_file", new Set(["old_string", "new_string"])],
]);

export function refAllowedFor(primitiveName: string, argName: string): boolean {
	return REF_SPLICE_ALLOWLIST.get(primitiveName)?.has(argName) ?? false;
}

export type RefArgClassification =
	| { kind: "ref"; name: string }
	| { kind: "near_miss"; name: string; form: string }
	| { kind: "plain" };

/**
 * Canonical whole-arg reference: ⟦name⟧ (U+27E6/U+27E7) wrapping the value-name
 * charset (sap spec §1 Naming: [a-z_][a-z0-9_], max 64 chars), nothing else.
 */
const REF_PATTERN = /^⟦([a-z_][a-z0-9_]{0,63})⟧$/;

/**
 * Bracket-lookalike wrappings models actually produce in place of ⟦name⟧.
 * These are loud errors only when the inner name is in scope — an out-of-scope
 * wrapping is genuine content (agents legitimately write [[link]] markdown).
 */
const LOOKALIKE_PATTERNS: readonly RegExp[] = [
	/^\[\[(.+)\]\]$/su, // [[name]]
	/^〚(.+)〛$/su, // 〚name〛
	/^⟬(.+)⟭$/su, // ⟬name⟭
	/^«(.+)»$/su, // «name»
	/^⦃(.+)⦄$/su, // ⦃name⦄
	/^⟨⟨(.+)⟩⟩$/su, // ⟨⟨name⟩⟩
	/^⟦⟦(.+)⟧⟧$/su, // ⟦⟦name⟧⟧
	/^⟦([a-z_][a-z0-9_]{0,63})$/, // ⟦name (missing closer)
	/^([a-z_][a-z0-9_]{0,63})⟧$/, // name⟧ (missing opener)
];

/**
 * Classify a string argument value against the ⟦name⟧ reference syntax.
 * A valid whole-arg ⟦name⟧ classifies as "ref" whether or not the name is in
 * scope — resolution decides existence, and unknown names error loudly there.
 */
export function classifyRefArg(
	value: string,
	inScopeNames: ReadonlySet<string>,
): RefArgClassification {
	const trimmed = value.trim();

	const ref = REF_PATTERN.exec(trimmed);
	if (ref?.[1] !== undefined) {
		return { kind: "ref", name: ref[1] };
	}

	// Real ⟦…⟧ brackets around anything that is not a valid name (internal
	// whitespace, uppercase, leading digit, empty): the model clearly attempted
	// a ref, so a silent passthrough would be the exact corruption the spec
	// forbids. Loud regardless of scope.
	const attempted = /^⟦(.*)⟧$/su.exec(trimmed);
	if (
		attempted?.[1] !== undefined &&
		!/^⟦⟦.+⟧⟧$/su.test(trimmed) // double brackets classify via lookalikes
	) {
		return { kind: "near_miss", name: attempted[1].trim(), form: trimmed };
	}

	for (const pattern of LOOKALIKE_PATTERNS) {
		const name = pattern.exec(trimmed)?.[1];
		if (name !== undefined && inScopeNames.has(name)) {
			return { kind: "near_miss", name, form: trimmed };
		}
	}

	return { kind: "plain" };
}

export type SpliceResult =
	| { ok: true; args: Record<string, unknown>; splicedNames: string[] }
	| { ok: false; error: string };

function allowlistSummary(): string {
	const entries: string[] = [];
	for (const [primitive, argNames] of REF_SPLICE_ALLOWLIST) {
		for (const argName of argNames) {
			entries.push(`${primitive}.${argName}`);
		}
	}
	return entries.join(", ");
}

function scopeSummary(inScopeNames: ReadonlySet<string>): string {
	if (inScopeNames.size === 0) {
		return "no names are in scope";
	}
	return `names in scope: ${[...inScopeNames].sort().join(", ")}`;
}

/**
 * Splice ⟦name⟧ references in a primitive's arguments. Returns a new args
 * object with allowlisted refs replaced by resolved content, or a loud error
 * for unknown names, near-miss syntax, and refs in non-allowlisted arguments.
 * splicedNames lists every name actually spliced so the integration layer can
 * re-run path constraints on the resolved arguments (frozen spec rule).
 */
export async function spliceRefArgs(input: {
	primitiveName: string;
	args: Record<string, unknown>;
	inScopeNames: ReadonlySet<string>;
	resolve: (name: string) => Promise<string | null>;
}): Promise<SpliceResult> {
	const { primitiveName, args, inScopeNames, resolve } = input;
	const out: Record<string, unknown> = {};
	const splicedNames: string[] = [];

	for (const [argName, value] of Object.entries(args)) {
		if (typeof value !== "string") {
			out[argName] = value;
			continue;
		}

		const classification = classifyRefArg(value, inScopeNames);

		if (!refAllowedFor(primitiveName, argName)) {
			// A whole-arg ⟦name⟧ where splicing is not accepted must not pass
			// through as a literal command or path — that is silent corruption.
			// Near-misses here are ordinary content and pass through.
			if (classification.kind === "ref") {
				return {
					ok: false,
					error:
						`$ref is not accepted in ${primitiveName}.${argName}; ` +
						`$ref is accepted only in: ${allowlistSummary()}`,
				};
			}
			out[argName] = value;
			continue;
		}

		switch (classification.kind) {
			case "ref": {
				const content = await resolve(classification.name);
				if (content === null) {
					return {
						ok: false,
						error:
							`$ref ⟦${classification.name}⟧ in ${primitiveName}.${argName} ` +
							`does not match any name in scope; ${scopeSummary(inScopeNames)}`,
					};
				}
				out[argName] = content;
				splicedNames.push(classification.name);
				break;
			}
			case "near_miss": {
				return {
					ok: false,
					error:
						`"${classification.form}" in ${primitiveName}.${argName} looks ` +
						`like a $ref but is not the canonical syntax; write exactly ` +
						`⟦${classification.name}⟧ (U+27E6 name U+27E7, whole argument); ` +
						`${scopeSummary(inScopeNames)}`,
				};
			}
			case "plain":
				out[argName] = value;
				break;
		}
	}

	return { ok: true, args: out, splicedNames };
}
