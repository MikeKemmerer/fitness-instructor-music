# Initial Rehearsal Contract

## Playlist Workspace (September 17)

Playlists is a dedicated workspace beside Routines, not a Settings expando. It
uses the same header, modal chooser, Undo/Redo, Save, More and Close conventions.
Rows show number, title, measured duration, preview transport and 0-125% gain;
Add track offers existing library audio or processed imports. No class sequence,
cues, between-track filler, cue beeps or BPM controls are rendered. Retain stored
BPM and legacy gains unchanged until an explicit supported edit. Playlist and
Routine drafts, selections, history and prepared playback remain independent.
Managing playlists from a routine never silently adopts a new playlist revision.

IndexedDB version 8 adds `playlistWorkingCopies`; reuse `cloudMusicPlaylists`
for immutable Cloud envelopes. `PlaylistWorkingCopy` contains
`{envelope:CloudMusicPlaylist,localVersion:number,cloudBaseRevision:number|null,
pendingCloud:boolean,savedAt:number,cloudAttempt?:{envelope:CloudMusicPlaylist,
localVersion:number,baseRevision:number|null}}`. The timestamp is a local-save
timestamp, not a claimed server save time. The playlist wire format is unchanged.

Offline exports `getPlaylistWorkingCopy(id)`, `listPlaylistWorkingCopies()`,
`savePlaylistWorkingCopy(envelope,{expectedLocalVersion,cloud,cloudBaseRevision})`,
`recordPlaylistSyncAttempt(id,localVersion,envelope,baseRevision)`,
`acknowledgePlaylistWorkingCopy(id,localVersion,envelope)`,
`reconcilePlaylistWorkingCopy(envelope)` and
`deletePlaylistWorkingCopy(id,expectedLocalVersion)`. The signatures and failure
semantics parallel routine working copies, with playlist-specific validation and
`playlist_conflict` errors. Clean reads do not rewrite local save timestamps.
Acknowledgment of exact attempt A may rebase newer local B but cannot discard B.
Publish/lock are still server operations; failed/conflicted Cloud saves remain
locally durable. Local saves remain selectable through the existing local playlist
APIs without confusing local version numbers with Cloud revisions. A playlist
working copy participates in audio-retention checks and explicit account purge.

`ActivePlaylistSelection` is `{id,source:'local'|'household',published,revision?}`;
published selection requires an exact positive revision. Use separate meta keys
through `getActivePlaylistSelection()`, `setActivePlaylistSelection(value)` and
`clearActivePlaylistSelection()`. Save may record its own playlist selection but
must never write Routine selection keys. `listCachedMusicPlaylists()` enumerates
latest draft/publication Cloud envelopes separately; local publications can be
listed through `listMusicPlaylistPublications()`. Publication reads cannot replace
the editable working copy. Close clears only the playlist selection, never media
or saved/pending content. Failed Open and Cancel preserve the current draft.

The playlist save coordinator snapshots all track descriptors before the local
commit, stages uploads separately from committing the Cloud head, and durably
records each attempted envelope before POST/PUT. First Cloud revision is 1 even
after multiple local saves. Replay requires exact attempt/head comparison and
If-Match; unknown remote changes are conflicts, never forced overwrites. Queue
retries only explicitly saved work, bounded and serialized with Routine transfers.
Ordinary expiry preserves local work/playback; explicit logout/account change
invalidates in-flight operations and purges private browser state as before.

Saved playlist snapshots already adopted into routines remain unchanged.

## Uploaded Audio Management (September 17)

Settings owns an Uploaded audio disclosure with Songs and Fillers views, bounded
metadata pages, explicit preview Play/Pause/Stop, title/artist/BPM editing and
multi-file processed upload. Routine deletion is discoverable but uses the existing
revision/lock enforcement and never deletes music bytes. No real user records are
deleted by implementing or testing these controls.

`shared/cloud-contract.ts` defines `LibraryMetadata`, `ManagedAudioItem`,
`ManagedAudioPage`, `LibraryUsagePage` and `LibraryDeleteResult`. Author-only
`GET /api/library/{songs|fillers}?cursor=...` lists completed, non-deleted items.
`GET /api/library/{songs|fillers}/{id}/metadata` returns `{metadata}`;
`PUT` at that path accepts exactly `{title,artist,bpm?}`, with quoted metadata
revision in If-Match (initial revision 0). It returns `{metadata}`. Missing fields
mean unknown, never guessed. Title/artist max300 characters, optional BPM40-220;
metadata max4KiB. Metadata lives separately from immutable audio/recording
descriptors, so existing routine/playlist/filler snapshots never change.

`PUT /api/library/{songs|fillers}/{id}/intake` accepts exactly
`{filename,duration}` once with If-Match:"0" before editable metadata exists;
the server validates basename-only filename max300 and duration0..1200(song) or
0..360(filler), positive finite. Intake stores client-measured duration/original
basename; no claim of independent server measurement. Existing uploads without
these facts stay unknown. Editable metadata PUT cannot overwrite intake facts.
Upload bytes still go through existing bounded conversion/chunk/hash checks;
intake does not authorize or upload arbitrary external media.

`GET /api/library/{songs|fillers}/{id}/usage?cursor=...` returns bounded references
and completeness; it is informational, not deletion authorization.
`DELETE /api/library/{songs|fillers}/{id}` is empty-body, authenticated,
author/Origin/CSRF guarded and metadata-revision conditional. It returns200
`{deleted:true,bytesRetained:true}`,202`{pending:true}` for bounded continuation,
409`media_in_use` or `reference_write_pending`, or explicit fail-closed uncertainty.
DELETE may be repeated only for its same checking operation, never by clearing
a tombstone. User approved logical deletion without storage reclamation for now.

Deletion must BLOCK referenced files, including retained routine/playlist
history/publications, legacy class exact references and filler descriptors. Known
current-device drafts/recoveries also block UI deletion. Cloud cannot inspect
another device's unsynced data; disclose this limit. Future Cloud saves referencing
a deleted item fail explicitly, preserving local work. No physical blob purge.

Per-asset durable CAS admission claims fence reference writes through the
document/filler commit and close admission before the authoritative bounded
deletion scan. No process-local mutex or scan-then-delete race is acceptable.
Uncertain/crashed claims never expire automatically; fail closed until proven
reconciliation. New workers must all enforce this gate before enabling destructive
library operations. Metadata edits use independent CAS and cannot alter descriptors.
Legacy archived filler reads remain supported, but new manager DELETE is unused-only.
Completed-upload replay cannot resurrect a deleted catalog entry. Persist scan
checkpoints and bound request work; unknown/corrupt history is not unused.

Original title/artist tags may be absent; do not invent them. Library edits are
presentation for future selections, not a hidden rewrite of existing snapshots.
For fillers the immutable recording name stays fixed; use catalog presentation in
selection controls without changing its authoritative recording descriptor.
Software/music-engine research does not authorize bundling samples: redistribution
rights and musical quality must be reviewed separately. No ambient-streamer edits,
live synthesis engine, new Azure resources or session-policy changes in this work.

## Unified Routine Revision (September 16)

This section supersedes separate class authoring below. One Routine is the entire
class and one Save persists it locally before synchronizing to Cloud. Variants
are separate named routines. Existing v1 routines, playlists and ClassSetup
snapshots remain readable; never bulk rewrite or delete private data. A v1 client
must not overwrite a v2 routine head and lose its sequence.

The Edit workspace uses sentence-case application labels, a grouped title and
metadata header, one local-first Save, and contextual secondary commands in More
actions. Track order owns the Add track source menu; existing import/picker
handlers retain their identity, limits and history. Open different routine uses
a modal chooser with search and existing filters/favorites. Browsing or dismissing
it cannot change the draft or prepared playback; a failed switch preserves the
current draft. Unsaved switches offer Save/Discard/Cancel. Author legacy-class
conversion requires explicit selection and confirmation, never startup fallback;
player restoration retains exact published class authority. Existing source
records are not deleted or merged by this compatibility change.

`Routine.schemaVersion` accepts 1 and 2; new routines use 2. `sequence` is v2-only:
`{crossfade, walkIn?, before?, after?, walkOut?}`. Walk-in/out are owned snapshots
`{name, tracks, source?:{id,revision,published}}`, not live library references.
Their entries are cue-free, without after-rules, and have globally unique IDs
across the entire routine. The source is provenance only. The Playlists workspace
owns playlist editing; adopting a playlist copies entries into one undoable routine edit.
`allRoutineTracks`, `allRoutineFillers` and `routineClassAudio` are shared helpers.
`CloudRoutine.media` covers exactly every main/walk-in/walk-out track ID. Resolve
all recording descriptors and authorize only the complete published asset union.
The existing 100-track bound applies to the total, not each phase separately.
New MusicPlaylist objects use schema 2; legacy schema 1 remains accepted.

`Track.bpm` may be absent for unknown imported/reused audio. Timestamp and interval
cues work without BPM; count cues require an explicit valid grid. Known stored
100 BPM values are not guessed to be defaults or erased. Synthetic filler tempo
remains numeric. Legacy gain values up to 1.5 remain readable; new slider edits
and suggestions are limited to 0..1.25, preserving older values until explicitly
adjusted. Routine `savedAt?:number` is a save timestamp, never a content edit:
local saves stamp the local commit; Cloud writes stamp server time. Old unknown
timestamps stay unknown. Exclude savedAt from undo content/fingerprints.

Offline exports `RoutineWorkingCopy {envelope:CloudRoutine, localVersion:number,
cloudBaseRevision:number|null, pendingCloud:boolean, savedAt:number}` and:
`getRoutineWorkingCopy(id)`, `listRoutineWorkingCopies()`,
`saveRoutineWorkingCopy(envelope,{expectedLocalVersion:number|null,
cloud:boolean,cloudBaseRevision:number|null})`,
`acknowledgeRoutineWorkingCopy(id,localVersion,envelope)`, `clearActiveRoutine()`.
Save is one identity-fenced IndexedDB transaction over the full snapshot and
pending state with local-version CAS. Never confuse a local version with Cloud
If-Match revision. Acknowledgment clears pending only for the same localVersion;
newer local edits survive. Cloud failures preserve the local copy. Lost responses
require comparison against authoritative head before retrying, not blind POSTs.
No credentials enter these records. Explicit logout purges as before; expiry does
not. Publish/lock/CAS remain server enforced. Save does not autoplay or publish.

Working copies additionally retain an optional `cloudAttempt` containing
`{envelope,localVersion,baseRevision}` before a request can commit remotely.
`recordRoutineSyncAttempt(id,localVersion,envelope,baseRevision)` stores it with
local CAS. Newer local saves preserve an outstanding attempt. Acknowledging a
proven attempt rebases newer pending work onto the returned Cloud revision but
does not clear its pending flag or replace its content. Lost-response recovery
compares the authoritative head with that exact submitted envelope, not only the
newest local edit. An unrelated remote head remains a conflict.
`reconcileRoutineWorkingCopy(envelope)` refreshes an existing CLEAN working copy
after an authoritative read/lock/unlock/publication, preserving its local CAS
version; pending work is never overwritten. `deleteRoutineWorkingCopy(id,
expectedLocalVersion)` explicitly removes that saved working record with CAS,
not its media; cloud deletion must finish first for a Cloud-backed routine.
`listCloudRoutines()` and `listRoutinePublications()` enumerate cached Cloud heads
and local publications respectively for the combined routine chooser.

Private author-only `GET /api/media/library?cursor=...` returns
`CloudAudioPage {items:CloudAudioItem[],cursor?}` with bounded metadata pages;
items are `{asset,title,duration?,bpm?}`. Completed asset catalog bytes/hash are
authoritative; descriptive metadata can be derived from existing private routine
and playlist references. Missing metadata is unknown, never fabricated. GET never
downloads the entire audio library or rewrites it. Add selected assets with fresh
entry IDs and empty cues, preserve bytes, avoid a second upload, hash before use.
Player accounts cannot browse the catalog. Responses remain private/no-store.

Custom filler analysis is separate metadata, never part of immutable recording
identity: `GET/PUT /api/fillers/{id}/analysis` uses
`FillerAnalysis {bpm,confidence?,analyzer,sha256}`. PUT is authenticated/CSRF/author
guarded and validates the hash against the actual recording. GET with no analysis
returns `{analysis:null}`, otherwise `{analysis:FillerAnalysis}`; PUT returns the
same envelope. Recorded playback never time-stretches. Built-in synthetic BPM is
known from generation; the bundled recorded loop must have measured BPM evidence.

One header Undo/Redo covers the full Routine, sequence, track insertions and media
descriptors. It cannot rewind server revision, lock/publication or account state.
Transient error displays expire after 30 seconds, not the underlying validation,
pending-save or playback safety state. Preparation runs automatically on selection,
restore and Teach entry, silently; replacing playing audio requires confirmation.
Close prompts Save/Discard/Cancel and clears Edit/Teach active state, not the
library, private audio or pending local saves. New is hidden while a routine is
open; Duplicate creates a separate full routine with a user-chosen name.

All 24 detailed acceptance requirements remain tracked in the implementation
plan. No local preview/dev servers or local browser suites on this workstation;
use bounded non-browser checks and synthetic remote CI. User authorized commit,
push, GitHub merge and the existing Azure Free app deployment only after gates.

## Inline Class Sequence Editor

The September16 follow-up exposes four enable checkboxes below the routine import
actions. Configuration slots render walk-in, before, routine track order, after,
walk-out in chronological order. The underlying ClassSetup, MusicPlaylist and
exact revision references are unchanged; no routine schema or API migration.
Enabling an unselected playlist creates an incomplete UI draft, never a fake
reference or silently omitted phase. Save class setup persists and selects via
existing local/cloud CAS APIs, distinct from routine Save. Pending changes block
new preparation/entry but not transport on the already-loaded class.

Disabled choices are retained only in the editing session and omitted from the
saved setup. Existing locked/published setups cannot be changed through these
controls. New setups use the current routine's source and must reference a saved
routine; adopting a newer routine revision is explicit. Selector refresh retrieves
metadata only, with invocation-bound identity and cancellation guards. Changing
setup selection must not discard an unsaved inline draft without confirmation.
The library remains available to create/manage independent playlists and publish
setups. App-controlled inline save cannot mutate another editor's active draft or
the prepared player snapshot.

## Ready And Protected Follow-up

User approved release-test repairs and the first two summarized roadmap items:
stabilization/readiness and protection of authoring work, followed by commit/push
and deployment. Session position recovery, workout blocks, advanced DSP and remote
controls remain deferred. Physical-device results require user observation.

IndexedDB v6 adds draftRecovery to the existing private database. A copy contains
entity kind, local/household source, detached working content, base revision,
immutable media descriptors and update time. It contains no media bytes, account
credentials or tokens. Each page has an independent writer ID, so two tabs do not
overwrite each other's working buffers. Limit64 records,256KiB per record and4MiB
aggregate; refuse excess writes visibly without evicting unsaved work. No timed
expiry; explicit Discard removes an exact update, and successful Save removes the
current page's recovery copy. Existing account invalidation/transaction fencing
and whole-database sign-out purge apply. Debounced typing has a400ms unsaved
window; the UI must not claim persistence until the write is acknowledged.

Recovery always offers an independent draft, never an implicit overwrite of the
original server head. Routine copies become local drafts; playlist/class copies
keep their source and exact references but receive a new identity. Missing audio
or stale/unavailable references block preparation/save rather than being replaced.
Old copies remain until explicitly discarded. Recovery does not modify playback.

Undo/redo is in-memory content history, bounded to50 edits/1MiB for undo snapshots.
Group continuous typing/nudges within700ms. Retain current entity ID, revision,
lock and publication state when applying history; undo after Save creates unsaved
content at the new base revision. Switching entities resets that editor's history.
No server locks, publications, credentials, media deletion or prepared Class Mode
state can be undone. Re-prepare deliberately after authoring content changes.

Readiness displays the prepared name/revision and all five phase selections using
the existing preparation pipeline. Pending or changed selection is not marked as
newly verified. Manual speaker/power checkboxes reset on preparation; a bounded
synthetic sound audition is disabled while music/filler is playing. Navigation,
preparation and entering Class Mode remain silent. No claim of automatic physical
route/battery detection, background audio reliability or browser-eviction immunity.

## Approved Streamlined Workflows (September 15 Implementation)

### Class-Control Follow-up

The user requires distinct walk-in and walk-out song lists queued with the routine,
with all transport and phase changes available without leaving Class Mode. Preserve
the independent exact-revision references and preflight every phase's audio. The
Walk-in / walk-out music shortcut opens authoring before class; runtime advance
never opens that panel. Per-song filler remains accessible in collapsed headers.

This supersedes the earlier Stop reset rule below: Stop silences and rewinds the
current song in its phase, retaining later phases; internal filler returns to its
outgoing song, announcement loops reset silently. Previous uses the audio clock:
elapsed <=1 second selects the preceding entry in the same list, otherwise it
restarts the current entry. Clamp at the first entry. Preserve playing/paused state,
invalidate pending audio work, and reschedule cues without replaying skipped alarms.
Explicit Replay after completion still restarts the complete class. `createPlayer`
provides `previous()`; the shared interface keeps it optional for older adapters.

Teach exposes the existing authenticated Open household draft operation for cached
or published selections. This is not an unlock, offline write, revision bypass or
implicit snapshot replacement; prepare the current matching unlocked draft before
enabling cue edits.

The user approved docs/plan.md September15 revision and the subsequent Create/Practice/Teach simplification. `shared/class-plan.ts` is the source of truth for MusicPlaylist, ClassSetup, revision references and ClassAudio. Music playlists are independent versioned entities using Track entries with empty cues and no after-rule. Class setups use exact references `{id,revision,published}`; published setups may reference only published routines/playlists. Owners/editors author; players read published content. Saved playlist/setup lock/revision rules mirror routine mutations. No new cloud resources, identity mechanism or public media.

`Track.after` is optional: absent means inherit; `{mode:'none'}` disables that gap; `{mode:'custom',filler,crossfade?}` stores its override. `transitionAfter(routine,index)` resolves defaults and suppresses the final entry's gap without deleting its rule. Every custom recording across defaults/gaps/announcements is validated against the authoritative library and prepared offline. Existing routine JSON with missing after is unchanged; additive optional fields preserve schemaVersion1 and existing records, with strict server field validation.

Runtime `Player.load(routine,classAudio?)` prepares all needed media and remains silent. `advance()` crosses running class-phase boundaries; `PlayerState.phase`, phaseTrackTitle, phaseTrackIndex, nextPhase, canAdvance report optional class state without breaking routine-only callers. One AudioContext/scheduler owns all audio; no competing players or cumulative UI timers. Walk-in repeats the whole playlist until advance; before/after announcement fillers are held loops; routine's natural final completion and final Next route to after/walk-out/finished; walk-out plays once. Pause freezes the phase and advance is disabled. Stop resets first configured phase silently; explicit Replay restarts. Cues/beeps and classElapsed apply only to the routine; nonroutine Now/Next labels identify the phase. All old gain/duck/fade/seek/hold/timeout safety remains. Preparing, switching views, Class Mode entry and fullscreen never start or resume sound.

Cloud endpoints: `/api/playlists` GET `{playlists:MusicPlaylist[]}` and POST CloudMusicPlaylist; `/api/playlists/{id}` GET/PUT/DELETE and POST `{id}/{lock,unlock,publish,duplicate}` mirror routines with quoted If-Match. Successful bodies are CloudMusicPlaylist. `/api/classes` GET `{classes:ClassSetup[]}` and POST `{setup:ClassSetup}`; analogous single/command paths return `{setup:ClassSetup}`. GET `/api/classes/{id}/prepare` resolves `{setup,routine:CloudRoutine,walkIn?:CloudMusicPlaylist,walkOut?:CloudMusicPlaylist}`; all exact referenced revisions, no latest-revision fallback. Reads accept `?published=true&revision=N` when choosing historical content; normal latest reads remain. Media GET may use `classId` plus `revision` to authorize assets referenced by that exact published class, including announcement/gap fillers, or playlistId plus revision for direct published playlist playback. No signed URL/client-provided descriptor is authorization. Strict methods/query parsing, bounded per-entity immutable blobs/head CAS, quota staging, locked writes, tombstone and reference retention are required. Existing routines gain exact-revision lookup for newly pinned class references; missing unavailable legacy revisions fail clearly instead of substituting current content.

Local offline API (runtime lane): list/get/save MusicPlaylist and ClassSetup via `listMusicPlaylists()`, `getMusicPlaylist(id,revision?)`, `saveMusicPlaylist(value,expectedRevision,action='save'|'lock'|'unlock'|'publish')`; corresponding listClassSetups/getClassSetup/saveClassSetup. Saves return authoritative detached values, same CAS/no mass lock assignment. `cacheMusicPlaylist(value)` and `cacheClassSetup(value)` keep exact cloud copies distinct from editable device records, with no implicit selection/save. Class preparation loads exact local references or cloud-resolved envelopes and does not modify a running snapshot. Private account/reset guards cover all writes; no source assets leave ignored/private storage except explicit authenticated upload.

UI lane owns Routines library filters and one-tap row Open, New, primary destination Save, overflow Share/Duplicate/Publish/Replace, Practice/Teach combined preparation, footer actual version/build, collapsed analysis/exports and sticky song preview/Add cue. Explicit Practice Edit cue times toggles seeking off and offers selected-cue timestamp/nudge controls, including matching unlocked household drafts while respecting base revision/media identity, dirty generation, busy state and Class Mode read-only guard. Pending Save freezes authoring, not Pause/Stop; conflicts keep work. Per-gap dialog and collapsed Class setup manage playlists/announcements; no extra permanent phase-button row on Teach. Independent user defaults/favorites may remain local; automatic draft recovery and general undo are deferred unless integrated without changing shared-save semantics. Guides must describe actual delivered controls after verification.

## Track Reordering (September 14 Follow-up)

Edit supports pointer/touch drag reordering using a dedicated track-header grip, with visible insertion feedback and retained Move up/Move down buttons for keyboard and non-drag use. Use shared `reorderTrack(routine, trackId, destination)` to move whole existing entries. Keep IDs, audio references, cue arrays/times, gains and metadata intact. Reorder only the editable draft; the prepared/playing snapshot and published revision never change. A successful drop marks the draft dirty and uses the normal explicit local/household save path, including server locks and revision checks.

No mutation until a valid drop. Escape, pointer cancellation, release outside the list, stale routine/order, editor disposal, new lock, read-only role or pending storage work cancels without changes. The grip alone captures touch gestures; text inputs, cue dragging, preview seeking and normal page scroll remain independent. No-op drops do not mark dirty. Retain expanded track state and useful focus after reorder; announce the new position accessibly. No browser storage-key/schema changes or new persistent playback state.

## AAC Import Fallback (September 14 Follow-up)

Audio-only imports may contain an explicitly identified attached-picture stream. Conversion discards that artwork and all metadata, selects the single audio stream and rejects every moving-video stream. Attached-picture identification must come from the demuxer's disposition flags, never filename or codec alone; encrypted content and multiple audio streams remain rejected. This corrects the earlier overly broad video rejection without distributing user artwork or altering original files.

Native-preserved ADTS AAC (`audio/aac`) and audio-only WebM (`audio/webm`) retain their exact bytes through local filler and household storage as well. Backend signature checks must recognize these types without relabeling them as MP4. Opus-in-WebM remains subject to the explicit Opus conversion policy for new imports. MP4 detection must handle leading free/skip/wide atoms and still reject video/protected content. Native decode timeouts fail clearly with late-result rejection and an outstanding-decode guard; an uncancellable hung decode must not trigger overlapping native allocations or a conversion fallback.

New Opus imports and eligible non-protected audio that cannot be played directly are converted locally to AAC-LC in an M4A container with a 256000 bit/s target, 48000 Hz, preserving mono/stereo channels. Shared policy is `shared/audio-import.ts`. This replaces the persisted Opus PCM WAV fallback, not stored assets already referenced by routines. Supported direct imports remain byte-for-byte unchanged. No automatic bulk migration or replacement of household media. Both song and custom filler imports use the same fallback before cache/hash/upload; fetched immutable cloud assets use preserveBytes and MUST NEVER be converted or rehashed to different bytes. Source files remain untouched. Conversion is lossy and a bitrate target, not a promise that every content sample produces exactly 256 kbps.

Use a proven bundled audio encoder/demuxer, not MediaRecorder real-time recording, browser-dependent AAC-only support, hand-written AAC/MP4, or a cloud transcoding service. Encoding must work under the existing CSP and SWA Free without cross-origin isolation changes, runtime CDN calls, or additional Azure resources. Serialize worker-based conversions, bound source bytes (32MiB), output bytes (16MiB), input channels (1/2), duration (360s), elapsed time and memory. Reject video, DRM, malformed or out-of-bound media explicitly rather than truncating/downmixing, mislabeling the container or silently falling back to stored WAV. Native/encoder feature absence must fail clearly. Validate the encoded AAC-LC container and actual local decode/duration before committing. Preserve source timeline including Opus pre-skip/end trimming/output gain; verify encoder priming/trailing-padding handling with sample/timing tests so existing cue positions are not shifted.

The converter has no persistence, network credentials or UI state. Lead-delegated module `frontend/src/audio-conversion.ts` exports `convertToM4a(file: File, options?: { signal?: AbortSignal }): Promise<{blob: Blob; duration: number}>`. Runtime caller owns invocation-bound account/reset guards, checks cancellation before/after conversion and before IndexedDB commit, aborts/terminates work on explicit logout/account switching, and does not stop a prepared class on ordinary session expiry. Converter must release worker/temp buffers on success, failure and cancellation; do not spawn a second worker while an uncancellable first conversion remains. Native playable imports cannot be blocked by an unavailable conversion worker. Bundled codec assets require explicit license/source provenance and privacy/deployment allowlisting; private music/metadata/logs may never enter public assets or release reports.

## Shared Filler Library (September 14 Follow-up)

Settings contains a household-wide custom filler library in hosted mode and a device-local library in standalone mode. Owners/editors add/remove; players cannot manage the household library but retain published-routine playback. Built-in synthetic sounds and licensed lo-fi remain available as built-ins, not editable user recordings. Custom audio is explicitly imported/uploaded, never publicly bundled. Removal requires confirmation and archives the library entry only; immutable bytes and descriptors already referenced by saved, locked, published or prepared routines remain usable. Physical asset deletion/GC is not part of removal and does not refund conservative storage reservations. A removed entry disappears from future choices but stays visible as the current selection in routines that reference it. No silent fallback to another sound.

Shared `FillerRecording {id,name,duration,asset:AudioAsset}` identifies an immutable recording, duration >0..360 seconds, descriptor bytes 44..128MiB, safe IDs and lowercase SHA256, supported canonical audio type. `Filler.sound='recording'` requires `Filler.recording`; built-in sounds omit it. Persist exact descriptors through save/duplicate/publish/cache/export. Server verifies catalog metadata, not client claims; archived entries remain resolvable for existing references. The recording loops at original tempo/pitch; filler mode/timed duration/gain remain per-routine. No guarantee that arbitrary uploads have a seamless loop boundary. Readiness validates/downloads this recording BEFORE class, stored under reserved local media key `filler-${asset.id}`. Playback/audition use only that local immutable recording, no live API/SAS or library lookup. Existing decoded memory/duration limits, hash guards and session/account isolation apply.

API GET `/api/fillers` returns `{fillers:FillerRecording[]}` for owners/editors; POST same path `{name,duration,asset}` validates an existing uploaded private catalog asset and creates an immutable recording entry; DELETE `/api/fillers/{id}` archives idempotently using conditional storage writes. Exact parser rejects unknown/forged fields. Bounded per-record Blob metadata and discovery indexes; reserve quota before additions. No giant household entity. Public/private authorization and CSRF follow existing routes. Media GET for players accepts the recording asset ONLY when referenced by the requested published routine, including after library removal. Cloud client reuses bounded resumable asset upload/download protocol, and validates/hash-caches recording before saving or preparing a routine. Never upload a local filler implicitly without an explicit household-save/upload confirmation.

Offline runtime exports `listFillerRecordings()`, `addFillerRecording(file:File,name?:string)`, `removeFillerRecording(id:string)`, `cacheFillerRecording(recording,blob)` and `getFillerRecordingBlob(recording)` from offline.ts. Local library removal retains bytes; cached cloud recordings do not automatically populate the local library. Fonda owns Settings UI/client library integration; Simmons offline/filler runtime; Pilates API. Lead shared contracts. No parallel cross-owner edits.

## Editor And Audio Polish (September 14)

Working title is Fitness Music Player. Displayed rehearsal terminology becomes routine/practice as appropriate; do not rename storage keys, worker protocol or internal APIs and lose existing data. All active routine selection, local or household, belongs on Edit, including read-only published selection for player roles; Teach is playback-only, with active/prepared routine identity visible. Editing a household draft and Save updates that same server routine with confirmation and current If-Match. Local saves explicitly say Save on this device. Published snapshots are read-only, but owners/editors can explicitly open their current household draft to update it and then publish a new immutable revision. Explicit replacement of an existing household routine from a local draft requires selecting the target, fetching its current head, confirmation naming target/revision and conditional save; locks and 412 conflicts cannot be bypassed, no force overwrite or title-based automatic match. Cloud refresh/save/selection never replaces a running class.

`Track.gain?: number` and `Filler.gain?: number` are independent non-destructive linear multipliers, finite 0..1.5, omitted = 1. Preserve optional fields through local/cloud saves, duplicate, publish, parsing, cache and exports. No source byte changes or timing changes. Playback AND audition apply the stored level along with existing envelope, volume and ducking, including every fade/seek/pause/resume/hold path. Analysis is explicit, local and bounded; use a proven BS.1770/EBU R128 implementation, propose a track gain for a common loudness target with conservative peak headroom and a 1.5 amplification cap. Do not claim RMS/peak normalization is perceptual loudness normalization. `LoudnessEstimate` is in shared/preview-contract.ts; Simmons exports `analyzeTrackLoudness(trackId): Promise<LoudnessEstimate>` from frontend/src/loudness.ts. Analysis results are preview suggestions, not silent gain changes; Apply remains an explicit unlocked-draft edit. Persist the resulting gain, not audio transformations. Silence and unsupported analysis fail explicitly. Declare measured peak versus true peak honestly.

Exports: Export routine is collapsed by default. Excel and PDF command buttons each open an accessible dialog with its own selected fields, editable safe filename, Cancel and Download. Plain field names (no repeated Include). Respect deselection everywhere including PDF headings/overview; fixed document metadata may remain. Existing formula-safe typed Excel cells, embedded font, offline rendering and long-note PDF pagination remain. Snapshot content is captured at export confirmation and does not mutate the routine.

Cue editor timestamp/interval values use m:ss.s text input, also accept plain nonnegative seconds, store numeric seconds unchanged; counts remain numeric. Reject invalid colon/seconds ranges and preserve invalid typed text for correction. Track groups use bounded bordered/tinted containers with clear headings in all themes. Add Cue next to each track audition progress plus existing lower action; both capture fresh audio time. Show accessible existing-cue markers on that progress with no layout shift or seek/add collision. Cue delete requires confirmation naming cue/track and Cancel preserves selection/content/playback. No inline HTML from user text.

## Current Cloud Workflow (Supersedes Hosted Pilot Stage)

The approved target is SWA Free with managed HTTP Functions, a simple username/password form, and shared private music/routines using today's player. Microsoft invitations, the device-local-only deployment and a Standard upgrade are superseded. Static app code is public; every private API operation is server-authenticated. Account configuration is server application settings only: stable ID, normalized username, password hash, owner/editor/player role, enabled flag and positive authVersion. Configuration must include an enabled owner and fail closed on invalid or duplicate entries. No public registration or browser role editor. Storage credentials remain server settings because Free managed Functions do not provide managed identity.

`shared/cloud-contract.ts` owns public session and cloud routine shapes. `csrfToken` is held in memory only; session credentials use HttpOnly/Secure/SameSite cookies, never browser storage. Login/session responses are no-store. Same-origin checks and session-bound CSRF protect writes; durable bounded throttling protects login. Account state/authVersion are checked on each private operation. Explicit sign-out and identity switching purge this app's private browser data; ordinary expiry NEVER redirects, stops/disposes playback, invalidates local mutation identity, or deletes downloads. A 401 marks cloud access signin-required only. Offline prepared class controls, cues, filler and transitions need no live cookie, heartbeat, SAS renewal or API. Pre-class readiness verifies all audio locally. New cloud requests fail closed, even during a class. Another identity cannot enter the old account's database. Prepared copies cannot be remotely revoked.

Cloud routes under `/api`: POST auth/login `{username,password}`, GET auth/session, POST auth/logout; GET routines -> `{routines: CloudRoutineSummary[]}`, POST routines with CloudRoutine -> CloudRoutine; GET/PUT/DELETE routines/{id}; POST routines/{id}/{lock,unlock,publish,duplicate}. Reads use `?published=true` for immutable published playback; players cannot read drafts or mutate. Updates and commands except duplicate require numeric quoted If-Match matching routine revision. PUT accepts CloudRoutine; lock accepts optional CloudRoutine for atomic save-and-lock; unlock/publish empty body. Duplicate creates an independent unlocked ID, with selected immutable audio references. Response bodies are JSON; errors `{error: stable_code}`. Successful routine responses are CloudRoutine. Lock/save/publish/delete compete on the SAME durable head ETag; no in-memory production repository or check-then-write. Immutable content blobs plus conditional head pointers are acceptable; no giant household Table entity. Account roles derive only from verified server sessions and current environment configuration, not request principal headers.

`CloudRoutine.media` maps independent track-entry IDs to immutable CloudAsset descriptors. This separates playlist occurrence/cues from media identity without changing the local player schema. Server checks every referenced descriptor against its private asset catalog. Uploads are explicitly selected actions, bounded and authenticated; SHA-256 verified before catalog publication and on browser preparation. No private media goes into static assets. Media upload/download details are documented with the implemented adapter before UI wiring. Azure writes require reviewed artifact/security checks and scoped deployment; no Standard or paid always-on services. Current branch remains feature/cloud-workflow. Existing local browser libraries are not automatically uploaded or cleared.

## Historical Hosted Pilot Stage (Obsolete)

User approved deploying the current device-local rehearsal to Azure SWA Free in a new isolated resource group, using Microsoft sign-in and an invitation-only `household` role. Shared storage, API roles and music upload are NOT part of this stage. `VITE_HOSTED_PILOT=true` enables the hosted bootstrap and sets `self.REHEARSAL_HOSTED` in the built worker together. The deployed entry document and worker require the Azure role; public code/fonts/licensed-loop assets contain no household data. No navigation fallback may bypass the entry rule. Hosted startup checks `/.auth/me` before opening private IndexedDB, blocks unauthenticated/uninvited responses, and permits previous device admission only for network failure. Online role checks and client guards are not offline DRM.

The first verified identity owns this browser install's local database. A different identity must purge it before access; explicit logout purges app-private data and shell caches and notifies other app tabs. Ordinary expiry does not silently destroy downloads. Sign-in pages, auth responses and sign-out operations are never cached. Hosted shell installation verifies the same household identity before credentialed generic-index caching. Navigation is network-first for server denials; only a network exception may use the previously authorized offline shell. Local builds remain available without cloud sign-in. User acceptance of the initial Microsoft invitation and real Azure role/phone tests are required before declaring hosted acceptance complete.

This is the first local milestone, not the complete Azure application. Future routine schemas are versioned rather than pretending unimplemented features work.

## Shared Data

`Cue.beep?: boolean` adds a beep at that cue's computed song time; missing/false disables it. Preserve the field through parsing, duplication and publication; nonboolean values are invalid. It follows timestamp/count/interval mapping and the routine's beep gain with shared per-device mute, merges coincident warnings, and never replays skipped alarms in a burst after seeking. Locked routines reject changing this content flag.

`Cue.flash?: boolean` flashes the full screen (the theme's text color, so black in light mode/white in dark mode) at that cue's computed song time; missing/false disables it. Preserve the field through parsing, duplication and publication; nonboolean values are invalid. It is independent of `beep` (a cue may set either, both or neither) and is excluded from the PDF export's cue columns to avoid overflowing the fixed six-column table layout, while remaining available in the Excel export. Locked routines reject changing this content flag.

Plex is a future one-way import adapter only: snapshot the reviewed playlist order, create independent app entry IDs and ingest selected audio into the private library. External IDs are provenance, never mutable synchronization keys. Subsequent Plex changes cannot mutate routines, cues, audio selections or published snapshots. Repeat import creates a new draft. No polling, playlist refresh/reconciliation or write-back. Imported media must pass preparation/readiness before a class is independent of Plex; failures cannot silently omit/reorder songs. Explicit in-app changes remain subject to locks and revision checks.

`Routine.beepVolume?: number` is the routine's own beep gain, 0-1, defaulting to `DEFAULT_BEEP_VOLUME` (0.8) when missing so existing saved routines are unchanged. It replaces the former global beep-volume setting: beep gain is authored per routine and travels with publication to player devices, while `PlayerState.beepsMuted` stays a per-device toggle. Editing it marks the routine dirty; loading a routine reapplies the gain to the beep bus. Keep the optional field in validation, storage fingerprints and backend mutations. Values outside 0-1 are invalid.

`Routine.beepOnceRemaining?: number` is a separate single-warning seconds-remaining setting (0/missing disables, maximum 1200). Existing `beepRemaining` stays the per-second countdown; `beepEvery` remains periodic. Merge coincident event times to avoid double beeps and do not replay a fired warning after pause/resume. Keep the optional field in validation, storage fingerprints and backend mutations without changing old saved routines. `PlayerState.nextCueTrackTitle` identifies the song of the displayed next cue only when it differs from the current song (otherwise null). During filler it names the incoming song; skip cue-less tracks when finding the next move.

Class mode is a user-entered playback-only view: hide app header, navigation, editor/settings, preparation actions, playlist and cue sheet, but keep current/next cues, source-song attribution, progress/timers, transport, volume/duck/beep controls, error feedback and an accessible Exit Class Mode. Request browser fullscreen on the gesture when supported; use viewport-filling layout as fallback, no claim iPhone Safari can force native fullscreen. Escape/fullscreen exit restores navigation without resetting playback. Filler-to-song handoff must retain/fade the outgoing voice and ramp the incoming voice from zero for both timed filler and manual Continue; never replace the plan by abruptly stopping an audible filler.

`shared/routine.ts` owns Routine, Track, Cue, Filler and validation. Seconds are numeric source/audio seconds. Counts start at 1 with a manually supplied BPM and first beat offset. Elapsed interval cues in this milestone are single fixed-seconds markers within a song, NOT a full continuous work/rest sequencer. The latter remains planned. No tempo adjustment UI until pitch-preserving prepared variants exist.

Every repeated track is a new entry ID. Cue labels are plain text. Local rehearsal stores private media/routines only in this browser's IndexedDB. Local locks are accidental-edit safeguards, not authenticated cloud security. Local publish stores a frozen revision. Published revisions never change beneath playback.

## Player / Offline API (Simmons)

Practice API: `seek(seconds)` seeks within the owning SONG, preserves playing/paused status, clamps before the next segment's ownership boundary, cancels/reschedules audio and alarms, never catches up skipped beeps. Ignore while filler owns playback. No rebuilding the routine or clearing queued hold intent. `updateCues(trackIndex, cues)` validates a detached cue array on an unlocked loaded snapshot, updates only cues without stopping audio, reschedules future cue alarms without firing retroactively. These methods are invoked only outside Class mode. UI additionally requires a matching unlocked draft/prepared fingerprint for drag edits; displayed class content stays frozen during Class mode. Count-cue dragging snaps to the closest valid count using BPM/firstBeat; timestamp/interval anchors retain kind and seconds, note/ID/beep remain unchanged. Save remains explicit with existing CAS lock checks. Drag cancellation must leave content unchanged; pointer release shouldn't trigger a seek. Next-move countdown uses ceiling seconds and the runtime `nextCueIn`, shows wait-for-Continue when unknown and no countdown when no next move.

Export `createPlayer(): Player` from frontend/src/player.ts using shared/player-contract.ts. `load(routine)` snapshots content and checks every media entry exists, but does not decode the entire class. `play` requires gesture and resumes pause; `next` switches to next song; `hold` extends current filler (or inserts a hold after current song); `continue` exits filler; `pause/stop` cancel old scheduled nodes/alarms. Crossfade cue ownership goes to incoming audio at start. Filler is either a saved synthetic preset or the pinned licensed lo-fi recording, never random on replay. Same routine settings must produce the same audio. Recorded filler must load with bounded byte/time limits, verify its hash, and be ready before a rehearsal is ready; failures must allow retry, not silently substitute synthesis. No pretending a BPM bridge or time-stretching exists before implemented.

`subscribe` immediately emits complete state and returns unsubscribe. `dispose` releases audio resources. State UI uses elapsed, duration, classElapsed, current/next cue and fillerRemaining. No second UI playback timer. Interrupted audio waits for manual resume. Track count is arbitrary up to validation limits, initial demo is two short synthetic tracks.

Export from frontend/src/offline.ts:
- `saveRoutine(routine: Routine, expectedRevision: number | null, action?: 'save' | 'lock' | 'unlock'): Promise<Routine>`: returns saved revision, atomically compares prior version, server-like local generation advances revision. New ID requires expectedRevision null. A content save cannot change lock state. Lock may atomically save new unlocked content and lock; unlock only changes state of identical saved content. Caller never increments revision itself.
- `getRoutine(id?: string): Promise<Routine | null>`: omitted ID loads active selection.
- `listRoutines(): Promise<Routine[]>`: detached saved records.
- `setActiveRoutine(id: string): Promise<void>`: choose an existing routine without changing its content.
- `storeTrack(file: File): Promise<Track>`: validate supported audio, byte/duration limits, create ID, store Blob; no cloud upload.
- `getTrackBlob(id: string): Promise<Blob | undefined>`
- `removeTrack(id: string): Promise<void>`
- `createDemoRoutine(): Promise<Routine>`: two deterministic synthetic WAV songs with sample cues, no external media.
- `getReadiness(routine: Routine): Promise<{ ready: boolean; missing: string[] }>`

Use IndexedDB directly or installed idb. Any schema/version or export-name changes go to Horton before UI integration. Service worker may cache production application shell, never blindly cache all fetched URLs/auth responses. No cache removal during active rehearsal or auto-skip-waiting updates. The initial local demo must not promise permanent browser storage or remote revocation.

Store by routine ID with a separate active pointer; migrate the previous `active` record without losing it. Local CAS failures surface routine_conflict rather than retrying stale content automatically. Referenced media deletion must fail. These guards are local accidental-edit protection, never a substitute for authenticated server mutations.

## Editor Audio Auditions

Editor auditions use `shared/preview-contract.ts`. Simmons exports `createAudioPreview(onStart?: () => void): AudioPreview` from `frontend/src/audio-preview.ts` and `detectTrackBpm(trackId: string): Promise<BpmEstimate>` from `frontend/src/bpm.ts`. One controller per app, audio-clock elapsed time, one active audition, finite eight-second filler using the SAME `generateLoopSamples` as rehearsal. `playTrack` resumes the same paused track when startSeconds is omitted; another track starts at zero. `seek` changes the currently loaded track only. Stop/dispose invalidate pending work. `getState` samples current audio time, not the last UI tick, for cue insertion. Preview never mutates a routine. Detection returns estimated BPM AND firstBeat in original-source seconds (not a proven downbeat/phrase or confidence score). UI shows both suggestions, applies both only after explicit review with count-cue implications and lock guards, and retains manual editing. Analysis must account for any window offset and reject silence/invalid results instead of inventing default detected values.

Fonda owns audition UI in editor/main and coordinates it with rehearsal: preview start cancels pending rehearsal transport and pauses music; teaching playback and leaving Edit stop auditions. Per-song Add cue captures preview seconds without rerendering/restarting the audio, respects cue limits and locks, and focuses the new note. Locked songs/filler may still be auditioned, but not modified. Stale analysis results cannot apply to a replaced, removed or locked draft. `.opus`, `.mp3` and `.m4a` are explicit chooser extensions. Simmons owns offline import/decoder validation and keeps native supported media plus bounded Ogg Opus fallback for browsers without it; originals stay intact on disk, no cloud upload.

## Experience (Fonda)

Recorded filler: `Filler.sound = 'lofi'` is a pinned, locally bundled CC0 instrumental excerpt from https://opengameart.org/content/lofi-hip-hop (omfgdude), not live generated audio. Its recorded tempo/pitch stay unchanged; disable the synthetic BPM control for this choice, retain saved numeric BPM only for compatibility and label original tempo. No silent playbackRate stretching or claim of pitch-preserving matching. Existing synthetic choices and saved routines remain unchanged. Both audition and rehearsal use the same decoded licensed asset and preparation checks its availability. Library asset redistribution is allowed only for the specifically licensed bytes documented in docs/licensed-media.json; household audio stays private. Simmons owns new frontend/src/filler-audio.ts and its tests/assets/loops; no UI edits.

Exports: browser-local `.xlsx` and `.pdf` from an explicitly selected snapshot of the current editor routine (may be unsaved; label draft/revision/lock accordingly). No audio, secrets, local paths or login data included. Excel column checklist covers every current routine/track/cue field plus derived order/effective seconds, including BPM/firstBeat, body area, anchor kind/value, cue note/beep, filler/crossfade/three beep settings. Rows follow song order and calculated cue time; tracks without cues still get a row with blank cue fields. An Overview sheet includes version/export metadata and truthful total duration (open-ended holds marked), not excluded sensitive columns. Treat user strings as XLSX strings, never formulas/hyperlinks; preserve numeric/boolean types, Unicode, duplicate entries, empty cues and optional legacy fields. PDF is a readable US Letter workout packet, track sections, metadata, cue tables, page numbers, wrapped long notes and safe filenames; no silently truncated cues. Use installed write-excel-file, jspdf and jspdf-autotable; embed a suitable existing font for supported user-text characters instead of corrupting text with built-in Helvetica. Export works while locked (read only), with checklist apply independent of routine state; preferences personal/nonsecret. Fonda owns exports.ts/export-panel.ts and associated tests. PDF can offer selected columns if feasible but at least the readable complete cue sheet.

Use the above APIs. main.ts owns player+editor orchestration. Keep local draft editing separate from loaded snapshot; don't reload playback when someone changes a setting. Lock/unlock require an explicit confirmation; duplicate creates a new unlocked ID. Can't edit locked draft. Track file chooser uses storeTrack then appends in chosen order; user can reorder. Demo loading only on explicit user command and confirm replacing nonempty routine. Show local rehearsal status, never fake cloud auth or successful Azure upload. Standard layout has Now/Next, actual track progress markers/timers, playlist, timestamp/count/interval cue table, filler settings and theme controls. Seven named accents, light/dark and high contrast; all user strings externalized in en-US catalog. No section loops or remotes. Visible feature status belongs in README, not explanatory marketing in the player.

## Backend Core (Pilates)

Implement dependency-free domain services and tests, not a fake deployed HTTP server. A verified principal type is input to service only AFTER a future Azure adapter validates token issuer/audience/signature/scope and membership. Never expose a public endpoint trusting this object from JSON. Map explicit errors 401/403/404/412/423/428. Validate runtime bodies strictly. In-memory repository is test-only: mutations and locks compare the SAME head revision atomically; future Table adapter uses ETag CAS. Lock/unlock advance revision. Prevent lock-field mass assignment, immutable published revision replacement, stale save after lock-unlock, player draft access, and last-owner races. Include owner/editor/player matrix. Clearly mark Azure/Entra/Table adapters as NOT implemented.

## Ownership and Validation

Horton: root/shared/docs/config/dependencies/agents, integrated e2e. Simmons: named runtime/offline/service-worker files + worker + audio tests. Fonda: other frontend source/assets, no package/config edits. Pilates: api + security tests. Wicks: infra/workflows. Michaels: read-only review. No cross-lane patches or Git operations from delegates. Validate scoped test first, then typecheck/build. Node 22.12+; root npm test; npm run typecheck; npm run build.

No Azure resources, source publication or private media upload during this milestone. No secrets/household media in public artifacts. Intake is ignored local-media/incoming/. Browser imports explicitly selected files; static server must never serve this directory. Real iPhone/airplane-mode/Bluetooth rehearsal remains a user-device gate.