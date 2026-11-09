# Terminal acceptance evidence for 0.0.5

These images render actual tmux PTY frames through xterm.js. They are source-repository review evidence, not VPS screenshots. Inputs, credentials and service replies use local fixtures; no model request was made.

- [Setup review, 40×12, light](final-setup-40-review-light.png): complete model ID, save action and cancellation controls.
- [Managed chat, 80×24, dark](final-managed-80-dark.png): the 0.0.5 client connected to a scripted service fixture advertising version 0.0.4.
- [Unavailable owner, 40×12, light](final-unavailable-40-light.png): persistent recovery instructions and exit-only actions.
- [Source foreground chat, 40×12, dark](final-source-40-dark.png): the 0.0.5 client around its existing local Agent, with network calls disabled.

Independent acceptance passed 20 real-terminal cases. The complete application run passed 419 Vitest tests, including those 20 cases, and 133 release/management/update tests. Each changed production module and its tests received peer review; Unix CI requires tmux. Native Windows terminal behavior and authenticated provider requests were not exercised locally.
