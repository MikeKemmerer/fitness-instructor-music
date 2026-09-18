# Fitness Music Player

Private household fitness-class PWA. Public code, private music.

## Workflow Review

September 17 source changes add a dedicated **Playlists** workspace with
local-first saving, numbered/duration song rows, preview transport, compact levels
and the shared Add track menu. Routine deletion is visible in its footer and
chooser. **Settings > Uploaded audio** manages song/filler metadata, upload and
preview; unused-only logical deletion requires the server activation gate in
[api/README.md](api/README.md#admission-and-activation-gate). This implementation
is still undergoing integration and remote verification, not a release receipt.
The [filler-engine recommendation](docs/third-party-assets.md#filler-production-recommendation)
does not introduce new bundled music or change saved sound IDs.

September 16: [current user instructions](docs/user-guide.md) and the
[R01-R24 acceptance checklist](docs/plan.md#unified-routine-acceptance-r01-r24)
describe the unified Routine changes: implemented in source, awaiting remote
verification. One Routine contains every enabled class phase, cue and content
level. One Save commits locally first, then attempts Cloud synchronization;
queued saves remain pending until acknowledged. Publish is still separate.
The [earlier workflow review](docs/workflow-review.md) and older plan sections
are historical. This source update is not a deployment receipt. Use Azure for
the interactive handoff and check the installed app's footer build timestamp.

## Current Milestone

The cloud workflow is deployed on Azure Static Web Apps Free with managed Node 22 Functions and private Blob storage. Individual username/password accounts and roles are configured only in server settings; there is no Microsoft-account requirement or public registration. Hosted builds use `VITE_HOSTED_PILOT=true`; ordinary local builds do not require sign-in. The user has created two accounts and confirmed successful sign-in. Physical device acceptance remains pending. See [Deployment and account setup](infra/README.md).

Choose routines on **Routines** (the Edit workspace); **Teach** contains playback,
not library selection. Location and Status checkbox menus support multiple selections,
with Favorites only and Refresh cloud in one toolbar. Successful Open hides the chooser and its
filters; Open different routine opens a searchable modal without moving the editor.
Cancel or Escape keeps the current routine; switching with unsaved edits offers
Save, Discard changes or Cancel. The selected title has Last saved,
revision, Draft/Published and ID metadata; unavailable historical timestamps say
Unknown. Recoverable drafts sits directly below that metadata. Routine/playlist
choices and notices omit revision numbers; internal revision checks remain.
New routine is available only with no routine open; More actions > Duplicate to new routine
creates an independently named complete copy with fresh entry/cue IDs.

The aligned editor toolbar contains Undo/Redo, save status, one Save button and
More actions. Lock/unlock, publication and deletion are contextual commands in
More actions. Cross-routine replacement has its own explicit dialog, not a second
Save control. Track order > Add track offers From audio library and Import audio.
Share beside the title opens the existing Excel/PDF exports. These layout changes
await remote screenshot review; no local preview is started on this workstation.

One Routine contains walk-in songs, pre-routine filler, set list/cues/per-gap filler,
post-routine filler, walk-out songs, levels and crossfades. The single hosted
**Save** first saves that full value durably on this device, then attempts
Cloud synchronization. **Saved on this device / Cloud sync pending** survives close/
reload and may finish on reconnect once the same user/role is revalidated. Later
unsaved edits are not implicitly uploaded. Failed/conflicted Cloud writes retain
the local copy; no forced overwrite. The standalone build uses **Save** in the
same slot and never contacts Cloud. Import alone does not upload.

Publish remains a separate explicit action creating an immutable revision; it
does not change an already-prepared class. Locks and stale-revision checks still
apply to owners/editors; playback-only accounts use publications. Opening/restoring
a selected routine and returning to Teach after edits automatically prepare its
complete audio, silently. Replacing playing audio requires confirmation. Cloud
refresh alone does not replace playback. Retry preparation appears only after a
preparation failure; there is no normal manual Prepare step. Transfers use authenticated chunks, not
public music URLs. These unified changes await remote verification and a new
release receipt; the earlier Azure deployment does not establish their availability.

Server sessions last 12 hours. Ordinary expiry marks cloud access as requiring sign-in without stopping music, redirecting, purging downloads or disabling local class controls. Previously admitted prepared classes remain usable when offline or expired. Explicit sign-out or account switching is different: it invalidates other tabs and removes this app's private browser data. Offline copies cannot be remotely revoked. Keep the foreground app open during class; crash/reload recovery and real iPhone/Bluetooth reliability are not established by desktop tests.

The standalone local build does not contact Azure or Plex and has no cloud login. Browser imports stay in this browser's IndexedDB; choosing a file does not upload it anywhere.

- Two generated demo songs, explicit local imports, or **From Audio Library** alongside Import audio in Routines and Settings playlists. Online owner/editor browsing reads metadata pages first; offline browsing offers only known audio with matching cached bytes/hash, not the entire Cloud catalog. Selected songs append in selection order with fresh IDs, empty cues and no duplicate upload. Preview is available after insertion, not inside the picker.
- Settings > Demos > Disable demos hides and blocks demo loading on this device. The preference survives reloads and never deletes existing routines or audio.
- Class readiness shows the exact prepared phase queue and offers a guarded sound audition plus manual speaker/power checks. It never claims to detect the physical speaker automatically.
- One Undo/Redo pair covers the complete Routine, including phase choices, media insertions, cues and Apply analysis. Save rebases history rather than erasing it; undo never reverses server locks/publications or deletes audio. Settings playlists keep independent history. Bounded local Recoverable drafts include legacy recoveries; Restore creates a separate draft, never overwrites a saved Cloud revision. Only explicitly saved pending work can sync later; Publish remains explicit.
- Saved routines, independent duplication, local lock/unlock, and revision conflicts between tabs.
- Drag tracks by their header grips on Routines, including touch dragging with automatic scrolling. Move up/down buttons and grip arrow keys remain available. Cues, audio and gains move together; returning to Teach prepares valid edits, with confirmation before replacing playing audio. Escape or dropping outside the track list cancels the move. Locked, published and playback-only views cannot reorder tracks.
- Current/next move, cue markers, elapsed/remaining times, body-area notes and cue sheet.
- Timestamp, manually aligned musical-count, and per-song elapsed-time cue markers.
- Bordered track groups, per-song preview with cue markers and Add cue beside the progress bar, time-ordered rows, optional per-cue beeps and confirmed cue deletion. Enter timestamp/interval values as `m:ss.s` or plain seconds; count cues remain numeric.
- Local estimated BPM/first-beat suggestions with signal normalization, multiple analysis windows and octave checks. Actual generated demo audio is browser-tested at 100/120 BPM. Apply only after review; manually correct ambiguous music.
- Unknown imported/reused song BPM stays blank, including the optional BPM field in Settings playlist entries; timestamps and elapsed-second cues work without it. Count cues require valid BPM/First beat. Existing genuinely known values are preserved, including historical 100 BPM values with no reliable default provenance.
- Practice progress seeking and draggable/keyboard-adjustable cue markers on matching unlocked drafts; playback-only Class Mode with larger next-move text, source-song attribution and countdown.
- Independent periodic, per-second countdown and single remaining-time warning beeps; coincident alerts merge.
- Deterministic filler: none, timed, or hold until Continue; crossfades, speech-volume reduction and separate beep controls. Hold shows a blank read-only duration, retaining Timed timing internally. Sound labels include actual source duration in parentheses; shorter sounds repeat to the timed duration or until Continue/phase advance without changing recorded tempo.
- Song/filler/Settings-playlist content gains use 0-125% sliders with percentage readouts underneath, normal color through 100% and a red transition above it. Adopted walk-in/out songs have their own sliders in the Routine; changing them does not edit the source playlist. 100% is unity. Legacy stored gains above 125% are preserved and visibly warned until explicitly adjusted, not silently clamped; the adjustment is undoable. Remote interaction and layout acceptance remain pending.
- Each song's header Filler action can inherit the routine default, disable its gap, or configure its own sound, level, mode and crossfade.
- The four Class sequence checkboxes and existing crossfades remain. Phase sections have matching spacing before/after Track order, separated from Routine name. Choose distinct saved playlists, configure held filler, adjust adopted song levels, Save once, then Teach and wait for automatic preparation. Walk-in repeats until explicit advance; walk-out plays once. Settings alone manages reusable playlists. Adoption copies a saved playlist into the Routine; later library changes require explicit reselection and Save.
- Footer Close routine offers Save/Discard changes/Cancel. A durable local save with Cloud pending permits close; local-save failure blocks it. Confirm stopping active audio. Completed Close releases playback and clears active Edit/Teach selection, not saved routines, pending work or audio.
- Stop rewinds the current song silently, preserving its phase and later queued music. Previous restarts the song, or selects the previous song in that list when pressed within its first second. Both controls work in Practice and Class Mode.
- Full-track BS.1770/EBU R128 loudness measurement is separate from recommendations: -8 LUFS reference, +/-3 LU deadband (-11 to -5, inclusive). Normal songs stay at 100%. Quiet outliers target -11, capped at 1.25 and available -1 dBFS sample-peak headroom; headroom at or below unity means no boost, not forced attenuation. Loud outliers target -5 with the smaller of desired gain and headroom. Clipping-risk warnings remain separate. Apply is explicit; raw measurements are hash-checked against current audio and recommendations recomputed. This is not a true-peak limiter or a promise of perfectly equal or clip-free mixes.
- Recorded **Lo-fi instrumental (CC0)** filler is pinned at measured 120 BPM with moderate confidence and a plausible half-time 60 reading; its 16-second audio stays at original tempo/pitch. Synthetic built-ins display their generator BPM without analysis. No recorded BPM matching/time-stretch is applied.
- Settings filler library: add, preview, analyze BPM with confidence/manual Apply, analyze level, and remove custom recordings. BPM metadata is separate from immutable audio; inconclusive values stay unknown. Hosted choices are Cloud-wide; standalone choices are device-local. Removal archives without breaking saved references or deleting audio.
- Share icon beside the routine title opens Excel/PDF choices with existing field/filename dialogs. Both export locally without uploading data or including audio; Share is not Save or Publish.
- Global and inline operational error text expires 30 seconds after its latest occurrence, with deadline checks when a background tab becomes visible. Replacement/dismissal/disposal cancels stale timers; validation, pending saves, authentication and playback safety state remain in force. Decision dialogs do not expire.
- Light/dark, seven accent colors, high contrast and adjustable progress height; US English.
- Production offline shell and stored audio, with manual resume after an in-page interruption.
- Blob-backed HTTP API for owner/editor/player roles, immutable publication and ETag-conditional locks/saves, plus secure cookies, CSRF, bounded login throttling and conservative storage quotas. Current account configuration must retain an enabled owner. Historical in-memory domain services remain test-only.

**Not ready to rely on for a live class until rehearsed on the actual iPhone/tablet and Bluetooth speaker.** Desktop tests cannot establish iPhone audio memory, wake-lock, interruption or offline reliability.

## Run Locally

This resource-limited development workstation uses Azure for interactive testing.
Do not start or restore a local preview here. The commands below are for a separate
development environment with adequate resources; browser suites also start local
servers and require explicit approval on this workstation.

Node **22.12+** and npm are required. From this project directory:

```sh
npm ci
npm --prefix frontend ci
npm run dev
```

For the service worker/offline experience, build and use the production preview instead:

```sh
npm run build
npm --prefix frontend run preview -- --host 0.0.0.0 --port 5190 --strictPort
```

On that separate machine, open `http://127.0.0.1:5190/`. On Routines, choose New routine,
Load demo or Import audio, edit cues/phases and Save on this device. Open Teach,
wait for automatic preparation, then Play. Wait for the offline status in Settings
to be ready and reload once before testing offline. Do not change origin between
preparation and playback: browser data belongs to that origin.

Development and preview bind to all interfaces. On a trusted LAN, use the host machine's LAN address and the chosen port, not `localhost` on the phone. WSL2 NAT may also require Windows port forwarding/firewall configuration; binding alone does not guarantee phone reachability. No firewall or forwarding changes are made automatically. Remote mobile testing needs a trusted HTTPS origin for service workers, secure crypto and offline preparation; plain LAN HTTP is not equivalent to localhost. Do not expose this unauthenticated local rehearsal to the public internet.

See [Phone testing from Windows/WSL](docs/local-testing.md) for scoped forwarding and optional `REHEARSAL_HTTPS_CERT` / `REHEARSAL_HTTPS_KEY` configuration. The app now reports an HTTPS requirement instead of starting with unavailable secure-context APIs.

In Routines, expand a song and use Play preview, seek, and Add cue while listening.
Detect BPM uses multiple analysis windows and proposes a first grid-aligned beat,
not a guaranteed bar downbeat; Apply BPM and first beat updates both fields.
Under Between tracks, choose **Lo-fi instrumental (CC0)** and **Preview filler**
for an eight-second audition. Its BPM is read-only because it plays at original
tempo. Synthetic presets use the editable BPM control. No saved sound is silently replaced.

## Export Cue Sheets

Use **Share** beside the routine title on Routines. Choose **Export Excel cue sheet** or **Export PDF packet**, select fields in that format's dialog, choose a filename, then Download. Each format retains its own selection for the open page. Cancel/Escape does not download; explicit sign-out cancels pending exports. The Excel file contains typed numbers/booleans and literal text rather than formulas, sorted by song order and computed cue time. Cue-less songs remain represented, and invalid/incomplete rows are flagged rather than omitted. Empty-routine exports retain selected routine settings on the Overview sheet.

PDF creates a US Letter packet using only selected fields, with paginated tables, wrapped notes and page numbers. Deselecting a field also excludes it from overview/headings; wide selections are split into readable tables. Both formats export the named editor snapshot (including unsaved edits when indicated), not an older prepared playback snapshot. Locks do not block read-only exports. Files contain private notes, so keep downloads private.

PDF uses a bundled Noto Sans font, including validated Latin/Greek/Cyrillic text. Unsupported characters produce an explicit error; Excel preserves arbitrary Unicode. Once the production offline shell is ready, neither format requires a network service. See [Bundled asset licenses](docs/third-party-assets.md).

Practice seeking changes transport only; dragging a cue changes the matching unlocked draft and its prepared snapshot, and requires saving to the displayed destination to persist. Class Mode disables practice seeking/dragging and hides editing/navigation. Native fullscreen is requested where supported, with a viewport-filling fallback elsewhere; Exit Class Mode restores navigation without resetting playback. Routine locks still allow auditions, playback and personal sound/display controls.

## Filler Library

Use **Settings > Filler library** to import a named recording, preview it, refresh the cloud list, or confirm removal. Owners/editors manage the shared library; playback-only accounts use recordings referenced by published routines. The standalone library belongs only to this browser. Built-in sounds remain separate and are not deleted by library removal.

On Routines, choose the recording in default/per-song/pre/post filler and set its
level and timed/hold behavior. Recordings repeat at original pitch/tempo; arbitrary
uploads may click at loop boundaries and are not automatically made seamless.
A cold preview first prepares the recording, then asks for another tap to start
audio. Automatic routine preparation downloads missing selected recordings before
declaring readiness; fully prepared playback needs no network requests.

Removing a filler hides it from future library choices but retains its immutable audio and metadata for saved, locked, published and already-running routines. Such routines display their retained selection; no fallback sound is substituted. Removal does not reclaim billed storage or refund upload reservations. Physical unreferenced-asset cleanup remains separate future work. Input limits match song intake: 32 MiB source, six minutes, mono/stereo; normalized cached/cloud bytes can reach 128 MiB subject to decoded-memory checks. Browser and decoder overhead exceed that decoded-input limit; real device testing is required.

The current workspace has Node 18 as its default. Without changing the machine default, prefix each npm command with:

```sh
npx --yes --package=node@22 --package=npm@11 npm
```

For a permitted non-server check, for example:
`npx --yes --package=node@22 --package=npm@11 npm run typecheck`.
This version wrapper does not authorize a local server or browser suite here.

## Private Song Intake

Cloud preparation fetches up to two audio chunks concurrently across the page's
libraries, assembles them in order, and verifies the complete SHA-256 before caching.
Cached, verified audio is reused without downloading. This reduces per-request waiting
without changing authentication, chunk-size limits or server quotas; actual speed still
depends on the connection and storage/API response time.

An explicitly approved cloud-media compaction creates new M4A assets and media-entry
IDs while preserving cues, order and levels in a new routine revision. After such a
migration, reopen the cloud routine before editing; a stale draft should conflict
rather than overwrite the migration. Existing device caches are not remotely erased.
Retiring old cloud history and deleting its WAVs requires separate confirmation and
a verified private rollback backup; routine deletion alone is not a storage cleanup.

Put your two selected test songs in **local-media/incoming/**. This folder, processed outputs and private import manifests are ignored. The complete tree is excluded from Git, Docker build context and the Vite development server. Import selected files using the browser's file picker; the local folder is never publicly served or automatically uploaded.

Current local import limits: **32 MiB per file, six minutes per track, mono/stereo**, and browser-supported decoding. These conservative limits are for the audio-memory spike; report longer songs before preparing the full class. The schema's broader maximum is not a promise that every file can be imported by this initial runtime.

New Opus imports, and supported audio formats that cannot be played directly, are converted locally to **AAC-LC in M4A, targeting 256 kbps at 48 kHz**, preserving mono/stereo channels. This applies to songs and custom fillers. A four-minute track is roughly 7.7 MB at the target bitrate, not the roughly 46 MB of the former stereo PCM fallback. Actual AAC bitrate varies with content. Conversion is lossy; original files on disk remain untouched. Existing saved WAVs and immutable Cloud downloads are not automatically converted.

Natively playable MP3, M4A, WAV, ADTS AAC, Ogg, FLAC and audio-only WebM retain their encoded bytes and bitrate. New Opus imports always use the M4A fallback, including Opus in supported containers. Video, protected/DRM content, multiple audio streams, unsupported codecs and out-of-bounds audio fail explicitly. The local encoder's supported formats are listed in [Bundled asset documentation](docs/third-party-assets.md). No music is sent to a conversion service; cloud upload remains an explicit action after local validation.

Conversion requires the bundled codec to be available, then runs in a serialized worker. After the offline shell is ready, it can run without a network connection. Source input stays limited to 32 MiB, output to 16 MiB, duration to six minutes and equivalent decoded audio to 128 MiB; long stereo tracks may reach the decoded limit before six minutes. Source metadata counts toward the source-file limit, but large Opus tags are not treated as decoded audio. Conversion has a five-minute deadline; stalled native validation reports an error and prevents overlapping native decoders until the earlier operation settles. Physical low-memory iPhone testing is still required.

The small audio-only encoder is distributed with its pinned notices, license and corresponding source. Codec resources are hash-verified in the offline cache; the larger source archive is available for download but is not cached for playback. This adds no cloud worker or paid hosting tier and does not change account permissions. See [Bundled asset documentation](docs/third-party-assets.md) for source/build details and licensing limitations.

Source files remain intact. Saved routines reference immutable local audio IDs; deleting a track from a draft does not delete its audio. Choose the exact 14-song order explicitly when expanding the rehearsal. No private songs, filenames, manifests, artwork or browser traces from real-media sessions belong in GitHub releases or CI artifacts. Test traces/screenshots are gitignored and must use synthetic fixtures.

## Verify

The commands below are for remote CI or another adequately resourced machine,
not this workstation: full suites include real browser/native/WASM work and start
servers. Here, use only separately authorized serial, memory-bounded non-server
checks. The documentation-only update ran no commands or browser suites.

The latest supplied Fonda result reports **644 passing tests**. This docs pass did
not rerun them; that result does not establish remote CI or new browser/native/WASM
acceptance. Completed read-only Cloud calibration succeeded for **14 of 14 songs**:
12 normal at unity, one quiet at unity because it cannot safely be boosted, and
one quiet capped at 125%. Only non-identifying numerical aggregates are documented.
All 24 acceptance checks remain unchecked awaiting remote CI; no new deployment
or physical-device acceptance is claimed.

```sh
npm test -- --maxWorkers=1
npm run typecheck
npm run build
npm run check:privacy
npx playwright install chromium
npm run test:e2e -- --workers=1
```

Browser tests start their own production preview on port 5191 (override with `E2E_PORT`). Tests use generated audio and the exact licensed public filler, never household music. The BPM test also requires installed Chromium because it exercises real Web Audio filtering. Privacy checks inspect paths, licensed asset hashes and exclusions; they are not a comprehensive secret/content scanner. Review artifacts and staged changes before any public publication.

## Remaining Work

- Complete the [R01-R24 remote acceptance gates and remaining limits](docs/plan.md#unified-routine-acceptance-r01-r24), including new browser/native/WASM loudness validation. Local/Cloud mirrors can still appear separately, favorites are browser-session scoped, and the picker has no pre-insertion preview. No new deployment or physical-device acceptance is claimed by these docs.
- Live authenticated validation of new editor/filler workflows and physical device rehearsal. No Table, Entra, Standard upgrade or always-on worker is required by this milestone.
- Server-synced personal/device presets remain future work. Local-only locks are not authenticated access control; hosted cloud mutations enforce server roles, revisions and locks.
- Continuous work/rest schedules, standalone timed instruction blocks and mixed primary-cue conflict handling. Current interval cues are single per-song elapsed markers, not a workout sequencer.
- Saved BPM bridges, verified musical phrase/downbeat analysis and pitch-preserving song tempo variants. Browser BPM/first-beat detection is an estimate, not a substitute for rehearsal/manual correction.
- Durable playing-position checkpoints across reloads/crashes, wake-lock/device testing, storage cleanup and full backup/restore tooling. Cue-sheet Excel/PDF downloads are implemented, not a full media backup.
- Plex playlist import as a one-time snapshot into a new routine, not synchronization. Later Plex changes do not alter routines or cues. It will not block the uploaded-song path.
- Real two-song phone rehearsal followed by the complete 14-song class. No unsupported feature will silently appear enabled.

The isolated Free Azure host, private storage and budget alerts already exist.
Deployment does not upload household songs. The user approved commit/push/merge/
deployment of the unified changes only after green gates; this documentation pass
does none of those operations and provides no new deployment receipt. The known
source-archive HTTP packaging issue remains separate from runtime codec checks.
Budget alerts are not a hard cap. Maximum Cloud file size is 128 MiB; source
imports stay at 32 MiB, six minutes and mono/stereo. The conservative 5 GiB allocation
counts staging, permanent copies and failed attempts; usable music capacity is
below 2.5 GiB. Pending routine Save intent is durable across reloads; individual
upload-transfer recovery still has page-scoped limits. Do not confuse those records
or assume every failed transfer completed remotely.

For a hosted installation, use **Settings > Sign out** before another household member uses this browser. Sign-out removes this app's local songs/routines/preferences and offline caches, and invalidates other open app tabs. A different signed-in identity must clear the previous local library before entry. Original files on disk are not deleted. Previously admitted offline playback remains available during a network outage; cached identity markers are not DRM or server credentials. Existing localhost data does not migrate automatically to a new Azure HTTPS origin.

## Project Documents

- [Initial implementation contracts](docs/contracts.md)
- [Product plan and delivery gates](docs/plan.md)
- [Backend security core and its trust boundary](api/README.md)
- [Squad responsibilities](docs/squad.md)