import { Genome, type GenomeOptions } from "../../src/genome/genome.ts";
import { FakeEmbeddingProvider } from "../../src/llm/embeddings.ts";

export function createTestGenome(
	rootPath: string,
	rootDir?: string,
	options: GenomeOptions = {},
): Genome {
	return new Genome(rootPath, rootDir, {
		embeddingProvider: new FakeEmbeddingProvider(),
		...options,
	});
}
