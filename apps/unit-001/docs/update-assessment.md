# Update patterns from terminal agents

Assessed 7 November 2026. Interactive tools provide useful staging and locking patterns. A continuously running durable service also needs an admission barrier, explicit state compatibility and recovery that survives a broken application.

| Application | Observed behavior | Applied to unit-001 |
|---|---|---|
| omp | Optional detached startup updater, cross-process locks, bounded attempts, per-version backoff, staged binary checks and replacement. Existing sessions keep their loaded version. | Stage away from the running owner; expose status and bounded deferral. Restarting a durable owner requires an additional maintenance protocol. |
| Claude Code | Native background updates, stable/latest channels, disable controls and versioned installations. Installation documentation describes signed checksum verification. | Separate release selection from installation and authenticate before execution. |
| OpenCode v2 | Host configuration selects notify, auto or disabled behavior; the updater uses locking and delegates to the installation method. | Keep update policy under host authority and make enable/disable explicit. |
| Herdr | Stages and probes replacements; independent terminal holders preserve sessions across core replacement. | Keep management and recovery executable independently of the application. |
| Pi | Installer uses versioned locations, a locked dependency install without lifecycle scripts, staged checks and pointer publication. | Preserve reviewed dependency resolution and immutable versioned releases. |

Unit-001 uses TUF for signed freshness and release integrity, a root-owned timer for checks, and a journal for activation. Checksums alone cannot identify an authorized release. A successful executable probe alone cannot establish whether old code can read state written by a new release.

## Primary sources

- omp [auto-update worker](https://github.com/can1357/oh-my-pi/blob/f2bcb520d03c2b9c9d1ca45360b03997efabb723/packages/coding-agent/src/cli/auto-update.ts), [release discovery](https://github.com/can1357/oh-my-pi/blob/f2bcb520d03c2b9c9d1ca45360b03997efabb723/packages/coding-agent/src/cli/build-service.ts), and [replacement logic](https://github.com/can1357/oh-my-pi/blob/f2bcb520d03c2b9c9d1ca45360b03997efabb723/packages/coding-agent/src/cli/update-cli.ts).
- Claude Code [setup and update controls](https://code.claude.com/docs/en/setup).
- OpenCode v2 [configuration](https://dev.opencode.ai/v2/docs/config/) and [updater](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/cli/src/services/updater.ts). This assessment concerns v2; older documentation describes different defaults.
- Herdr [security model](https://github.com/herdrdev/herdr-core/blob/9ce385d9c8abb041dd4437476d770365b3fb5282/docs/security.md) and [update implementation](https://github.com/herdrdev/herdr-core/blob/9ce385d9c8abb041dd4437476d770365b3fb5282/crates/herdr-core/src/cli/update.rs).
- Pi [installation documentation](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/README.md) and [installer](https://pi.dev/install.sh).
- TUF [specification](https://github.com/theupdateframework/specification/blob/master/tuf-spec.md) and [client implementation](https://github.com/theupdateframework/tuf-js).
