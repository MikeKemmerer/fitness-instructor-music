# Fitness Instructor Music

Private household barre-class PWA. Public source; never public household music.

- Read docs/contracts.md and README.md before implementation.
- Local-media intake, processed files and manifests live only under ignored local-media/.
- Never copy local-media into frontend/public, dist, images, CI artifacts or GitHub releases.
- No Azure provisioning, production deployment, commits, pushes or PR merges without the lead's authorized gate.
- Node 22.12+, TypeScript, Vite, Vitest, Playwright. Plain DOM UI, no framework required.
- This workstation is resource-limited: do not start or restore local preview/dev servers for this project. Use Azure for the interactive handoff.
- Use serial, memory-bounded build/type checks. Do not run browser suites that launch local servers here without explicit approval; use prior verified evidence or remote CI and disclose validation limits.
- Deployment helpers must not restore or restart a local preview after uploading. Preserve local media and browser data when stopping existing preview processes.
- Use audio time for playback and fixed-seconds exercise clocks; never accumulate UI interval ticks.
- User text is text, never HTML. Runtime tokens/secrets never in localStorage or logs.
- Routine locks must be enforced in API mutations, not only UI controls.
- No section looping, external remotes or extra languages in the initial pilot.
- A passing desktop test does not prove iPhone offline/Bluetooth reliability.
- File owners: Horton shared/root/docs; Simmons player.ts, offline.ts, service worker, worker and audio tests; Fonda other frontend files; Pilates api and security tests; Wicks infra and workflows. Michaels reviews read-only.
- No cross-owner patches while tasks run in parallel. Report required contract changes.
- After the first substantive edit run a focused test before continuing. Report commands/results and remaining limitations.