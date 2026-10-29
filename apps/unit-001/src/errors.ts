/** A command line the user got wrong; the CLI prints the message and a usage hint, and exits with code 2. */
export class UsageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

/** The environment cannot run the agent as asked, for example no model provider is configured. */
export class ConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigurationError";
	}
}
