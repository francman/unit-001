// Shared command and cancellation guidance for both attached terminal interfaces.
export const ATTACH_HELP =
	"/help /status /mission (rich interface: /mission setup) /memory [stats|recall <query>|remember <text>|forget <id>|sleep] /cancel /exit /detach.\n/cancel affects the shared session, including other operators' queued inputs. The cancel key (Ctrl+C by default) cancels while busy or submitting; otherwise it detaches. Detaching leaves admitted work running.";
