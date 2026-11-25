// Class strings every view shares, written as whole literals so Tailwind finds them; Hermes.app measurements in comments.

/** Text roles. 13 px UI text, 11 px chrome, 15 px titles; tertiary text is for secondary facts only. */
export const text = {
	/** Page title: 15 px / 600, tight. */
	title: "text-md font-semibold tracking-[-0.01em] text-fg",
	/** Section heading inside a page: 13 px / 600. */
	heading: "text-base font-semibold text-fg",
	/** Small uppercase label above a group or a fact (Hermes tab and group labels): 11 px / 500. */
	label: "text-xs font-medium uppercase tracking-[0.06em] text-fg-3",
	/** Running text on pages: 13 px secondary. */
	body: "text-base text-fg-2 [overflow-wrap:anywhere]",
	/** Strong running text: 13 px primary. */
	strong: "text-base text-fg [overflow-wrap:anywhere]",
	/** Descriptions under a row title: 12 px tertiary. */
	description: "text-sm text-fg-3 [overflow-wrap:anywhere]",
	/** Meta facts (times, counts, sources): 11 px tertiary, tabular numbers. */
	meta: "text-xs text-fg-3 tabular-nums",
	/** Inline code or identifiers: mono 12 px. */
	mono: "font-mono text-sm text-fg [overflow-wrap:anywhere]",
	/** A big number in a stats strip: 18 px / 600. */
	stat: "text-lg font-semibold tabular-nums text-fg",
} as const;

/** Buttons: 28 px high, 12 px / 500, 2.5 px radius, 14 px icons; 44 px targets on touch. */
export const buttons = {
	primary:
		"inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-sm bg-accent px-2.5 text-sm font-medium whitespace-nowrap text-on-accent transition-colors duration-100 hover:bg-accent/88 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:px-4",
	secondary:
		"inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-sm bg-fill px-2.5 text-sm font-medium whitespace-nowrap text-fg transition-colors duration-100 hover:bg-stroke-3 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:px-4",
	ghost:
		"inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-sm px-2 text-sm font-medium whitespace-nowrap text-fg-2 transition-colors duration-100 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:px-3",
	/** Only inside a confirmation dialog, never in a row. */
	danger:
		"inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-sm bg-danger px-2.5 text-sm font-medium whitespace-nowrap text-on-accent transition-colors duration-100 hover:bg-danger/88 disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-11 pointer-coarse:px-4",
	/** A link-like text action inside running text or a callout. */
	link: "inline-flex min-h-6 items-center gap-1 rounded-xs text-sm font-medium text-accent underline-offset-2 hover:underline pointer-coarse:min-h-11",
	/** 24 px icon-only button (Hermes chrome icons); give it a `srOnly` name. */
	icon: "inline-grid size-6 shrink-0 place-items-center rounded-xs text-fg-3 transition-colors duration-100 hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50 pointer-coarse:size-11",
} as const;

/** Form fields: 28 px, field fill, hairline that turns accent on focus. */
export const fields = {
	input:
		"h-7 w-full min-w-0 rounded-sm border border-stroke-2 bg-field px-2.5 text-base text-fg transition-colors duration-100 hover:border-stroke-1 focus:border-accent pointer-coarse:h-11 pointer-coarse:text-[16px]",
	/** Hermes SearchField: borderless with a leading icon, an underline appears on focus. Wrap the input in `searchWrap`. */
	searchWrap:
		"flex h-8 min-w-0 flex-1 items-center gap-2 border-b border-stroke-3 text-fg-3 transition-colors duration-100 focus-within:border-accent hover:border-stroke-2 pointer-coarse:h-11",
	search:
		"h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-3 [&::-webkit-search-cancel-button]:hidden pointer-coarse:text-[16px]",
	label: "text-sm font-medium text-fg-2",
} as const;

/** Rows. Nav rows are the sidebar's 28 px rows; list rows are flat page rows with no dividers (spacing instead). */
export const rows = {
	nav: "group flex h-7 w-full min-w-0 items-center gap-2 rounded-xs px-2 text-left text-base font-medium text-fg-2 transition-colors duration-100 hover:bg-hover hover:text-fg aria-[current=page]:bg-fill aria-[current=page]:text-fg pointer-coarse:h-11",
	list: "flex min-w-0 items-start gap-3 rounded-sm px-3 py-2.5 transition-colors duration-100 hover:bg-hover max-sm:gap-2 max-sm:px-2 pointer-coarse:py-3",
	/** The icon column of a list row: 16 px glyph aligned with the first text line. */
	listIcon: "mt-0.5 grid size-4 shrink-0 place-items-center text-fg-3",
	listMain: "flex min-w-0 flex-1 flex-col gap-0.5",
	listTitle: "text-base font-medium text-fg [overflow-wrap:anywhere]",
	listTrailing: "flex shrink-0 items-center gap-1.5 self-center",
	/** A list of rows: `ul` with this class, `role="list"`. */
	group: "m-0 flex list-none flex-col gap-px p-0",
} as const;

/** Surfaces. Hermes groups with whitespace and one hairline; avoid cards inside cards. */
export const surfaces = {
	/** A bordered group (settings-style), for rows or facts that belong together. */
	panel: "rounded-md border border-stroke-3 bg-card",
	/** Inner padding of a panel. */
	panelBody: "px-4 py-3 max-sm:px-3",
} as const;

/** Page layout for non-chat pages: one centered reading column, header then sections. */
export const page = {
	scroll: "min-h-0 flex-1 overflow-y-auto",
	column: "mx-auto flex w-full max-w-[52rem] flex-col gap-8 px-6 pt-6 max-sm:gap-6 max-sm:px-3 max-sm:pt-4",
	header: "flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2",
	section: "flex min-w-0 flex-col gap-3",
	sectionHeader: "flex min-h-6 min-w-0 items-center justify-between gap-3",
} as const;

/** Small status words (Hermes Badge): 20 px, 11 px / 500. */
export const tags = {
	neutral: "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs bg-fill px-1.5 text-xs font-medium whitespace-nowrap text-fg-2",
	accent: "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs bg-accent/10 px-1.5 text-xs font-medium whitespace-nowrap text-accent",
	ok: "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs bg-ok/10 px-1.5 text-xs font-medium whitespace-nowrap text-ok",
	warn: "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs bg-warn/10 px-1.5 text-xs font-medium whitespace-nowrap text-warn",
	danger: "inline-flex h-5 shrink-0 items-center gap-1 rounded-xs bg-danger/10 px-1.5 text-xs font-medium whitespace-nowrap text-danger",
} as const;

/** 6 px state dots (status bar, rows); pair with a word, never alone. */
export const dots = {
	idle: "size-1.5 shrink-0 rounded-full bg-ok",
	working: "size-1.5 shrink-0 rounded-full bg-accent animate-pulse",
	waiting: "size-1.5 shrink-0 rounded-full bg-fg-3",
	attention: "size-1.5 shrink-0 rounded-full bg-warn",
	blocked: "size-1.5 shrink-0 rounded-full bg-danger",
} as const;

/** Callouts (Hermes error card): 4.8 px radius, tinted fill, 30 % border, 12 x 16 padding. */
export const callouts = {
	danger: "flex min-w-0 gap-2.5 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-fg max-sm:px-3",
	warn: "flex min-w-0 gap-2.5 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-fg max-sm:px-3",
	info: "flex min-w-0 gap-2.5 rounded-lg border border-stroke-2 bg-soft/40 px-4 py-3 text-sm text-fg max-sm:px-3",
} as const;
