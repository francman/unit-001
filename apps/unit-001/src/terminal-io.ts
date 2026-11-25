// The plain terminal I/O shape the line-oriented clients read and write; distinct from pi-tui's `Terminal`.

/** Streams and sinks one client uses; the rich interface takes pi-tui's own terminal instead. */
export interface TerminalIO {
	readonly input: NodeJS.ReadableStream;
	/** Given to readline for line editing; present only when the terminal is interactive. */
	readonly output?: NodeJS.WritableStream;
	readonly out: (text: string) => void;
	readonly err: (text: string) => void;
}
