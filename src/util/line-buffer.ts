/**
 * Incremental newline splitter for a line protocol over stream chunks. Chunks
 * arrive as strings or utf8 bytes (multi-byte sequences may split across
 * chunks); push() returns the complete lines a chunk finished, buffering any
 * unterminated tail for the next chunk.
 */
export class LineBuffer {
	private readonly decoder = new TextDecoder();
	private buffered = "";

	/** Append a chunk and return the complete lines it finished, in order. */
	push(chunk: string | Uint8Array): string[] {
		this.buffered +=
			typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
		const lines: string[] = [];
		let newline = this.buffered.indexOf("\n");
		while (newline !== -1) {
			lines.push(this.buffered.slice(0, newline));
			this.buffered = this.buffered.slice(newline + 1);
			newline = this.buffered.indexOf("\n");
		}
		return lines;
	}

	/** Length of the buffered partial line (for over-cap backstops). */
	get pendingLength(): number {
		return this.buffered.length;
	}

	/** Drop the buffered partial line (an over-cap backstop's reset). */
	discardPending(): void {
		this.buffered = "";
	}

	/** Take the unterminated tail at stream end, emptying the buffer. */
	takePending(): string {
		const tail = this.buffered;
		this.buffered = "";
		return tail;
	}
}
