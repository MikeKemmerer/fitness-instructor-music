# Fitness Music Player

Private household fitness-class PWA. Public code, private music.

## Workflow Review

September 15: [current user instructions](docs/user-guide.md),
[separate workflow review](docs/workflow-review.md), and
[the revised UI/class-session plan](docs/plan.md#september-15-workflow-revision)
describe how to create/share, revise/fine-tune and teach a routine. The guide now
covers implemented silent Class entry, Practice cue editing, per-song fillers and
independent walk-in/announcement/walk-out phases. The review and plan retain their
historical findings. The class-control visibility and Stop/Previous follow-up is
local, not yet deployed; check the installed app's footer build timestamp.

## Current Milestone

The cloud workflow is deployed on Azure Static Web Apps Free with managed Node 22 Functions and private Blob storage. Individual username/password accounts and roles are configured only in server settings; there is no Microsoft-account requirement or public registration. Hosted builds use `VITE_HOSTED_PILOT=true`; ordinary local builds do not require sign-in. The user has created two accounts and confirmed successful sign-in. Physical device acceptance remains pending. See [Deployment and account setup](infra/README.md).

Choose local or household routines on **Edit**; **Teach** contains playback, not library selection. **Save on this device** changes only local storage. **Save to household** updates the current household draft after confirmation; it is not automatic background sync. Owners/editors can explicitly open a published routine's current draft or use **Update existing household routine** to replace a selected draft with confirmation. A new publication is a new immutable revision, not an overwrite of the previous published bytes. Locks and stale-revision conflicts still block changes, including owner changes. Playback-only accounts select published routines without authoring controls. Preparation downloads and verifies the complete selected audio before playback; selection or cloud refresh never replaces an already-playing snapshot. Cloud transfers use authenticated chunks, not public music URLs. Browser-local imports are not automatically uploaded.

Server sessions last 12 hours. Ordinary expiry marks cloud access as requiring sign-in without stopping music, redirecting, purging downloads or disabling local class controls. Previously admitted prepared classes remain usable when offline or expired. Explicit sign-out or account switching is different: it invalidates other tabs and removes this app's private browser data. Offline copies cannot be remotely revoked. Keep the foreground app open during class; crash/reload recovery and real iPhone/Bluetooth reliability are not established by desktop tests.

The standalone local build does not contact Azure or Plex and has no cloud login. Browser imports stay in this browser's IndexedDB; choosing a file does not upload it anywhere.

- Two generated demo songs, or explicit local audio imports in a user-editable order.
- Settings > Demos > Disable demos hides and blocks demo loading on this device. The preference survives reloads and never deletes existing routines or audio.
- Saved routines, independent duplication, local lock/unlock, and revision conflicts between tabs.
- Drag tracks by their header grips on Edit, including touch dragging with automatic scrolling. Move up/down buttons and grip arrow keys remain available. Cues, audio and gains move together; a prepared or playing routine stays unchanged until explicitly prepared again. Escape or dropping outside the track list cancels the move. Locked, published and playback-only views cannot reorder tracks.
- Current/next move, cue markers, elapsed/remaining times, body-area notes and cue sheet.
- Timestamp, manually aligned musical-count, and per-song elapsed-time cue markers.
- Bordered track groups, per-song preview with cue markers and Add cue beside the progress bar, time-ordered rows, optional per-cue beeps and confirmed cue deletion. Enter timestamp/interval values as `m:ss.s` or plain seconds; count cues remain numeric.
- Local estimated BPM/first-beat suggestions with signal normalization, multiple analysis windows and octave checks. Actual generated demo audio is browser-tested at 100/120 BPM. Apply only after review; manually correct ambiguous music.
- Practice progress seeking and draggable/keyboard-adjustable cue markers on matching unlocked drafts; playback-only Class Mode with larger next-move text, source-song attribution and countdown.
- Independent periodic, per-second countdown and single remaining-time warning beeps; coincident alerts merge.
- Deterministic filler: none, timed, or hold until Continue; crossfades, speech-volume reduction and separate beep controls. Saved song and filler gain are independent, non-destructive 0-1.5 multipliers (1 is neutral).
- Each song's header Filler action can inherit the routine default, disable its gap, or configure its own sound, level, mode and crossfade.
- Walk-in / walk-out music beside Prepare opens independent saved playlists and class setups. Prepare both distinct lists, optional before/after announcement loops and the routine together; run every phase without leaving Class Mode. Walk-in repeats until explicit advance; walk-out plays once.
- Stop rewinds the current song silently, preserving its phase and later queued music. Previous restarts the song, or selects the previous song in that list when pressed within its first second. Both controls work in Practice and Class Mode.
- Full-track EBU R128 loudness analysis proposes song gain toward -18 LUFS, limited by a 1.5 boost cap and -1 dBFS sample-peak headroom. Apply is explicit; files and playback timing are unchanged. This is not a true-peak limiter: manual boosts and overlapping mixed audio can still clip. Existing routines keep their previous levels unless edited.
- Recorded **Lo-fi instrumental (CC0)** filler, bundled and verified for offline use. Existing synthetic presets remain unchanged. Recorded tempo/pitch stay original; BPM matching is not applied to this preset.
- Settings filler library: add, preview and remove custom recordings, household-wide in hosted mode or device-local in standalone mode. Removal archives the choice without breaking existing routines or deleting referenced audio.
- Collapsed export section with separate Excel/PDF dialogs, selectable fields and editable filenames. Both export locally without uploading routine data or including audio.
- Light/dark, seven accent colors, high contrast and adjustable progress height; US English.
- Production offline shell and stored audio, with manual resume after an in-page interruption.
- Blob-backed HTTP API for owner/editor/player roles, immutable publication and ETag-conditional locks/saves, plus secure cookies, CSRF, bounded login throttling and conservative storage quotas. Current account configuration must retain an enabled owner. Historical in-memory domain services remain test-only.

**Not ready to rely on for a live class until rehearsed on the actual iPhone/tablet and Bluetooth speaker.** Desktop tests cannot establish iPhone audio memory, wake-lock, interruption or offline reliability.

## Run Locally

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

Open `http://127.0.0.1:5190/`. On Edit, Load Demo or Import Audio, edit cues, Save on this device, then Prepare routine and Play. Wait for the offline status in Settings to be ready and reload once before testing offline. Do not change host/port between preparation and playback: browser data belongs to that origin.

Development and preview bind to all interfaces. On a trusted LAN, use the host machine's LAN address and the chosen port, not `localhost` on the phone. WSL2 NAT may also require Windows port forwarding/firewall configuration; binding alone does not guarantee phone reachability. No firewall or forwarding changes are made automatically. Remote mobile testing needs a trusted HTTPS origin for service workers, secure crypto and offline preparation; plain LAN HTTP is not equivalent to localhost. Do not expose this unauthenticated local rehearsal to the public internet.

See [Phone testing from Windows/WSL](docs/local-testing.md) for scoped forwarding and optional `REHEARSAL_HTTPS_CERT` / `REHEARSAL_HTTPS_KEY` configuration. The app now reports an HTTPS requirement instead of starting with unavailable secure-context APIs.

In Edit, expand a song and use Play Preview, seek, and Add Cue while listening. Detect BPM proposes tempo and the first observed grid-aligned beat in the analyzed opening minute, not a guaranteed bar downbeat; Apply BPM and First Beat updates both editable fields. Under Between tracks, select **Lo-fi instrumental (CC0)** and press **Preview filler** for an eight-second audition of the recording used in rehearsal. Its BPM control is disabled because it plays at original tempo. Synthetic presets still use the BPM control. Saved routines are never silently switched to a different sound.

## Export Cue Sheets

**Edit > Export routine** starts collapsed. Choose **Export Excel cue sheet** or **Export PDF packet**, select fields in that format's dialog, choose a filename, then Download. Each format retains its own selection for the open page. Cancel/Escape does not download; explicit sign-out cancels pending exports. The Excel file contains typed numbers/booleans and literal text rather than formulas, sorted by song order and computed cue time. Cue-less songs remain represented, and invalid/incomplete rows are flagged rather than omitted. Empty-routine exports retain selected routine settings on the Overview sheet.

PDF creates a US Letter packet using only selected fields, with paginated tables, wrapped notes and page numbers. Deselecting a field also excludes it from overview/headings; wide selections are split into readable tables. Both formats export the named editor snapshot (including unsaved edits when indicated), not an older prepared playback snapshot. Locks do not block read-only exports. Files contain private notes, so keep downloads private.

PDF uses a bundled Noto Sans font, including validated Latin/Greek/Cyrillic text. Unsupported characters produce an explicit error; Excel preserves arbitrary Unicode. Once the production offline shell is ready, neither format requires a network service. See [Bundled asset licenses](docs/third-party-assets.md).

Practice seeking changes transport only; dragging a cue changes the matching unlocked draft and its prepared snapshot, and requires saving to the displayed destination to persist. Class Mode disables practice seeking/dragging and hides editing/navigation. Native fullscreen is requested where supported, with a viewport-filling fallback elsewhere; Exit Class Mode restores navigation without resetting playback. Routine locks still allow auditions, playback and personal sound/display controls.

## Filler Library

Use **Settings > Filler library** to import a named recording, preview it, refresh the household list, or confirm removal. Owners/editors manage the shared library; playback-only accounts use recordings referenced by published routines. The standalone library belongs only to this browser. Built-in sounds remain separate and are not deleted by library removal.

On Edit, choose the recording under Between tracks and set its gain and timed/hold behavior for that routine. Recordings repeat at original pitch and tempo; arbitrary uploaded files may click at the loop boundary and are not automatically made seamless. A cold preview first downloads/prepares the recording and then asks for another tap to start audio. Prepare routine also downloads a missing selected recording before declaring readiness; a fully prepared class needs no network requests.

Removing a filler hides it from future library choices but retains its immutable audio and metadata for saved, locked, published and already-running routines. Such routines display their retained selection; no fallback sound is substituted. Removal does not reclaim billed storage or refund upload reservations. Physical unreferenced-asset cleanup remains separate future work. Input limits match song intake: 32 MiB source, six minutes, mono/stereo; normalized cached/cloud bytes can reach 128 MiB subject to decoded-memory checks. Browser and decoder overhead exceed that decoded-input limit; real device testing is required.

The current workspace has Node 18 as its default. Without changing the machine default, prefix each npm command with:

```sh
npx --yes --package=node@22 --package=npm@11 npm
```

For example: `npx --yes --package=node@22 --package=npm@11 npm run dev`.

## Private Song Intake

Cloud preparation fetches up to two audio chunks concurrently across the page's
libraries, assembles them in order, and verifies the complete SHA-256 before caching.
Cached, verified audio is reused without downloading. This reduces per-request waiting
without changing authentication, chunk-size limits or server quotas; actual speed still
depends on the connection and storage/API response time.

An explicitly approved cloud-media compaction creates new M4A assets and media-entry
IDs while preserving cues, order and levels in a new routine revision. After such a
migration, reopen the household routine before editing; a stale draft should conflict
rather than overwrite the migration. Existing device caches are not remotely erased.
Retiring old cloud history and deleting its WAVs requires separate confirmation and
a verified private rollback backup; routine deletion alone is not a storage cleanup.

Put your two selected test songs in **local-media/incoming/**. This folder, processed outputs and private import manifests are ignored. The complete tree is excluded from Git, Docker build context and the Vite development server. Import selected files using the browser's file picker; the local folder is never publicly served or automatically uploaded.

Current local import limits: **32 MiB per file, six minutes per track, mono/stereo**, and browser-supported decoding. These conservative limits are for the audio-memory spike; report longer songs before preparing the full class. The schema's broader maximum is not a promise that every file can be imported by this initial runtime.

New Opus imports, and supported audio formats that cannot be played directly, are converted locally to **AAC-LC in M4A, targeting 256 kbps at 48 kHz**, preserving mono/stereo channels. This applies to songs and custom fillers. A four-minute track is roughly 7.7 MB at the target bitrate, not the roughly 46 MB of the former stereo PCM fallback. Actual AAC bitrate varies with content. Conversion is lossy; original files on disk remain untouched. Existing saved WAVs and immutable household downloads are not automatically converted.

Natively playable MP3, M4A, WAV, ADTS AAC, Ogg, FLAC and audio-only WebM retain their encoded bytes and bitrate. New Opus imports always use the M4A fallback, including Opus in supported containers. Video, protected/DRM content, multiple audio streams, unsupported codecs and out-of-bounds audio fail explicitly. The local encoder's supported formats are listed in [Bundled asset documentation](docs/third-party-assets.md). No music is sent to a conversion service; household upload remains an explicit action after local validation.

Conversion requires the bundled codec to be available, then runs in a serialized worker. After the offline shell is ready, it can run without a network connection. Source input stays limited to 32 MiB, output to 16 MiB, duration to six minutes and equivalent decoded audio to 128 MiB; long stereo tracks may reach the decoded limit before six minutes. Source metadata counts toward the source-file limit, but large Opus tags are not treated as decoded audio. Conversion has a five-minute deadline; stalled native validation reports an error and prevents overlapping native decoders until the earlier operation settles. Physical low-memory iPhone testing is still required.

The small audio-only encoder is distributed with its pinned notices, license and corresponding source. Codec resources are hash-verified in the offline cache; the larger source archive is available for download but is not cached for playback. This adds no cloud worker or paid hosting tier and does not change account permissions. See [Bundled asset documentation](docs/third-party-assets.md) for source/build details and licensing limitations.

Source files remain intact. Saved routines reference immutable local audio IDs; deleting a track from a draft does not delete its audio. Choose the exact 14-song order explicitly when expanding the rehearsal. No private songs, filenames, manifests, artwork or browser traces from real-media sessions belong in GitHub releases or CI artifacts. Test traces/screenshots are gitignored and must use synthetic fixtures.

## Verify

```sh
npm test
npm run typecheck
npm run build
npm run check:privacy
npx playwright install chromium
npm run test:e2e
```

Browser tests start their own production preview on port 5191 (override with `E2E_PORT`). Tests use generated audio and the exact licensed public filler, never household music. The BPM test also requires installed Chromium because it exercises real Web Audio filtering. Privacy checks inspect paths, licensed asset hashes and exclusions; they are not a comprehensive secret/content scanner. Review artifacts and staged changes before any public publication.

## Remaining Work

- Live authenticated validation of new editor/filler workflows and physical device rehearsal. No Table, Entra, Standard upgrade or always-on worker is required by this milestone.
- Server-synced personal/device presets remain future work. Local-only locks are not authenticated access control; hosted cloud mutations enforce server roles, revisions and locks.
- Continuous work/rest schedules, standalone timed instruction blocks and mixed primary-cue conflict handling. Current interval cues are single per-song elapsed markers, not a workout sequencer.
- Saved BPM bridges, verified musical phrase/downbeat analysis and pitch-preserving song tempo variants. Browser BPM/first-beat detection is an estimate, not a substitute for rehearsal/manual correction.
- Durable playing-position checkpoints across reloads/crashes, wake-lock/device testing, storage cleanup and full backup/restore tooling. Cue-sheet Excel/PDF downloads are implemented, not a full media backup.
- Plex playlist import as a one-time snapshot into a new routine, not synchronization. Later Plex changes do not alter routines or cues. It will not block the uploaded-song path.
- Real two-song phone rehearsal followed by the complete 14-song class. No unsupported feature will silently appear enabled.

The isolated Free Azure host already exists; the current release adds only reviewed private storage and budget alerts. No household songs are uploaded by deployment. Source publication, commits and releases remain separate user-controlled steps. Budget alerts are not a hard spending cap. Maximum cloud file size is 128 MiB; local source imports stay at 32 MiB, six minutes and mono/stereo. The conservative 5 GiB allocation accounts for staging plus permanent copies and failed attempts; usable music capacity is below 2.5 GiB. Upload completion is bounded and resumable within the current page; reloading loses its in-memory recovery record.

For a hosted installation, use **Settings > Sign out** before another household member uses this browser. Sign-out removes this app's local songs/routines/preferences and offline caches, and invalidates other open app tabs. A different signed-in identity must clear the previous local library before entry. Original files on disk are not deleted. Previously admitted offline playback remains available during a network outage; cached identity markers are not DRM or server credentials. Existing localhost data does not migrate automatically to a new Azure HTTPS origin.

## Project Documents

- [Initial implementation contracts](docs/contracts.md)
- [Product plan and delivery gates](docs/plan.md)
- [Backend security core and its trust boundary](api/README.md)
- [Squad responsibilities](docs/squad.md)