/** Read text from the system clipboard. macOS only (uses pbpaste). */
export async function readClipboard(): Promise<string> {
	try {
		const proc = Bun.spawn(["pbpaste"], { stdout: "pipe" });
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return text;
	} catch {
		return "";
	}
}
