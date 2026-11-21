// Media-query watchers for the map: the display's pixel ratio, which a resize observer cannot see, and the reduced-motion preference.

/** Calls `onChange` whenever the display's pixel ratio changes (the window moved to another screen, browser zoom). Returns the stop function. */
export function watchPixelRatio(onChange: () => void): () => void {
	let query: MediaQueryList | null = null;
	// A `resolution` query only matches one ratio, so it fires once per change and is armed again for the new ratio.
	const changed = () => {
		onChange();
		arm();
	};
	const arm = () => {
		query?.removeEventListener("change", changed);
		query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
		query.addEventListener("change", changed);
	};
	arm();
	return () => query?.removeEventListener("change", changed);
}

/** Calls `onChange` when the media query starts or stops matching. Returns the stop function. */
export function watchMedia(query: MediaQueryList, onChange: () => void): () => void {
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}
