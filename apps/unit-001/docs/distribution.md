# Download without an account

Users should download one Linux bundle, extract it, and run `sudo ./install.sh`. The bundle includes Node, application dependencies, public verification keys, and the update-feed address. No GitHub account, download token, signing key, npm install, or manual update configuration is required.

The distribution target is a separate public repository, `francman/unit-001-releases`. The package includes runnable JavaScript and source maps. Git history and repository access remain private. Its stable download URL will be:

```text
https://github.com/francman/unit-001-releases/releases/latest/download/unit-001-linux-x64.tar.gz
```

That URL becomes live after the initial signed release is published. A URL in this document does not mean a release has already been published.

The initial supported target is Ubuntu Server 24.04 LTS on x86-64. After installation, sign in to the chosen model provider and run `sudo agent start`. Public-release updates are already configured and begin with that normal start. `sudo agent update disable` turns them off; existing preferences survive upgrades.

Signing is a maintainer responsibility. Private signing keys stay outside downloads. The offline root authorizes release keys, and the installer carries only public verification data. Users receive authenticated key rotations through the existing update mechanism.

The first installer is trusted through GitHub's HTTPS download channel. The updater downloads public release assets directly over HTTPS, avoiding GitHub API accounts and anonymous API quotas. It verifies signed metadata and artifact hashes before installing updates. A constant download filename provides convenience; automatic updates still use the exact versioned artifact named by signed metadata.

Publication uses a maintainer-only credential scoped to the public release repository. It never publishes the private source repository's Git objects. Release metadata records the signed source revision for provenance, while public release tags point only to the public repository.

Unsigned development bundles remain available for CI and local staging. They do not invent production signing keys or silently enable an unconfigured feed. See [maintainer setup](updates.md#publishing-and-key-custody) for the one-time publication work.
