import {
	METACOGNITIVE_OBSERVER,
	ObserverRegistry,
	type ObserverRegistryOptions,
} from "./observer-registry.ts";

export { METACOGNITIVE_OBSERVER };

export type ObserverDispatcherOptions = ObserverRegistryOptions;

export class ObserverDispatcher extends ObserverRegistry {
	constructor(options: ObserverDispatcherOptions) {
		super({
			...options,
			configs: options.configs ?? [options.config ?? METACOGNITIVE_OBSERVER],
		});
	}
}
