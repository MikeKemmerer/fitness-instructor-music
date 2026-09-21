# SWA Free Shared API

## September 16 Unified Routine Verification And Release

This procedure supersedes historical preview-restoration runners below. Never
start or restore a local preview or browser suite on this workstation. The parent
integrates and authorizes Git operations; these helpers do not modify Git state.
No new resources, account changes, tier changes or private-media operations are
part of verification or release.

### Remote CI

[Verify](../.github/workflows/verify.yml) runs on pull requests, pushes and manual
dispatch, using a GitHub-hosted Ubuntu runner and Node 22.23.2. Root, frontend and
API use separate `npm ci` lockfiles. No dependency/build/browser cache is uploaded
or restored. Chromium and its OS libraries, FFmpeg/ffprobe and the runner's
OpenSSL/tar support synthetic tests. Existing pinned public codec assets and
corresponding source remain mandatory; no runtime codec download or core upgrade.

[The runner](verify-azure-only.mjs) runs typechecks, a fresh API build and the
complete API/security suites, local build/privacy/full root tests, full existing
Playwright suite, an isolated hosted build, full hosted root tests, infra tests
and fresh API staging, sequentially. Vitest has one thread worker and no file
parallelism; Playwright has one worker, no retries and forbids focused tests.
Hosted artifacts use `HOSTED_TEST_DIST`; source fixtures keep
`VITE_HOSTED_PILOT=false`. Worker markers discriminate both modes. The hosted
policy requires every existing named case plus all newly registered cases to
pass, not exactly 15. Only the four named private opt-in comparisons may skip;
local mode additionally defers hosted cases with their exact build sentinel.
The historical migration-handler opt-in remains disabled in infra tests.

The complete existing browser suite contains desktop/mobile viewport and touch
cases; this is Chromium coverage, not a Safari/WebKit or physical iPhone claim.
The artifact includes only a source-hashed summary and bounded top-level PNG
screenshots with desktop/mobile evidence. Never upload raw logs, traces,
`test-results/**`, application bundles, API dependencies, caches or `local-media/`.
This is a fresh synthetic CI workspace, not a general secret/content scanner.
Permissions are `contents: read`; no Azure credentials, OIDC permissions or
deployment action are present. A green check is not deployment approval.

After the parent has integrated and published the approved branch, run:

```sh
gh workflow run verify.yml --ref feature/unified-routine-editor
gh run list --workflow verify.yml --branch feature/unified-routine-editor --event workflow_dispatch --limit 5
RUN_ID='<selected-run-id>'
gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json headSha,event,conclusion,url
CI_SHA='<that-successful-runs-headSha>'
CI_DIR="local-media/deployment/ci-$RUN_ID"
gh run download "$RUN_ID" --name "synthetic-verification-$CI_SHA" --dir "$CI_DIR"
export CI_RECEIPT="$PWD/$CI_DIR/summary.json"
node infra/verify-azure-only.mjs --assert-source "$CI_RECEIPT"
```

Manual dispatch requires this workflow to exist on the default branch; before
that, use its push/pull-request run after parent integration. Select the actual
run explicitly, not an unrelated older green run. For pull requests, the receipt
and artifact name use `GITHUB_SHA`, which can be the synthetic merge commit.
Verify GitHub provenance, run identity and reviewed commit independently before
trusting a downloaded receipt. `--assert-source` compares every recorded input
with current source but does not authenticate a supplied JSON document, approve a
commit or approve the newly rebuilt deployment bytes. Changed inputs require a
new green CI run; there is no skip/reuse flag that overrides this comparison.

### Fresh Local Checks And API Stage

Use the already-installed Node **22.23.2** and reviewed npm CLI, putting that Node
binary first on `PATH`. No `npx` downloads or installs are needed here. With all
source owners finished and the source frozen:

```sh
export NPM_CLI="$(readlink -f "$(command -v npm)")"
unset PRIVATE_AUDIO_DIR MIGRATION_LIVE_API_DIRECTORY REHEARSAL_HTTPS_CERT REHEARSAL_HTTPS_KEY
export RELEASE_REPORT_NAME='unified-routine-reviewed-01'
export RELEASE="$PWD/local-media/deployment/$RELEASE_REPORT_NAME"
node infra/verify-azure-only.mjs --assert-source "$CI_RECEIPT"
flock /tmp/fim-unified-check.lock node infra/verify-azure-only.mjs --checks
flock /tmp/fim-unified-check.lock env VITE_HOSTED_PILOT=true npm --prefix frontend run build
flock /tmp/fim-unified-check.lock node infra/stage.mjs --offline --replace-stage
npm run check:privacy
node infra/verify-azure-only.mjs --assert-source "$CI_RECEIPT"
node infra/deploy.mjs > "$RELEASE/artifact.json"
```

`--checks` runs fresh non-browser type/API/security/infra checks, builds both
frontend modes, validates the isolated hosted distribution and checks privacy.
It creates a new ignored report directory and records `NON_BROWSER_CHECKS_ONLY`;
it cannot substitute for the remote full-suite receipt. It never starts servers,
installs packages, stages production dependencies or restores previews. Local
children have a 768 MiB V8 heap cap; CI test children use 2048 MiB. These are heap
limits, not measured total process/browser/native memory limits.

[API staging](stage.mjs) is the existing owner; there is no stage-api.mjs.
`--offline` validates the old production dependency tree against the current
manifest/lock and checks the installed esbuild version, then ALWAYS invokes a new
API build and copies the new functions bundle into a fresh validated stage. It
does not reuse the old API bundle or old API artifact hash. Only generated stage
contents are replaced, and failed preparation preserves the previous stage.
Missing dependencies or a changed lock fail closed: arrange a fresh online stage
on approved CI rather than installing here or bypassing validation. Regular
`node infra/stage.mjs` retains fresh locked installs for CI only in this workflow.

Inspect the new frontend/API inventories and combined hash in `artifact.json`.
The CI build has its own timestamp/hash; do not substitute that hash or a prior
release hash for this newly built candidate. API bytes cannot be omitted merely
because an earlier release reused an unchanged API stage. Existing installed
dependency trees are prerequisites, not independently re-proven npm integrity by
the offline path; the full fresh CI installs remain required evidence.

### One Approved Upload And Live Verification

After parent security/artifact review and the explicit release gate, set
`REVIEWED_ARTIFACT_SHA256` to the literal new combined hash, and set the existing
approved `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `SWA_NAME` and
`SWA_EXPECTED_HOSTNAME`. The existing pinned SWA CLI 2.0.10/native uploader and
Azure login must already be available; do not install or provision implicitly.

```sh
export REVIEWED_ARTIFACT_SHA256='<literal-new-reviewed-combined-sha256>'
node infra/verify-azure-only.mjs --assert-source "$CI_RECEIPT"
mkdir "$RELEASE/upload-attempt" && node infra/deploy.mjs --deploy-approved
node infra/verify-azure-live.mjs
```

The exclusive directory prevents a blind second upload using this release name.
Do not remove it or select a new name to bypass a failed/uncertain upload; inspect
the existing attempt first. The existing deployment entry point uses
`uploadApprovedArtifact`, revalidates the literal artifact hash and exact existing
Free target, and keeps the scoped token in the child environment only. None of
these commands belongs in the automatic verification workflow.

[Live verification](verify-azure-live.mjs) is standalone and read-only: all public
files/root hashes, seven anonymous/spoofed API denials, provider/private/config
404s and security headers. It uses the unchanged strict codec MIME/size/hash/
encoding validator for all six licensed resources, records all failures and
writes one ignored `live.json`. It never imports browser/server release helpers,
uploads, starts previews or restores them. API denial probes do not establish
authenticated production v2 behavior; actual account and physical-device
acceptance remain parent/user gates.

**Static Web Apps response-shape rules.** Two platform behaviours are fixed and
must be designed around rather than asserted away:

1. A compound archive suffix such as `.tar.gz` is split into a base type plus
   `Content-Encoding`, so the archive does not download intact. The
   corresponding source is therefore published as a single-extension `.zip`
   served as `application/zip`, and
   [validateCodecRoutes](licensed-codecs.mjs) rejects any compound suffix.
   Binary types are passed through untransformed; only text types are
   compressed.
2. `/.auth/me` is served by the platform and cannot be routed to 404, unlike
   `/.auth/login/*` which can. Both sign-in providers are blocked, no client
   code reads `clientPrincipal`, and the API rejects spoofed
   `x-ms-client-principal` headers, so the endpoint can only ever report a null
   principal. Live verification therefore probes the provider routes, not
   `/.auth/me`.

Pricing assumptions remain the existing SWA Free/private-storage design and the
USD 30 total budget including about 40 songs. No new spending or billing
measurement was made; GitHub-hosted execution/artifact minutes and storage are
subject to the repository account's allowance. Seven-day, at-most-32-MiB PNG
evidence is a configured cap, not measured billing.

## Current Release Status

The approved compact-media migration completed and its independent receipt
verified all retirement keys absent, new M4A references preserved, all maintenance
leases resolved, the API returning no-store JSON 401, and the private rollback
backup retained. The retry reused the existing quota reservation without another
charge. No migration recovery or further media writes are pending.

Evidence: [migration receipt](../local-media/migration-barre-20260915-applied-02/final-migration-receipt.json).
The bounded parallel downloader and AAC/class workflows were uploaded. Both the
initial upload and a configuration-only correction completed, but full live
verification still failed on the corresponding-source archive MIME response.
That deployment verification remains unresolved; do not rerun the media migration.

The subsequent class-control visibility, Stop/Previous and demo-setting changes
are local source changes, not deployed updates. Class controls passed runtime/UI,
desktop, full offline class and focused hosted-browser checks. Publishing this
repository to GitHub does not deploy its contents to Azure. A future deployment
requires a fresh reviewed artifact and successful live verification, including
the archive response. Reports linked here are private local evidence excluded
from GitHub. Earlier status entries below are historical.

## Earlier September 15 AAC Release Gate (Historical)

The fresh sequential release run passed root, frontend and API typechecks and
the API build. The dedicated API suite passed 116 of 118 tests; both native
AAC/WebM preservation cases at `api/testing/cloud-api.test.ts:930` timed out
under the existing 15-second test limit. The prior persisted-JSON prototype
comparison failure is resolved. No timeout or assertion was changed by the
infra executor. The API owner must resolve these failures before release.

The runner stopped before the remaining suites, frontend builds, API staging
or candidate approval. **No code upload occurred.** Production remains the
previous Opus release below. The existing local preview on port 5290 still
serves the exact precheck local-mode build; no verification runners remain.
No private songs were read or converted, and no resource, settings, account
or Git-state changes were made. The allowed source directory was available,
but optional private-file testing was not reached.

Evidence: [final summary](../local-media/deployment/aac-drag-release-20260915-final/final-summary.json)
and [API gate log](../local-media/deployment/aac-drag-release-20260915-final/api.log).
The codec handoff below is historical: SW/privacy/config integration is now
present, but passing earlier scoped checks does not replace the unfinished
final local/hosted release gates or authorize an upload.

## AAC Codec Distribution Handoff (Historical)

Status: infra gates updated; parent SW/privacy/config integration and executable
verification remain pending. No terminal, native build, tests, Azure, settings or
Git operations were run during this resumed infra pass. Editor diagnostics found
no errors in the edited JavaScript files. The 20 passing conversion tests and
root/frontend typechecks are prior evidence from
[the local handoff](../local-media/audio-codec-handoff.json), not new test results.

The canonical reviewed manifest is [licensed-codecs.json](licensed-codecs.json),
not a second manifest under docs. Its six pins are unchanged. The implementation
is [licensed-codecs.mjs](licensed-codecs.mjs); existing regression coverage is
[licensed-codecs.test.mjs](licensed-codecs.test.mjs). Deployment inspection checks
both current source files and the built distribution against these same pins.
All six artifacts must ship together, including corresponding source; only the
five `cache: true` artifacts belong in the offline shell.

| Artifact | Bytes | SHA256 |
| --- | ---: | --- |
| [JS glue](../frontend/src/assets/codecs/ffmpeg-audio-core.js) | 81,943 | `9ccec78786ef9d9ed1bbdfe6af56218ab7dfe1b6aae066c8324c36f07ee40df9` |
| [WASM](../frontend/src/assets/codecs/ffmpeg-audio-core.wasm) | 2,460,050 | `978adc54750b888c10b605105bfc22a99ea46ee2b255dad43ccd045e4b90fdf2` |
| [Corresponding source](../frontend/public/sources/ffmpeg-audio-core-v1-source.zip) | 19,529,334 | `e19b7e519780021da06e5e9c51908a27526c9dda2d130b18768cbe8e11a013c0` |
| [Full notices](../frontend/public/licenses/ffmpeg-audio-core-v1-NOTICES.txt) | 771,627 | `1df2000900c82be7ce56c6c0f06d6c3ddc132d0d7afd5a45698319e8d77ce945` |
| [LGPL 2.1](../frontend/public/licenses/ffmpeg-audio-core-v1-LGPL-2.1.txt) | 26,526 | `b634ab5640e258563c536e658cad87080553df6f34f62269a21d554844e58bfe` |
| [SBOM](../frontend/public/licenses/ffmpeg-audio-core-v1-SBOM.json) | 5,439 | `e6eae0ea84bf25707d7aea5c161f75b0f9aefbba788147dde77a5fa3ad07bf11` |

The SBOM declares FFmpeg 5.1.4 at commit
`4729204c17f756e186d622060088371d10b34f7e`, the pinned wrapper overlay,
Emscripten/runtime sources and SDK inputs. GPL, nonfree, version3 and threading
are disabled. The reviewed archive is library source only: full FFmpeg source,
SDK/build material, wrapper overlay and required Emscripten/runtime source with
unrelated third-party test media stripped, not a household-media export. This
pass enforces the archive hash; it did not independently re-extract or recompile
it. Full notices and LGPL redistribution obligations remain applicable; this is
not an application-license determination, patent assurance or claim of an
independent second bit-identical compile. Never restore the old full GPL
`@ffmpeg/core` package, its approximately 32 MB WASM, or references to it.

### Parent-Owned Patches

No permission to edit outside infra was granted. The following are integration
requirements for the parent, not changes already made by this pass.

1. In [the static configuration](../frontend/public/staticwebapp.config.json),
  insert this exact route before the final catch-all:

  ```json
  { "route": "/sources/ffmpeg-audio-core-v1-source.zip", "allowedRoles": ["anonymous"] }
  ```

  Add `".wasm": "application/wasm"` and `".zip": "application/zip"` to
  `mimeTypes`, retaining every existing mapping. Keep `/assets/*` and
  `/licenses/*` anonymous, inheriting the existing `nosniff` header. JS must be
  JavaScript, notice/license text `text/plain`, SBOM `application/json`.
  Do not add `Content-Encoding: gzip` to the source archive: the downloadable
  file itself is gzip. No wildcard archive/source route, redirect, rewrite or
  authentication gate for these six public artifacts. Preserve the exact
  AAD/GitHub/me blocks, API routing, CSP and all other security headers; no
  cross-origin-isolation/platform setting is needed.

2. In [the privacy script](../scripts/check-privacy.mjs), reuse the module APIs:

  ```js
  import { codecManifest, validateCodecDistribution, codecCacheEntries } from '../infra/licensed-codecs.mjs';
  ```

  Collect all regular files from public and the source codec directory using
  repository-relative source keys, rejecting symlinks. Validate this map with
  `{ location: 'source', required: true }`. Validate the complete dist map with
  build-relative keys and `{ required: true }`. Each returns an approved
  `Map<path, artifact>` only after complete path/size/SHA256 validation. Use
  membership in those maps as the sole additional source/build exception;
  preserve private-path, secret-review, ignore and exact licensed-loop checks.
  Include archives and standalone WASM in tracked/public path rejection unless
  that exact path and bytes were reviewed. Never broadly allow `.gz`, `.wasm`
  or all files under sources/licenses/codecs. Do not add the source archive to
  Vite's `assets` list: the deployment gate now rejects that precache path.

3. In [the Vite build hook](../frontend/vite.config.ts) and
  [the service worker](../frontend/public/sw.js), the parent can inject
  `self.REHEARSAL_CODECS = codecCacheEntries(approvedBuild)` after validating
  the fresh build, alongside the existing build/hosted flags. Exact schema:

  ```ts
  type CodecCacheEntry = { path: string; bytes: number; sha256: string; mimeType: string };
  ```

  These five descriptors use fresh manifest-emitted hashed JS/WASM paths and
  the three fixed license paths, never guessed Vite hashes. The module is
  Node-only: serialize its plain values; do not import Node code into the SW.
  Treat this as a build-produced allowlist, not runtime-supplied authority.
  The parent chooses and implements this injection contract before release.
  `assetUrl`, `expectedType`, install and fetch handling must recognize only
  those exact descriptors before any generic JS allowance; reject unlisted
  core paths, arbitrary WASM and codec query/traversal variants. Add the three
  notice/license/SBOM URLs to installation and exact fetch matching. Keep
  existing active-class, retirement, sign-out and update behavior unchanged.
  Fetch anonymously without redirects, require HTTP 200 and correct MIME,
  bound decoded bodies by pinned bytes and verify SHA256 before caching any
  of the five. Wire `Content-Length` can differ under HTTP compression;
  decoded length and hash remain mandatory. Normalize headers on reconstructed
  decoded responses. Never fetch, precache or intercept `/sources/` for the
  offline shell, including through a manifest asset or generic fetch handler.
  Keep the small source URL in the cached SBOM/notices available to readers;
  no new Settings UI was requested.

### Remaining Gates

Parent terminal owner: first run the focused existing tests, without compiling
the native encoder again:

```sh
node --test infra/licensed-codecs.test.mjs infra/deploy.test.mjs
```

After parent integration, run privacy, fresh hosted app build and the local
deployment inspection (no approval flag). Test actual SW install/offline AAC
loading with the five exact cache entries and no source download, plus changed
hash, missing license/source, stale GPL reference, wrong MIME/redirect and
unreviewed-media/archive rejection. Reconfirm the unchanged API fingerprint
`b2876af829a66ebadd8c2a33285a9f68ceb11669d529b55d487bcafa99f39869`.
Integrated song/filler callers, preserveBytes cloud imports, cancellation and
track-drag behavior remain their owners' gates. Physical iPhone/Safari/Bluetooth
and actual household-file acceptance are not established by desktop tests.

Only after separate release approval should anonymous live GETs verify all six
resources via `verifyCodecResponse(response, artifact, expectedUrl)`: exact URL,
HTTP 200, no redirects, MIME, `nosniff`, cache headers and bounded SHA256-checked
bodies. The source URL must work without a session alongside the deployed
binary. Do not run the older dated live-release wrapper unchanged for this new
candidate; its report/snapshot paths still identify the historical release.
Production has not been updated for AAC/drag in this pass.

Measured earlier: codec distribution 22,866,987 bytes; offline codec subset
3,345,591 bytes. All source bytes count toward the static environment limit of
250,000,000 bytes. About 30 MB for the integrated static app is an estimate until
a fresh inventory exists; the historical API inventory was 28,737,292 bytes,
validated separately. Pricing assumptions are unchanged: existing SWA Free,
no new resources or always-ready compute, USD 30/month total including about
40 songs. No new billing measurement or price guarantee is claimed.

## September 14 Opus Import Fix

The narrow client candidate fixes a reproduced decoder failure on valid Ogg Opus
metadata spanning multiple pages. It validates the original stream, substitutes
minimal decoder-facing metadata in memory, and preserves audio packets, pre-skip,
output gain and granule timing. Original files remain untouched. This is not a
guarantee that every Opus file is supported.

The exact staged production bundle passed all 13 hosted-browser cases, including
four generated Opus imports: mono/stereo with small and 70,000-byte comments,
under the unchanged shipped CSP. Current root/frontend typechecks passed, all 74
recorded build-input hashes matched, and the existing 246-pass offline report was
verified. Its metadata boundary fixtures cover 65,004, 65,005, 70,000 and 140,000
comment bytes in both channel layouts and assert unchanged source bytes.

Approved combined SHA256:
`da061b7b824bbda49db3cd7a6a33eed10b90d5d4a21afe6bd1093ddc07b431d4`.
Measured inventory: 56 frontend files / 7,185,091 bytes; unchanged API inventory:
4,676 files / 28,737,292 bytes, SHA256
`b2876af829a66ebadd8c2a33285a9f68ceb11669d529b55d487bcafa99f39869`.
Only the existing hash-pinned licensed loop is public audio. Security config,
CSP, decoder payload, API logic and account settings are unchanged.

The single approved upload completed September 15 at 03:07 UTC (September 14
local), with the exact expected hostname receipt. All 55 served candidate files
plus the root hash-matched; applied security headers matched exactly. Session
and routine GET probes returned 401 JSON with no-store; AAD/GitHub login,
private-path and reserved-config probes returned 404 without redirects.
The preserved ordinary local build was restored byte-for-byte; existing ports
5290 and 5208 matched, and the local privacy gate passed. No browser storage was
cleared and no preview daemon was restarted. Ignored operational evidence and
the final handoff are under
`local-media/deployment/opus-production-upload-da061b7b/final-summary.json`.

Close all app tabs/windows, reopen and retry the original import. Do not sign
out or clear site data just to update; those actions can remove cached music.
No real user file, authenticated Azure account flow or physical iPhone/Bluetooth
rehearsal was tested. No provisioning, tier, account, shared-resource or Git-state
changes were made. The USD 30 total planning target, including about 40
songs, is unchanged; no new billing measurement or price guarantee is claimed.

## September 14 Combined Release

The editor/audio polish and shared filler library passed release verification.
The production uploader confirmed one upload to the exact approved existing Free
app, and post-upload public verification passed. All 55 public static files plus
the root matched the approved bytes. Azure consumes `staticwebapp.config.json`
instead of serving it: its required 404 and exact applied security headers passed.
The initial check incorrectly expected that reserved file to return 200; its
failure is retained, and corrected live verification passed without redeployment.
Session, filler-list, unknown-filler and spoofed-principal GET probes each returned
401 JSON `signin_required`, not HTML, 500 or unconfigured 503. AAD/GitHub login and
private-path probes returned 404 without redirects. These are unauthenticated
checks, not proof of authenticated household workflows.

Fresh ordinary local build and privacy gates passed after upload; existing ports
5290 and 5208 serve exact local-mode bytes. Both preserved artifact trees remained
unchanged, and the final process check found zero verification/staging/deployment
runners. Closing all app tabs/windows and reopening allows the waiting service
worker update to activate; do not sign out just to refresh, because that purges
private browser data.
Reviewed combined SHA256:
`a0a52e9970a20ddc010c00fdeae1f6cc71a8b5cdbd9e1a8e1b9027a227fcb3c8`.
The preserved release is `local-media/deployment/editor-filler-library-20260914/`
with separate `frontend/` and `api/`; ignored evidence is in
`local-media/deployment/editor-filler-verification-20260914/`.

Measured artifact inventory: 56 frontend files / 7,184,437 bytes and 4,676 API
files / 28,737,292 bytes. Only the hash-pinned licensed CC0 loop is public audio.
Custom recordings, account configuration and private media are not bundled.
The API stage contains four application/build inputs and locked production
dependencies; its bundle SHA256 is
`ad916bfa8b591f354ea28c99495cb9818f40dedbbdff8f071e5f9d095f50d8ca`.

Node 22.23.2 gates: root/frontend/API typechecks, both builds and privacy checks;
81 API tests; 213 security tests; 314 loudness/filler/offline tests; 1,181 local
root tests with 10 hosted-only skips; 1,190 hosted root tests with no skips,
including nine built-hosted browser cases; all 12 Playwright scenarios on strict
port 5320; and 32 infra tests. All final gates exited zero. Six Settings filler
captures at 320, 390, 768, 844, 1024 and 1440 px use generated audio and fake
storage, not real Azure accounts or household recordings.

Build with `VITE_HOSTED_PILOT=true`, but keep that flag false for standalone
source fixtures during the full root test command. Hosted-browser tests detect
and exercise the hosted artifact independently. The initial leaked build flag
caused standalone fixture failures; those reports are retained, the exact cache
regression passed after isolation, and the entire hosted suite then passed.
No application code or assertions were changed for that correction.

The manifest-listed loudness worker executed offline under the shipped CSP,
retained the exact complete Apache/MIT notices and measured the 1 kHz reference
at -23.000881 LUFS. WASM bytes: 87,519; SHA256:
`a84700a3ca722e8d32283bed6473cffd027d43c75de4093d34de44eb88c2c04d`.
Exact remaining native dependency versions and reproducibility remain unverified,
as documented in the asset notices; no identified permission blocker remains.

No provisioning, SKU/settings/account changes, household uploads or Git-state
changes are part of this release. The USD 30 total planning target, including
about 40 songs, is unchanged; no new billing measurement or price guarantee is
claimed. Authenticated Azure editor/filler acceptance and physical iPhone,
offline and Bluetooth rehearsal remain user-device checks.

Preparation runbook: the commands below require their stated lead/user approvals.
Do not execute writes as documentation checks. The approved existing Free/Custom site
has ARM name `fitness-instructor-music-pilot2` in `rg-fitness-instructor-pilot`,
`westus2`, under the approved Visual Studio Enterprise subscription. It replaces the
original `fitness-instructor-music-pilot` resource, which had a server-side "Failed to
deploy the Azure Functions" fault isolated (2026-09-20) to that specific resource's own
internal state -- confirmed via controlled experiments deploying both a trivial app and
the real production bundle successfully from GitHub Actions to fresh disposable SWA
resources. The replacement shares the same storage account/container and
`FIM_ACCOUNTS_JSON`, so songs/routines/accounts are identical with no data migration.
Its URL is `https://<approved-production-hostname>`; real hostnames, subscription IDs,
IP addresses and credentials belong only in authorized runtime inputs, not tracked
documentation or configuration. Never recreate the site again without the same
lead/user approval this replacement had, or use Standard.

Both helpers require `SWA_EXPECTED_HOSTNAME` from an independently approved operational
record, not automatically copied from the lookup being checked. Before retrieving
secrets, they compare ARM's default hostname exactly, verify the full ARM ID against
the supplied subscription, and enforce the existing resource-group/app-name pins,
enabled subscription/display name, Free SKU, westus2, Custom or SwaCli provider and no repository
link. The hostname pin now lives in the operator environment instead of source; it is
not a domain-only check. The ARM resource-name pins are deliberately unchanged.

Azure changes the provider from Custom to SwaCli after a manual CLI deployment; both
states are accepted, with all other target guards unchanged. Exact 404 rules for
`/.auth/login/aad` and `/.auth/login/github` are required: the wildcard alone did
not disable those reserved provider routes in live testing.

[API README](../api/README.md), [contracts](../docs/contracts.md) and
[cloud contract](../shared/cloud-contract.ts) supersede the historical invitation pilot.
Static code is public; `/api/*` forwards anonymously to the managed Node 22 handler,
which enforces server sessions, roles, Origin, CSRF, throttling and quota. No AAD or
response redirects. Missing/invalid accounts return sanitized 503, not a setup bypass.

## Local Preparation

From the repository root in WSL, replace the tooling placeholders with installed,
reviewed local paths. The terminal defaults to Node 18: prepend Node 22.12+ (<23) for
this shell before any helper. No new wrapper, global install or machine-default change
is needed. `NPM_CLI` is the absolute path to the reviewed npm entry point, also used by
the staging helper; do not assume another machine has the same npm cache path.

```bash
export NODE22_BIN='<absolute-path-to-installed-node-22-bin>'
export PATH="$NODE22_BIN:$PATH"
export NPM_CLI='<absolute-path-to-reviewed-npm-cli.js>'
node --input-type=module -e 'import assert from "node:assert/strict"; const [major, minor] = process.versions.node.split(".").map(Number); assert(major === 22 && minor >= 12, "Use Node 22.12+ (<23)");'
node --test infra/*.test.mjs
node infra/stage.mjs
VITE_HOSTED_PILOT=true node "$NPM_CLI" run build
node "$NPM_CLI" run check:privacy
node infra/deploy.mjs
```

Staging runs API `npm ci`, its workspace-aware build, then a separate production
`npm ci --omit=dev --ignore-scripts --bin-links=false` in ignored
`local-media/deployment/api`. It contains only `host.json`, `package.json`,
`package-lock.json`, `dist/functions.cjs` and locked production dependencies including
external `@azure/functions`. No API source, environment, tests or media enters public
files. Use `node infra/stage.mjs --replace-stage` to explicitly replace the generated
API stage after a new stage validates. Never upload aborted temporary stages.

The release check validates both artifacts and prints their deterministic combined
`artifactSHA256`. Gates include reviewed routing/hosted worker, `node:22`, API entry
and dependencies, static file types, exact licensed public audio, no symlinks/private
paths, and credential-shaped content checks. This is not a comprehensive secret
scanner or proof of authorization. Review both manifests/content and run API/security
and hosted-browser tests. Keep artifacts frozen; never auto-approve a successful hash.
The exact published localhost emulator connection constant in the Blob SDK is exempt
only in private `@azure/storage-blob`, `@azure/storage-common` and the server bundle,
never in public static files.
The API configuration still rejects development storage at runtime.

SWA CLI **2.0.10** must be installed under ignored `local-media/tools`. Its inspected
deploy source sets `SKIP_APP_BUILD=true` and `SKIP_API_BUILD=true` internally; do not
add nonexistent CLI skip-build flags. The native client lives under
`local-media/tools/swa-home/.swa/deploy/`; the official downloader checks SHA-256.
Review its build/checksum before release because upstream stable can change separately
from npm. Native library/ICU failures are blockers, not permission for privileged installs.

## Exact Lead Commands

These commands are prepared, not executed. First use the Node 22 shell setup above.
Supply the approved subscription ID, independently approved production hostname
(no scheme/path) and a globally available new storage account name. These values are
nonsecret, but keep real deployment addresses out of tracked files and chat transcripts.
Do not change Azure's default subscription or infer approval from a successful lookup.

```bash
export AZURE_SUBSCRIPTION_ID='<approved-subscription-UUID>'
export AZURE_RESOURCE_GROUP=rg-fitness-instructor-pilot
export SWA_NAME=fitness-instructor-music-pilot
export SWA_EXPECTED_HOSTNAME='<independently-approved-production-hostname>'
export FIM_STORAGE_ACCOUNT_NAME='<approved-new-lowercase-account-name>'
export FIM_STORAGE_CONTAINER=private-library
export BUDGET_START_DATE=2026-09-01T00:00:00Z
node --input-type=module -e 'import {verifyTarget} from "./infra/deploy.mjs"; await verifyTarget({subscription:process.env.AZURE_SUBSCRIPTION_ID,resourceGroup:process.env.AZURE_RESOURCE_GROUP,appName:process.env.SWA_NAME,environment:process.env}); console.log("Exact existing Free target verified.");'
az deployment group what-if --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_RESOURCE_GROUP" --name shared-api-free \
  --template-file infra/template.json --parameters \
    staticSiteName="$SWA_NAME" \
    storageAccountName="$FIM_STORAGE_ACCOUNT_NAME" containerName="$FIM_STORAGE_CONTAINER" \
    budgetStartDate="$BUDGET_START_DATE"
```

Before a write, the lead also runs server-side template validation using the same
approved environment and parameters:

```bash
az deployment group validate --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_RESOURCE_GROUP" --name shared-api-free \
  --template-file infra/template.json --parameters \
    staticSiteName="$SWA_NAME" \
    storageAccountName="$FIM_STORAGE_ACCOUNT_NAME" containerName="$FIM_STORAGE_CONTAINER" \
    budgetStartDate="$BUDGET_START_DATE"
```

Require unchanged existing Free site and only isolated Hot `Standard_LRS` StorageV2,
Blob service/private container, lifecycle policy and RG budget additions. Stop on
replacement, SKU/unrelated changes, name/policy/provider/offer failure or unsupported
budget scope. No Complete mode, group creation, standalone Functions, Table, managed
identity, Key Vault, private endpoint, paid analytics or always-ready compute.
SWA-managed Functions are part of Free. Storage networking is public for the managed
API, but account/container public Blob access is disabled, HTTPS/TLS 1.2 enforced.

After lead review of what-if and USD budget eligibility:

```bash
az deployment group create --subscription "$AZURE_SUBSCRIPTION_ID" \
  --resource-group "$AZURE_RESOURCE_GROUP" --name shared-api-free --mode Incremental \
  --template-file infra/template.json --parameters \
    staticSiteName="$SWA_NAME" \
    storageAccountName="$FIM_STORAGE_ACCOUNT_NAME" containerName="$FIM_STORAGE_CONTAINER" \
    budgetStartDate="$BUDGET_START_DATE" --query properties.outputs --output json
node infra/settings.mjs --storage-approved
```

Storage mode verifies the actual private account/container, disabled versioning/soft
delete and exact lifecycle before requesting a key. It derives `FIM_ORIGIN` from the
verified ARM default hostname, sets
`FIM_STORAGE_CONNECTION_STRING`, `FIM_STORAGE_CONTAINER`, preserves other settings,
and invents no accounts. Storage settings can be applied before code upload: this
updates the existing SWA control-plane settings, not a running API route. Conversely,
the reviewed API may be uploaded unconfigured: missing/invalid required settings
return sanitized 503 on every route. It stays closed until origin, private storage
and valid accounts including an enabled owner are all configured. Neither ordering
permits an authentication bypass or proves readiness.

## Private Account Setup

The user, not an agent, runs this complete block privately from the repository root
after explicit approval and an existing Azure CLI login. Substitute only nonsecret
tooling/target values below; no storage key or password export is required. Storage
must also be configured before the API can serve authenticated requests.

```bash
export NODE22_BIN='<absolute-path-to-installed-node-22-bin>'
export PATH="$NODE22_BIN:$PATH"
export AZURE_SUBSCRIPTION_ID='<approved-subscription-UUID>'
export AZURE_RESOURCE_GROUP=rg-fitness-instructor-pilot
export SWA_NAME=fitness-instructor-music-pilot
export SWA_EXPECTED_HOSTNAME='<independently-approved-production-hostname>'
node --input-type=module -e 'import assert from "node:assert/strict"; const [major, minor] = process.versions.node.split(".").map(Number); assert(major === 22 && minor >= 12, "Use Node 22.12+ (<23)");' && \
node infra/settings.mjs --accounts-approved
```

Username/role/enabled prompts use normal input; password and confirmation use no-echo.
Enter passwords only at those hidden prompts in the private terminal, never in chat,
environment exports, command arguments or a terminal session observed by an agent.
Blank username finishes. Include an enabled owner. Updates preserve the account ID and
increment authVersion; new IDs are UUIDs. No plaintext password is logged or saved.
Asynchronous UTF-8 scrypt uses N=32768, r=8, p=3, maxmem=50331648, random 16-byte salt
and 32-byte key. Exact `FIM_ACCOUNTS_JSON` schema (1-32 records, <=32768 UTF-8 bytes):

```text
{id, username, passwordHash, role, enabled, authVersion}
id: unique stable [A-Za-z0-9][A-Za-z0-9_-]{0,79}
username: unique normalized [a-z0-9][a-z0-9._-]{0,63}
passwordHash: scrypt$32768$8$3$<32 lowercase hex salt>$<64 lowercase hex key>
role: owner | editor | player; enabled: boolean; authVersion: positive safe integer
```

`node infra/settings.mjs --accounts-source-approved` alternatively accepts exactly one
of `FIM_ACCOUNTS_JSON` supplied by a secure local process or `FIM_ACCOUNTS_FILE` pointing
to hashed-record JSON in a user-owned mode-600 Linux file outside the workspace and
`/mnt/`. This replaces the whole list, requires an enabled owner, preserves existing
IDs and requires advancing authVersion on changes. No plaintext password JSON. Never
paste values into chat, shell history or argv. Malformed preexisting account settings
need a separately reviewed private repair; the helper will not guess identities.

Azure output is captured in subprocess memory; application secrets are stripped from
child environments and raw errors withheld. The merged REST body necessarily contains
secrets: it exists only in a mode-600 file inside a mode-700 random directory under
Linux `~/.cache/fitness-instructor-music-private`. Only `@filename` enters `az rest`
argv, with response output disabled. `finally` cleans it after success, failure and
handled termination. SIGKILL/power loss requires private cleanup before retry. Strings
can remain in memory until collection; no secure erasure claim. Do not enable debug
logs, shell tracing, core dumps or credential-bearing platform telemetry.

Serialize settings writers. A second read detects intervening edits but is not atomic
CAS with PUT. Verify SWA settings rollout drains/restarts workers and old sessions are
denied; never promise globally instant revocation or revocation of offline copies.
Both reads use the scoped `az staticwebapp appsettings list` operation with output
captured only in memory. The former REST read path failed against the live site;
the protected mode-600 REST write remains unchanged.

## Approved Upload

Use the same Node 22 shell and approved target variables, including
`SWA_EXPECTED_HOSTNAME`. After reviewing both artifacts, manually approve the combined
hash; settings and code upload have separate approval gates:

```bash
export REVIEWED_ARTIFACT_SHA256='<reviewed-combined-64-hex-digest>'
node infra/deploy.mjs --deploy-approved
```

The helper verifies exact subscription/site/hostname/Free plan, hash and CLI version,
then passes the token only in child `SWA_CLI_DEPLOYMENT_TOKEN`, never argv/files:

```text
node <cli> deploy <absolute-frontend-dist>
  --app-location <absolute-frontend-dist> --swa-config-location <absolute-frontend-dist>
  --api-location <absolute-local-media/deployment/api> --api-language node --api-version 22
  --env production --no-use-keychain --verbose log
```

No rebuild, source upload, repository link, GitHub secret or CI publication. Captured
uploader output is withheld. Hash approval is an operator interlock, not protection
against another local process changing artifacts during upload. Future CI needs its
own least-privilege OIDC, approval and action-pin review. No images/workflows are
needed for this manual release. Real music upload is an explicit authenticated UI action.

## Retention And Cost

Delete only `<container>/sessions/` base blobs after two days and
`<container>/uploads/` after seven days since modification. Never lifecycle-delete
assets/catalog, snapshots, publications, heads, control/quota or throttle/traffic data.
Versioning, Blob/container soft delete, change feed and restore are disabled. Lifecycle
is asynchronous, not an exact TTL. Owner upload cleanup releases expired slots only,
never byte charges. Before exhaustion, coordinate write-stopped reconciliation;
never reset the ledger or delete referenced immutable content.

API bounds: 5 GiB conservative allocation including 64 MiB overhead and two media
copies, so usable media is below 2.5 GiB; 128 MiB/file; 2 MiB chunks; 64 active uploads;
4,096 lifetime upload allocations; 512 lifetime routines; 20,000 charged mutations.
Forty ordinary songs is a workload target, not a worst-case-size guarantee.

### Local `local-media/` Layout

The ignored `local-media/` tree serves three distinct purposes, and only one of them is
disposable. Write new files into the matching category so cleanup never needs judgement:

| Category | Location | Lifetime |
|----------|----------|----------|
| Private media | `incoming/`, `processed/` | Permanent; never delete or copy out of the tree |
| Evidence | `deployment/<release>/`, `migration-<name>/` | Permanent; upload guards and audit receipts |
| Scratch | `scratch/` | Freely deletable at any time |

Release helpers such as `unified-release.mjs` also live at the top level and are pinned
by hash in each `review.json`, so they are not scratch. Tests that call
`privateDirectory()` must remove the directory they create; an uncleaned test leaks a new
private directory on every run.

## Managed Completion

The current [API media contract](../api/README.md#media-contract-for-client-wiring)
uses resumable empty `POST /api/media/uploads/{id}/complete` requests. HTTP 202 with
`Retry-After: 0` is acknowledged progress, not a CloudAsset:

```text
{pending: true, done: false, phase: 'copying' | 'publishing', copiedChunks, chunkCount}
```

Only HTTP 200 returns the final `{id, sha256, bytes, contentType}` asset. Clients must
branch on status, not just `response.ok`, and repeat the same upload ID with bounded
attempts and elapsed time. Never supply a cursor or treat a 202 as prepared media.
Hashing seals/verifies all chunks before permanent copies; later requests copy at
most eight chunks and checkpoint progress with the same upload-head ETag. A 20-second
cooperative budget yields progress; an unfinished hash returns 503
`finalization_timeout`, while failed Azure I/O returns 503 `storage_unavailable`.
The host timeout remains 45 seconds. No background/always-ready worker or claim that
a 128 MiB upload completes in one HTTP request. Live per-phase timing, recovery and
client handling are lead acceptance gates, not local test measurements.

## Budget Review

Pricing assumptions, not measurements: Free hosting is $0 within quotas; Hot LRS
capacity/operations/egress remain metered. No exact regional quote or billing
measurement is claimed. Total budget is $30/month including roughly 40 songs. The RG
budget uses amount 30 in subscription billing currency and actual thresholds 50/80/100
percent ($15/$24/$30 only if USD). Recipients default to the Owner role. Verify offer
eligibility, recipients and delivery; preserve the budget start date on redeploy.
Alerts can lag and are NOT a hard cap or shutdown. Never silently disable them or upgrade.

The template uses `Microsoft.Consumption/budgets@2024-08-01` at resource-group scope.
`contactRoles` is a valid notification property: each notification supplies the
`budgetContactRoles` array, defaulting to `["Owner"]`, alongside `enabled`,
`operator`, `threshold` and `thresholdType`. It is not a role assignment, account email
or action group. Confirm the intended Owner recipients at that scope; a correctly
shaped template does not prove Azure acceptance or alert delivery.

The `Visual Studio Enterprise` display-name guard is not evidence of the subscription's
billing offer. The lead must verify the actual offer's dev/test/noncommercial usage
terms, RG Cost Management/budget API support and USD billing currency. Credit-backed
offers can have different support; subscription credits/spending limits are not this
RG budget. Run the prepared what-if and validation before provisioning. Unsupported
offer/scope/API/notification errors block the write pending an explicit lead decision;
do not retry by setting `enableBudget=false`, switching subscription or upgrading.

## Verification Records

Observed September 14, 2026: the authorized Incremental deployment succeeded for
the isolated StorageV2 account, Blob service, private container, lifecycle policy
and monthly budget. The existing SWA operation was Read only and its Free/Custom
configuration was verified unchanged. The actual budget is USD 30/month, starting
September 1, with enabled Owner-role actual alerts at 50/80/100 percent. Azure
reported USD 0 current spend at verification; billing can lag and alert delivery
has not been tested. This is not a spending cap or a regional price quotation.

Storage settings were applied after live ACL/lifecycle validation. Readback confirmed
only target-match booleans and absence of accounts; no settings values were printed.
The helper cleaned its private temporary directory. Anonymous Blob list, direct and
range probes returned HTTP 409. The settings-read endpoint fix passed nine focused
tests and all 32 infra tests with no skips; editor diagnostics were clear.

The reviewed release contains 55 public files (7,009,958 bytes) and 4,676 locked API
files (28,729,043 bytes), combined SHA-256
`9e576770da098ddf74d709946b59fa4d144d56e2b150be59095a3f7ad3aaa660`.
Privacy and artifact checks passed; the only public audio matched the licensed CC0
hash. Node 22.23.2 loaded the exact staged bundle and returned the local unconfigured
503 smoke response. SWA CLI 2.0.10 and the cached native uploader checksum were
verified. Public hosted bytes are preserved in ignored
`local-media/deployment/cloud-hosted-20260914`; the separate API stage remains in
`local-media/deployment/api`. Reports stay under ignored `local-media/`.

Production upload completed with the exact expected-host receipt. Ten of twelve live
HTTP checks passed: index, sign-in page/script, entry script and worker returned 200
with bytes matching the reviewed artifact; session, routines and direct/range media
API probes returned exact no-store JSON 503 `unconfigured`; the private local path
returned 404. This confirms managed handler startup, not authenticated storage use.

Two required routing checks failed: `/.auth/login/aad` returned 302 and `/.auth/me`
returned 200, despite the reviewed `/.auth/*` 404 rule. Full acceptance is blocked on
a frontend-owner routing correction and reviewed redeployment; no cross-owner patch,
Standard upgrade or additional resource was attempted. No real provider sign-in was
performed. No account has been created; private user-run owner setup and subsequent
authenticated API/device tests remain separate gates.

After confirmed upload, the ordinary local build and privacy gate passed. The existing
port 5208 preview served `REHEARSAL_HOSTED = false`; no browser data was cleared.
The deployed hosted snapshot and release report remain preserved separately. Do not
inspect/deploy the restored local-mode `frontend/dist` as this hosted release.
A rebuild invalidates the release hash approval.

### Exact-Route Retry: Historical Pre-Upload Block

This attempt is superseded by the completed deployment recorded below.

On September 14, 2026, the hosted frontend was rebuilt from the lead's exact
`/.auth/login/aad`, `/.auth/login/github` and `/.auth/me` 404 entries before the
wildcard. The build and privacy gate passed. The focused routing and built-Chromium
run passed all 14 tests (8 routing, 6 hosted browser; no skips). The existing API
forged-principal rejection test also passed (1 selected, 49 skipped by its filter).
Browser/API fixtures use synthetic accounts and fake Blob storage, not live accounts.

The new public artifact has 55 files / 7,010,125 bytes, SHA-256
`66a1581b3e05a318a9ba2a19d909ff0e9327441d6634556928dfc6a2a47e019b`.
The API stage was not rebuilt and passed validation with the prior release's exact
4,676 files / 28,729,043 bytes and SHA-256
`6bc845001c33d78972cfb99ad77e2701d16af3cb807c9b75cdeb41c9e0a62fd7`.
Combined SHA-256 is
`b81b9bbb0a411ba296336c41e88ac5df0a939bc88b67cefe65f7596203208e5a`.
The snapshot is preserved in ignored
`local-media/deployment/cloud-hosted-20260914-routefix`; its manifest, unapproved
hash report and logs are in the separate `cloud-hosted-20260914-routefix-reports`
directory alongside it. Prior snapshots and reports were not overwritten.

The unchanged `deploy.mjs` local gate exited 1: its status-code allowlist accepts
only `/.auth/*` and `/local-media/*`, rejecting the newly required exact routes.
No hash was approved and no upload was attempted. The lead must authorize or supply
the narrow validator/test correction before retrying. An additional read-only exact
target verification failed with raw output withheld; its cause was not classified,
and no account/login prompt or authentication repair was attempted.

Live observations are a PRE-redeploy baseline, not validation of the new artifact:
root, sign-in page/script and worker returned 200; exact AAD/GitHub login endpoints
returned 302 without following redirects. The reserved `/.auth/me` endpoint returned
200 with exactly a null clientPrincipal, not household authentication; frontend
authentication code has no `/.auth/*` dependency. Session and routines API probes
returned exact no-store JSON 503 `unconfigured`; the private local path returned 404.
Private owner setup remains a separate user-run gate. No Azure resources, settings,
accounts or Git state were changed during this retry.

The ordinary local build and privacy gate were restored successfully. Port 5208
served matching index/worker bytes with `REHEARSAL_HOSTED = false`; every preserved
hosted file still matched its recorded hash. No browser data was cleared. Resuming
release requires restoring the preserved hosted artifact, passing the corrected
release and exact-target gates, then explicitly reviewing and approving its hash.

### Exact-Route Deployment Completed

Observed September 14, 2026, at 20:18 UTC: the already-running approved upload
completed with the exact expected-host receipt. No duplicate upload was launched.
The deployed combined SHA-256 is
`b81b9bbb0a411ba296336c41e88ac5df0a939bc88b67cefe65f7596203208e5a`;
the public and API hashes, counts and sizes are those recorded above. The preserved
hosted artifact was not rebuilt, and the API stage was unchanged. The lead's corrected
validator requires the exact auth rules; target verification accepts Custom or SwaCli
without weakening the subscription, ARM ID, hostname, Free SKU or region pins.
Post-upload verification passed with actual provider SwaCli, Free, West US 2.

Node fetch checks used manual redirects. Both `/.auth/login/aad` and
`/.auth/login/github` returned 404 without Location headers. `/.auth/me` returned
200 with a null clientPrincipal: an informational platform fallback, not household
authentication or private access. The application does not use platform auth.
`/api/auth/session` returned exact no-store JSON 503 `unconfigured`, as expected
before private first-owner setup. The private local-media probe returned 404.
All 54 served artifact files, including the Vite manifest, matched the approved
bytes; `/` also returned 200 with the approved index bytes. The remaining deployment
file is the platform routing config, validated against current source and exercised
through the live route checks; no live API bundle-download verification is claimed.

At 20:19 UTC, after completion and live verification, the uploaded `frontend/dist`
was renamed to ignored `local-media/deployment/cloud-hosted-20260914-routefix-uploaded`,
then the exact `local-before-routefix-upload` backup was renamed into `frontend/dist`.
All 55 local files and directory identity were preserved. The existing port 5208
preview served matching index/worker bytes with `REHEARSAL_HOSTED = false`.
No rebuild, browser-data clearing, Git operation, resource provisioning, settings
change or account creation occurred during this completion. No required deployment
or verification process remained; restoration exited 0.

Sanitized evidence remains ignored under `local-media/`: `routefix-deploy-result.txt`,
`routefix-live-result.json` and `routefix-restore-result.json`. Private user-run owner
setup and authenticated API/storage/device acceptance remain separate gates.

## Remaining Gates

Lead: offer eligibility and budget-alert delivery, private first-owner setup,
settings size/rollout. Upload and unconfigured Node 22 handler startup are observed
above, not proof of authenticated readiness. Live API: HTTPS Set-Cookie, Origin/CSRF,
unauthenticated/spoofed-header rejection, role/version revocation, real ETag conflicts
and recovery, 2 MiB ingress/egress, resumable phases of 128 MiB completion within
managed limits, correct bounded 202 progress handling, lifecycle
deletion, quota and explicit UI-only uploads. Device: real 40-song iPhone offline and
Bluetooth preparation/playback. Unit tests and deployment success do not prove these.

## References

Inspected 2026-09-14: the [SWA runtime table](https://learn.microsoft.com/en-us/azure/static-web-apps/configuration#selecting-the-api-language-runtime-version)
lists Node.js 22 / Linux / Functions 4.x / `node:22`; the API overview still lists
older versions. Use the specific runtime table and require the live managed-host gate.
No Standard substitution on rejection.

- [SWA CLI deploy](https://azure.github.io/static-web-apps-cli/docs/cli/swa-deploy)
- [ARM budgets, including RG scope](https://learn.microsoft.com/en-us/azure/templates/microsoft.consumption/2024-08-01/budgets)
- [SWA quotas](https://learn.microsoft.com/en-us/azure/static-web-apps/quotas)
- [SWA plans](https://learn.microsoft.com/en-us/azure/static-web-apps/plans)