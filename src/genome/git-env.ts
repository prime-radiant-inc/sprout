const GIT_REPO_SELECTION_ENV_VARS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_PREFIX",
	"GIT_SUPER_PREFIX",
] as const;

export function sanitizeGitEnv(baseEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	for (const key of GIT_REPO_SELECTION_ENV_VARS) {
		delete env[key];
	}
	return env;
}
