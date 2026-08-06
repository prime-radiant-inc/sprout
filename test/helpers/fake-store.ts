import type { GrepResult, ManifestDelta } from "../../src/store/store.ts";
import type { StoreAccess, StoreBindInput } from "../../src/store/store-access.ts";
import type { ValueMetadata } from "../../src/store/value.ts";

export interface BoundEntry extends Omit<StoreBindInput, "content"> {
	content: string;
}

/** Fake StoreAccess: records binds/publishes, optionally fails them. */
export class FakeStore implements StoreAccess {
	bound: BoundEntry[] = [];
	published: string[] = [];
	bindError: string | undefined;
	publishError: string | undefined;

	async bind(args: StoreBindInput): Promise<ValueMetadata> {
		if (this.bindError !== undefined) throw new Error(this.bindError);
		const content =
			typeof args.content === "string" ? args.content : new TextDecoder().decode(args.content);
		this.bound.push({ ...args, content });
		return {
			ulid: `ulid_${this.bound.length}`,
			name: args.name,
			scopeId: "scope_test",
			type: args.type,
			size: content.length,
			provenance: args.provenance,
			preview: `${args.type} · ${content.length} bytes`,
			createdAt: 1,
		};
	}

	async publish(ref: string): Promise<void> {
		if (this.publishError !== undefined) throw new Error(this.publishError);
		this.published.push(ref);
	}

	async peek(): Promise<string> {
		throw new Error("not implemented");
	}
	async metadata(): Promise<ValueMetadata> {
		throw new Error("not implemented");
	}
	async get(): Promise<Uint8Array> {
		throw new Error("not implemented");
	}
	async slice(): Promise<string> {
		throw new Error("not implemented");
	}
	async grep(): Promise<GrepResult> {
		throw new Error("not implemented");
	}
	async manifestDelta(): Promise<ManifestDelta> {
		throw new Error("not implemented");
	}
	async registerEnvGrant(): Promise<ValueMetadata> {
		throw new Error("not implemented");
	}
	async claimEnvGrant(): Promise<ValueMetadata> {
		throw new Error("not implemented");
	}
	async recordCell(): Promise<void> {
		throw new Error("not implemented");
	}
	async names(): Promise<string[]> {
		return this.bound.map((b) => b.name);
	}
}
