import { createResolverSettings, type ResolverSettings } from "../../src/agents/model-resolver.ts";
import type { ProviderModel } from "../../src/llm/types.ts";

interface ResolverClientLike {
	providers(): string[];
	listModelsByProvider(): Promise<Map<string, ProviderModel[]>>;
}

export interface TestResolverContext {
	modelsByProvider: Map<string, ProviderModel[]>;
	providerId: string;
	defaultModelId: string;
	resolverSettings: ResolverSettings;
}

export async function buildTestResolverContext(
	client: ResolverClientLike,
): Promise<TestResolverContext> {
	const providerIds = client.providers();
	const providerId = providerIds[0];
	if (!providerId) {
		throw new Error("Test client must expose at least one provider");
	}

	const modelsByProvider = await client.listModelsByProvider();
	const defaultModelId = modelsByProvider.get(providerId)?.[0]?.id ?? "test-model";

	return {
		modelsByProvider,
		providerId,
		defaultModelId,
		resolverSettings: createResolverSettings(
			providerIds.map((id) => ({
				id,
				enabled: true,
			})),
			{
				best: { providerId, modelId: defaultModelId },
				balanced: { providerId, modelId: defaultModelId },
				fast: { providerId, modelId: defaultModelId },
			},
		),
	};
}
