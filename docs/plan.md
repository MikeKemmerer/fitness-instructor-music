# Fitness Music Player Plan

## Unified Routine Acceptance R01-R24

**September 16, 2026: implemented in source, awaiting remote verification.** This
is the current acceptance checklist for the user's complete 24-item revision.
Unchecked boxes mean acceptance is still open, not that all implementation is
absent. The UI owner's listed fixes are now confirmed in source; remaining limits
and unexecuted remote gates below prevent claiming every requirement is accepted.
The older plans remain historical context, not current commands or release status.
See the [current user guide](user-guide.md) for source-grounded operating steps.

One Routine is the whole class: name, owned walk-in/out song snapshots, pre/post
filler, set list, cues, per-gap rules, content levels and both crossfade settings.
Variants are separate named Routines. One explicit Save commits the complete local
working value before one Cloud routine-head write; no hidden two-document class
save. Settings playlists remain independently reusable library objects. Their
later changes cannot silently alter an adopted Routine snapshot. Legacy routines,
classes and recoveries remain readable; no bulk private-data rewrite is authorized.

### Acceptance Checklist

- [ ] **R01 - Header-only revision display.** Remove visible revisions from routine/
	playlist rows, choices, notices and Teach; retain the selected Routine revision
	in Edit metadata and all internal CAS/pins. Explicit export-field choices and
	app/build versions remain. Current labels omit the extra revision numbers;
	remote interaction/export acceptance remains pending.
- [ ] **R02 - Symmetric phase layout.** Walk-in/pre-routine sections precede the set
	list, visibly separate from Routine name, with spacing matching post-routine/
	walk-out sections. Verify long titles and narrow/wide viewport screenshots remotely.
- [ ] **R03 - Hide the whole chooser after Open.** Hide rows and filter toolbar only
	after successful selection; Open different routine reveals them. Failed/cancelled
	Open must retain selection/editor, including during active playback.
- [ ] **R04 - Location/Status multiselect menus.** Accessible checkbox menus support
	Local and Cloud, Draft and Published: OR within each dimension, AND between them;
	empty selection means no matches. Current source uses checkbox menus with Escape
	closure/focus return; remote accessibility/layout acceptance remains pending.
- [ ] **R05 - One library toolbar and favorites.** Refresh Cloud Routines belongs
	beside both multiselects and Favorites only; remove the redundant Cloud panel.
	Preserve star/unstar, stable identity, role restrictions, local publications and
	offline cached metadata. Verify combined-location duplicates and mobile wrapping.
- [ ] **R06 - One prominent identity.** Title with Last saved, revision, Draft/
	Published and ID directly beneath; distinguish local saved, Pending Cloud and
	acknowledged Cloud state. Historical unknown timestamps stay Unknown, never read
	time/recovery time disguised as a save. No duplicate setup identity.
- [ ] **R07 - Recovery beneath metadata.** Recoverable drafts expando directly below
	the header metadata, with complete unified content and legacy recovery support.
	Current source inserts recovery directly after the metadata line.
- [ ] **R08 - Contextual actions.** Remove Routine Actions expando without losing
	lock/unlock/publish/delete/duplicate; recognizable icons/tooltips and decision
	dialogs remain. File Share contains Excel/PDF, not competing Cloud-save commands.
- [ ] **R09 - One complete history.** One Undo/Redo pair above Edit covers name,
	every phase toggle/choice, cues, order, fillers, gains, BPM, imported/reused audio
	and Apply analysis. Include incomplete phase choices. Test first-edit enablement,
	redo and cross-section restoration. Save rebases without erasing content history;
	never undo server revisions, locks, publications, account state or media deletion.
- [ ] **R10 - One routine name.** Remove separate setup name/source/revision area.
	Pencil Rename stays inside Routine name below sequence controls and updates the
	prominent title. Independently named variants contain the full class.
- [ ] **R11 - One local-first Save.** Hosted Save to Cloud commits full content and
	durable pending intent locally before Cloud; standalone uses the same Save slot
	locally. No Save Class Setup, Use Current Saved Routine or extra local-save
	button. Pending survives close/reload; reconnect retries only explicitly saved
	work after same-user/role validation. Lost acknowledgment is reconciled; stale/
	locked/failed writes retain local work, never pretend Cloud success. Publish is
	still a separate explicit immutable-publication action.
- [ ] **R12 - Retain sequence and fades.** Keep all four existing checkboxes and
	crossfade controls/values. Disabled phases are omitted from the saved Routine;
	re-enabling in the working session restores retained choices predictably.
- [ ] **R13 - Share by title.** Share-icon dropdown replaces Export Routine expando
	beside the current title; reuse Excel/PDF dialogs, selected fields, validated
	filename, Unicode/font, formula-safety and offline export behavior. No audio export.
- [ ] **R14 - Settings-only playlist management.** Remove bottom class setup/library
	authoring. Routines chooses/adopts saved playlists; Manage music playlists goes
	to Settings. Settings library edits and history do not silently update the Routine.
- [ ] **R15 - Close safely.** Footer Close Routine offers Save/Discard/Cancel for
	dirty work. Save uses the unified path; durable local/Pending Cloud permits close,
	local-save failure blocks it, Cancel changes nothing. Confirm stopping active
	audio; completed Close releases playback and clears active Edit/Teach/restoration
	selection without deleting saved/pending work, recovery records or private audio.
- [ ] **R16 - Silent automatic preparation.** Open/startup selected restore and
	return to Teach after edits prepare the current whole Routine, not an older
	snapshot. Remove normal manual Prepare; show progress/errors and explicit Retry
	preparation only after failure.
	Validate all phase media, discard stale loads, confirm before replacing playing
	audio, never auto-play/resume. Preserve Stop/Previous/phase semantics. Both Edit
	and Teach now expose Retry on failure; returning to Teach also requests preparation.
- [ ] **R17 - Hold and source lengths.** Blank read-only duration for Hold, retained
	numeric Timed value internally. Actual sound duration in parentheses immediately
	after every sound name across default/per-gap/pre/post selectors. Short sources
	repeat to timed duration or until Continue/phase advance with audio-clock fades,
	not playback-speed changes. Current label format is `Sound name (16 s)`.
- [ ] **R18 - All content gain sliders.** One 0-125% slider per editable song/filler/
	playlist level, percentage underneath, normal color through 100%, gradual red
	above it; remove fractional boxes/redundant dB readouts outside measurements.
	Include adopted walk-in/out entries, Settings and gain-editing previews. Preserve
	actual legacy >125% values with warning until an explicit undoable adjustment.
	Master/beep/duck controls are distinct. Adopted-phase sliders and percentages
	below sliders are implemented; remote interaction/layout acceptance remains pending.
- [ ] **R19 - Honest unknown BPM.** Imported/reused/Settings song entries may have
	blank BPM; seconds cues work, count cues require a valid grid. Preserve known
	values and historical 100 BPM without reliable default provenance. No invented
	grid, NaN display/export or invalid count timing. Settings now has optional BPM
	inputs that accept blank or a known 40-220 value.
- [ ] **R20 - Calibrated loudness.** Read-only calibration of all 14 current reference
	songs against verified stored audio succeeded for 14 of 14; private per-song
	evidence remains private. This pass did not rerun calibration.
	Keep BS.1770/EBU R128 measurement separate from the new outlier recommendation:
	normals 100%, safe quiet boosts <=125%, warnings separate, explicit Apply. Raw
	measurements are matched to immutable audio hash; do not cache stale proposals.
	New browser/native/WASM comparison gates remain pending; no automatic media rewrite.
- [ ] **R21 - Filler BPM metadata.** Custom filler Analyze BPM shows confidence and
	supports reviewed/manual Apply separate from immutable audio. Inconclusive stays
	unknown. Synthetic built-ins display generator BPM; recorded lo-fi is pinned at
	measured 120 BPM, moderate confidence, plausible half-time 60. No time-stretch or
	guaranteed downbeat. Check metadata persistence and original-tempo playback remotely.
- [ ] **R22 - Thirty-second operational errors.** Latest occurrence resets expiry;
	stale callbacks cannot dismiss replacements; manual dismissal/disposal cancels.
	Cover global and inline feedback and background-tab return. Hide text only, not
	invalidity, auth, pending Save or playback safety state. Decision dialogs persist.
	The reviewed inline error paths now use the shared deadline-aware helper;
	remote fake-timer/browser acceptance remains open.
- [ ] **R23 - New only when closed.** No New Routine while a routine is open; offer
	Duplicate to New Routine to authors. Copy all
	enabled phases/settings with fresh Routine/entry/cue IDs and the same immutable
	assets. Require an independent name/Save; no implicit overwrite or publication.
- [ ] **R24 - Reuse uploaded audio.** Keep Import Audio plus Add From Audio Library
	(current label: From Audio Library), metadata-first search/multiselect/ordered
	insertion, optional explicit preview, fresh cue-free entries and verified existing
	assets without re-upload/transformation. Reuse picker in Settings playlists;
	enforce role/lock/offline/cancel rules. Routines and Settings now share the picker;
	offline browsing admits only known size/hash-verified cached assets. Cloud playlist
	editing still requires online access. Preview remains after insertion, not in-dialog.

### Loudness Calibration And Limits

The completed read-only Cloud calibration supplied for this revision succeeded for
14 of 14 songs. Its non-identifying summary reports
median approximately -8 LUFS and median absolute deviation approximately 0.9 LU.
The resulting recommendation distribution is **12 normal songs at 100%, one quiet song at 100%
because it has no safe boost headroom, and one quiet song capped at 125%**: 13 at
unity, not 13 classified as normal. No private routine/song names, IDs, per-song
tables, paths or asset hashes belong in public docs or synthetic CI artifacts.
This documentation pass did not remeasure private audio.

The implemented [recommendLoudness](../frontend/src/loudness.ts) uses reference
-8 LUFS with +/-3 LU deadband: target the nearest boundary of [-11, -5] only for
outliers. Within that band, the recommendation is exactly unity. Quiet boosts use
the minimum of the desired gain, 1.25 and available -1 dBFS sample-peak headroom,
but return unity when headroom is at or below unity. Loud outliers use the smaller
of desired gain toward -5 and headroom. For measured LUFS `L` and sample peak `P`,
`headroom = 10 ** ((-1 - P) / 20)`; the implemented branches are:

- `-11 <= L <= -5`: gain `1`.
- `L < -11`: gain `max(1, min(1.25, 10 ** ((-11 - L) / 20), headroom))`.
- `L > -5`: gain `min(10 ** ((-5 - L) / 20), headroom)`.

Clipping risk is computed separately from the resulting sample peak against the
-1 dBFS threshold; keeping a normal song at unity is not a safety certification.
Raw full-track LUFS/sample-peak measurements are cached with the current audio hash;
recommendations are recomputed from those measurements. Apply is explicit and
non-destructive. This is not a limiter, true-peak guarantee, perfect loudness match,
or proof that crossfades/beeps/manual boosts cannot clip. Listening still matters.

### Source Review And Remaining Limits

Read-only inspection confirms the UI owner's listed fixes. These are implementation
facts, not remote acceptance or permission for this docs lane to change source:

- **R01:** [en-US.ts](../frontend/src/locales/en-US.ts) removes revision numbers
	from routine/playlist choices, confirmations and class labels while retaining
	selected Routine metadata and explicitly selected export fields.
- **R02/R18:** [styles.css](../frontend/src/styles.css) gives before/after phase
	groups matching spacing, separates Routine name and puts percentages below
	sliders. [class-composition.ts](../frontend/src/class-composition.ts) edits owned
	walk-in/out track gains without mutating the source playlist.
- **R04/R05/R07/R16:** [main.ts](../frontend/src/main.ts) builds Location/Status
	checkbox menus and one toolbar with Favorites only and Refresh cloud. The old
	visible Cloud heading is gone; connection/transfer feedback remains. Recovery
	is inserted after metadata. Retry preparation is visible only after failure.
- **R19/R24:** [class-panel.ts](../frontend/src/class-panel.ts) provides blank-capable
	BPM and the shared [audio-library-picker.ts](../frontend/src/audio-library-picker.ts).
	Online browsing is metadata-first; offline browsing verifies known cached asset
	size/hash and rechecks before insertion. It does not enumerate uncached Cloud audio
	or bypass Cloud-playlist online editing restrictions.
- **R22:** [ui.ts](../frontend/src/ui.ts) uses a 30-second deadline with replacement,
	dismissal/disposal and visibility-change handling. Reviewed global/inline owners,
	including [filler-library.ts](../frontend/src/filler-library.ts) oversized imports
	and [export-panel.ts](../frontend/src/export-panel.ts) feedback, use that helper.
	Expiry removes text, not invalidity, pending saves, auth or playback safety state.

Remaining source limits to resolve or explicitly accept at the release gate:

- **R05:** Combined rows still deduplicate by routine/source/status, so the Local
	working copy and its Cloud mirror can both appear when both locations are checked.
	Favorites remain identity-scoped browser-session storage, not durable account
	preferences. The single toolbar fix does not change these behaviors.
- **R24:** Preview before insertion is implemented using the shared preview
	engine and verified selected assets. Closing/cancelling stops preview without
	inserting entries. Remote interaction acceptance remains pending.

### Verification And Release Gate

The latest supplied Fonda result reports **644 passing tests**. It is owner-reported
evidence, not a new test run by this docs pass, completed remote CI, or new actual
browser/native/WASM validation. All **24 boxes remain unchecked** awaiting remote CI.

Use synthetic remote CI for current-source UI/API/security/offline/player/export
and browser checks, with serial workers and desktop/mobile screenshots. New
browser/native/WASM loudness comparisons await that executor. Check all 24 items,
not only the save happy path: offline/reload/reconnect, same-user fencing, lost ACK,
conflict/lock, publication immutability, all-phase media authorization, first-edit
Undo/Redo, stale preparation, silent entry, Close decisions and legacy levels.
No private audio, identifying calibration data or credentials may enter CI.

No local preview/dev servers, restored previews or local-server browser suites on
this resource-limited workstation. Serial memory-bounded non-server checks require
their own authorized execution; this pass used Markdown editor diagnostics only.
The [physical pilot](local-testing.md) remains unexecuted, including real iPhone/
Bluetooth listening, interruptions, storage and offline reliability.

The user approved full commit/push/GitHub merge/deploy of this revision **after green
gates**. The lead/release owner must resolve or explicitly accept remaining limits,
complete remote acceptance, review the fresh merged
source and static/API artifact identities, then use the existing guarded Azure
release path. No new resources/accounts/SKU/private-media migration. No Git,
commands, browser, server or Cloud action belongs to this documentation-only pass.
Do not claim a new deployment without its final receipt/live verification. Keep
the known source-archive HTTP packaging exception visible and separate; never
silently waive a new failure or restore a local preview after upload.

## Historical Plans

Everything below records earlier decisions and release attempts, including old
Save Class Setup/Prepare/Household terminology and local-preview restoration steps.
Those are retained for history only, superseded by the unified acceptance checklist
and Azure-only workstation rule above. Do not execute historical server commands
here or interpret old approval/deployment statements as the current gate.

## September 16 Review Plan

**Historical status: first two summarized items approved on September16.** This was the consolidated
backlog and modification plan at that time. It superseded the planning/status statements in
the historical sections below, not the implemented [contracts](contracts.md).
The user authorized fixing test failures, stabilization/readiness and protection
of authoring work, followed by commit, push and deployment. That covers R1/R2,
pilot definition P1 and U1/A1/A2; physical pilot execution needs the user's devices.
It does not authorize new infrastructure, paid services, public music sharing,
PR merges or the later feature increments. See contracts for the chosen limits.

### Product Goal And Constraints

Make music-led, in-person barre/Pilates teaching dependable and fast to prepare.
The instructor should be able to operate a complete prepared class without
leaving Class Mode, losing choreography, or relying on a network connection.
Broader fitness formats follow evidence from the initial pilot, not a larger
first-release interface.

Preserve the existing household owner/editor/player boundary, private media,
explicit cloud Save/Publish, immutable publications and prepared revisions.
Retain SWA Free and the USD30/month total budget target. No always-on service,
automatic plan upgrade or music migration is proposed. Budget alerts are not a
hard spending cap. Initial pilot exclusions such as section loops and external
remotes remain in force until separately approved.

### Baseline: Do Not Rebuild These Features

- Committed source already includes distinct walk-in/walk-out playlists,
	independently configured announcement loops, per-song filler, silent Class
	entry, Practice cue editing, current-song Stop, one-second Previous behavior,
	and the persisted Disable demos setting. Current recipes are in the
	[user guide](user-guide.md).
- AAC import, bounded parallel downloads, exact-revision preparation,
	custom filler management, loudness/BPM proposals, exports, roles and locks
	already exist. Improve measured shortcomings rather than duplicating them.
- Source publication is complete. Feature baseline is commit `dd8a7b3`; the
	additional compound archive MIME correction is committed as `08188a9`.
- The requested Azure update is **not deployed**. The latest release attempt
	passed its dedicated API/security/offline checks and full-class browser gate,
	then stopped at local Vitest: 1,732 passed, 40 failed, 20 skipped. The displayed
	cloud orchestration failures report a synthetic DOM stub missing `Element.after()`.
	Triage all failures before assuming they share that cause. The remaining hosted,
	full-browser, artifact-review and upload gates have not completed for this attempt.
- An earlier full-class audio-clock assertion failed once; its unchanged rerun
	passed. Preserve that evidence and investigate recurrence, without increasing
	timeouts or disabling assertions just to obtain a green release.
- Live source-archive MIME verification is still outstanding. A local config
	change and a successful upload are not proof that Azure serves the intended bytes
	and headers. Physical iPhone/Bluetooth acceptance is also outstanding.

### Consolidated Checklist

Unchecked means unfinished or not yet approved, not a claim that work has started.
IDs are the single actionable backlog; the sections below define their scope.

- [x] **R1 - Now: restore a trustworthy release gate.** Triage the 40 local test
	failures; repair the cloud DOM fixture where verified; investigate any distinct
	failure. Preserve the original reports and rerun focused checks first.
- [ ] **R2 - Now: finish the existing Azure release.** After review approval,
	complete the required local/hosted/browser/infra checks, review the exact artifact,
	deploy once, verify live files/API denials/source MIME, and restore the local preview.
- [ ] **P1 - Now: define the physical-device pilot.** Confirm teaching devices,
	speakers, class length and interruption expectations; recruit 3-5 instructors
	and record a reproducible acceptance matrix.
- [ ] **U1 - First modification: consolidate pre-class readiness.** Show the exact
	queued class, verified local availability, unresolved blockers and a manual sound test.
- [ ] **A1 - First modification: recover unsaved drafts.** Add bounded,
	identity-scoped automatic local recovery without automatic household Save/Publish.
- [ ] **A2 - First modification: add undo/redo.** Group meaningful authoring changes
	and preserve media references, revision checks and the prepared-class boundary.
- [ ] **R3 - Next: restore interrupted sessions safely.** Persist minimal playback
	checkpoints and offer an explicit, silent recovery choice after reload/crash.
- [ ] **A3 - Next: accelerate rehearsal authoring.** Capture cue times while
	listening, batch-shift selected cues, and copy choreography with explicit mappings.
- [ ] **U2 - Next: validate teaching ergonomics.** Refine observed readability,
	touch-target, orientation and control-discovery problems on actual devices.
- [ ] **B1 - Later approval: introduce reusable timed exercise blocks.** Define the
	versioned work/rest/rounds model and its relationship to music before implementation.
- [ ] **B2 - Later approval: allow controlled run-only adjustments.** Add prepared
	alternatives and deliberate shortening/skipping with truthful finish-time estimates.
- [ ] **F1 - Deferred decision: advanced music, sharing and device integrations.**
	Evaluate waveform/phrase tools, prepared tempo variants, templates/substitute
	handoff, remotes and Plex import separately after the pilot.

### Release And Delivery Order

| Increment | Work | Dependency | Exit Gate |
| --- | --- | --- | --- |
| 0: Stabilize | R1, R2, P1 | Approval to resume release work | Clean required gates, verified live release, agreed device matrix |
| 1: Ready And Protected | U1, A1, A2 | Increment0 and recovery/conflict design approval | Ready state trustworthy; unsaved work recoverable; undo tested across save/lock boundaries |
| 2: Rehearse And Recover | R3, A3, U2 | Draft recovery foundation plus pilot observations | Explicit session recovery; faster cue workflow; full-device class rehearsals |
| 3: Structured Classes | B1, then B2 | Separate schema/timing/UX approval | Timed exercises remain deterministic through holds, transitions and run-only changes |
| Future | F1 | Demonstrated instructor demand and feasibility review | Separate scoped proposal; no implied implementation approval |

Implementation of Increment0 and Increment1 is now approved; later increments remain proposals.
Do not batch all proposed features into one release. No delivery-date estimates
are asserted before the device pilot and contract changes are scoped.

### Increment 0: Stabilize And Establish Evidence

R1 changes test fixtures only where the missing API is verified; a passing desktop
browser test is not permission to ignore another failure. Reuse neighboring test
helpers when suitable. Do not remove the production control or weaken assertions
merely because a synthetic DOM is incomplete.

R2 retains the existing release guard: committed source, clean source inventory,
exact artifact hash approval, one executor and durable receipts. Review the new
`.tar.gz` mapping against the actual live response, six pinned codec/source
resources, public app files and unauthenticated/spoofed API denials. Keep music,
accounts and private storage unchanged. Finish with accurate deployed build
metadata and a tested local-preview restoration. Add concise failure diagnostics
and safe stage resumption only if they reduce the observed recovery problems;
never turn incomplete or skipped suites into successful evidence.

P1 covers the actual iPhone/iPad and Bluetooth route first, then the user's other
teaching devices. Test 45-90 minute classes, or the longest supported class:
offline preparation/relaunch, network loss, expired cloud sessions, long holds,
calls/assistant interruptions, speaker disconnect/reconnect, screen locking,
orientation changes, reload and constrained storage. Mark unsupported behavior
explicitly. Do not promise background/lock-screen playback from the current PWA.

If device evidence shows browser audio cannot satisfy the approved requirements,
stop for a native-audio feasibility decision. A website wrapper alone is not proof
of reliable background audio. No native implementation is approved by this plan.

### Increment 1: Ready And Protected

**U1 - Readiness:** extend the existing preparation pipeline, not a second cache
or player. Present routine/setup revision and walk-in, before, routine, after and
walk-out selections together. Reuse verified local files; display missing/corrupt
media and changed selections accurately. Provide an explicit test-sound action
that cannot overlap a running class. Acknowledge output route/battery manually
where browser APIs cannot inspect them reliably. A successful sound test is not
automatic proof that the intended physical speaker is connected.

Acceptance: cold and cached preparation, empty optional lists, retained archived
filler, offline reuse and expiry all produce truthful states. Opening Readiness
or Class Mode stays silent. Settings/demo visibility and player-only permissions
continue to work. Active classes are not replaced by refresh or update checks.

**A1 - Draft recovery:** add a dedicated IndexedDB recovery store for the newest
working buffer per entity, with bounded storage and versioned migrations. Store
the draft, source identity, base revision, media descriptors and dirty generation;
do not copy music, cookies or tokens into the buffer. Debounce ordinary typing and
persist completed structural edits. Report a failed recovery write honestly.

On return, offer Restore/Discard without silently saving to the cloud. A newer
server revision requires review or recovery into a separate draft, never a force
overwrite. Ordinary expiry retains work but blocks unauthorized cloud writes.
Explicit logout/account change must purge the recovery data with existing private
stores. Define retention and quota behavior before coding; active unsaved work
must not disappear silently when a limit is reached.

**A2 - Undo/redo:** start with routine, playlist and class-setup content edits.
Group typing, cue nudges, reordering and gap changes into useful operations rather
than one history entry per UI event. Do not undo authentication, publication,
server locks or uploads as if they were ordinary content changes. Undo after Save
creates a new unsaved local edit against the current base revision; it does not
rewind server history. Undoing an import removes the draft reference, not the audio.

Acceptance: reload with unsaved work; quota failure; two tabs; stale/locked server
head; expiry/logout/account switch; edit-save-undo; cue-only Practice edits during
playback. Publications, prepared Class Mode snapshots and other users' work remain
unchanged. Design the recovery schema before adding UI controls.

### Increment 2: Rehearse And Recover

**R3 - Session checkpoint:** use a separate identity-scoped record from draft
recovery. Persist exact prepared revisions/assets, phase, track occurrence, source
offset, exercise elapsed time and necessary hold state, never an AudioContext or
credentials. Write at stable transitions and a bounded cadence, not every frame.
Revalidate local media and identity before offering Resume here / Restart current
song / Discard. Always reopen silently and require a fresh playback gesture.

Define recovery during crossfades, held filler, announcements and finished states
before implementation. Reconstruct one valid owning segment; do not resurrect
overlapping voices or replay overdue cue alarms. Recovery after browser eviction
cannot be promised when the required audio is missing. Checkpoint data follows
explicit logout purge and must not confer new server authorization.

**A3 - Rehearsal authoring:** add a deliberate capture mode for timing an existing
ordered cue list while listening, plus selected-cue bulk offsets and explicit
copy/paste mappings. Use audio time and stable cue/track IDs. Counts retain their
anchor kind; do not transfer timing to a different recording by matching its title.
Integrate recovery and undo first. Validate all changes before applying them; no
silent out-of-range cues or publication changes.

Waveform/phrase snapping is a separate extension after measuring whether capture
and batch operations suffice. If approved, use an established library with local,
bounded peak generation, offline support and compatible licensing. Do not retain
whole-class decoded PCM or claim an estimated downbeat is instructor-verified.

**U2 - Ergonomics:** observe the complete Create, Revise and Teach paths in person.
Fix concrete friction in cue selection, collapsed filler access, setup discovery,
contrast and touch targets. Preserve a quiet Class Mode with stable controls and
unobstructed Now/Next information. Verify phone/tablet portrait and landscape;
avoid adding permanent controls for every possible future feature.

### Increment 3 And Deferred Work

**B1:** propose a versioned block model for warm-up, work/rest, rounds, side changes
and cooldown, with optional equipment/modification notes. Define both song-bound
and fixed-seconds timing. Existing interval cues are single markers, not this
sequencer. Preserve legacy routines; require shared schema, API validation, export,
offline and runtime review before writing a migration. Fixed-seconds work must
remain fixed through any future tempo variant; pause and deliberate holds freeze
the approved exercise clock consistently.

**B2:** only after B1, design explicit session-only shortening/skipping and choices
among already-prepared alternatives. Saved choreography and publications remain
unchanged. Show projected routine finish only when computable; indefinite walk-in
and announcement holds must not produce invented exact finish times. Section
repeats/loops remain outside the initial pilot and require a separate decision.

**F1:** defer pitch-preserving tempo variants/BPM bridges, advanced waveform/phrase
tools, template sharing, substitute handoff refinements, external remotes,
lock-screen controls and one-way Plex import until demand and feasibility justify
them. Plex remains snapshot import, never synchronization. Shared templates should
exclude audio by default; importing a song does not establish public-performance
rights. No multi-studio/public-signup architecture, marketplace, social feed,
wearable integration or broad AI workout generation is proposed for the next release.

### Ownership And Verification

| Owner | Proposed Responsibility |
| --- | --- |
| Horton/lead | Scope, shared contracts, recovery schemas, integration and approval gates |
| Fonda | Readiness, authoring, recovery/undo UI and device-layout refinements |
| Simmons | Audio checkpoints, offline storage, timing, media preparation and runtime tests |
| Pilates | Revision/role enforcement and any explicitly approved API/history changes |
| Wicks | Release diagnostics, reviewed artifacts, live verification and cost checks |
| Michaels | Independent read-only review of timing, recovery, privacy and release risks |
| User/pilot instructors | Real-device acceptance, workflow observations and priority decisions |

Ownership assignments are planning boundaries, not permission to launch agents.
Shared contracts are agreed first; parallel work, if later authorized, remains
file-disjoint. Reuse existing tests and helpers; run a focused falsifying check
after each substantive edit, then the required integration gates. Use synthetic
media in public artifacts/tests. Device evidence and live authenticated acceptance
are separate from desktop simulations. No telemetry or private class traces are
uploaded without explicit consent.

Pilot targets, not current claims: 20 complete classes across agreed devices with
zero app-caused stops or lost edits; documented recovery for every interruption
scenario; and measured reductions in authoring time and in-class navigation versus
the observed baseline. Record failures, not just aggregate pass counts. A native
decision or larger budget requires a separate proposal with measured justification.

### Decisions Requested Before Implementation

1. Approve Increment0 and Increment1 design only, or identify a different first scope.
2. Confirm the primary devices/speakers and whether screen-locked/background
	 playback is a requirement or foreground-only teaching is acceptable for the pilot.
3. Confirm automatic local draft recovery with explicit household Save/Publish,
	 and agree its retention/quota behavior before the storage schema is changed.
4. Confirm the proposed manual session-recovery choices and behavior during fades/holds.
5. Keep intervals, run-only improvisation, advanced DSP, external controls and
	 broader sharing deferred until a separate scope review.

**Approval record:** user approved the first two summarized items and commit/push/
deployment. Recovery uses explicit independent copies,64 records/4MiB total,
256KiB per record, no silent expiration; undo has50 entries/1MiB per direction.
Readiness and protection are implemented and under acceptance testing. P1 hardware
confirmation and physical results remain open. R3/A3/U2/B1/B2/F1 are deferred.

## September 15 Workflow Revision

Historical planning snapshot. Many changes below are now implemented; earlier
Stop, cue-editing and deployment statements are not the current operating rules.
Use the September16 review plan above for the unfinished backlog, the
[user guide](user-guide.md) for current controls, and [contracts](contracts.md)
for implemented interfaces. The [independent review](workflow-review.md) records
the findings that motivated this work, not a fresh release certification.

### Findings To Resolve First

1. BPM selection favors raw matched-beat count, so a double-time candidate can win
	 despite worse coverage. It examines only the opening minute, searches 90-180 BPM
	 first, then filters half/double alternatives by strict cross-window agreement.
	 Synthetic ranking reproduced 160 beating 80 with 68.5% versus 96.3% coverage.
	 This explains a real scoring bias, not the BPM of any particular user's song.
2. Loudness suggestions are expressed as amplitude percentages against -18 LUFS.
	 Independent full-track FFmpeg EBU R128 measurements on four original files gave
	 -6.4, -12.0, -8.0 and -6.4 LUFS: expected gains approximately 26%, 50%, 32%, 26%.
	 Three small gains are reasonable for the target. The second result must be
	 compared with the app's exact stored audio before diagnosing its reported value.
	 Original source hashes were unchanged. Filler loudness was not measured.
3. Teach cue editing explicitly rejects all household selections. Timeline marks
	 are not editing controls, and the arrows beneath them are drag handles, not tap
	 nudges. Disabled states and overlapping handles are hard to understand on a phone.
4. Creation lacks an empty New routine command; selecting and opening are separate;
	 local draft, household draft, publication and prepared copy are not clear enough.
5. Start class couples presentation/fullscreen to playback. It must not do so.

### P0: Predictable Controls And Diagnosis

- **Start class / Enter Class Mode:** entering the teaching view never calls Play
	or Resume. An idle or paused session stays idle/paused; an already-playing session
	is not restarted. The primary Play control explicitly starts the ready session.
- **Cue rows:** remove the separate Preview column on Edit and the read-only cue
	sheet. Timestamp/elapsed values already use m:ss.s. Show counts with a small
	computed m:ss.s value in the same timing cell so count-to-time information is not lost.
- **Footer:** show a release version plus build identity, e.g. `vX.Y.Z · build ID`.
	Use real build metadata, never a hardcoded or guessed current version. Derive it
	from the active app/worker build; a waiting update must not make the footer claim
	the new build is active. Offer a version-details/copy action without exposing secrets.
- **BPM:** reproduce failures on a private, locally analyzed representative set;
	collect instructor-confirmed tempo ranges and half/double decisions. Compare a
	proven onset/beat tracker across early, middle and later windows. Rank candidates
	with normalized coverage/consistency rather than absolute beat count. Show confidence,
	half/double choices, manual BPM and Tap tempo. Never silently change a saved beat grid.
	First beat/downbeat alignment is a separate explicit decision, not a guaranteed analyzer output.
- **Loudness:** compare app and independent analyzer on the exact same stored bytes,
	including native, legacy PCM and new AAC imports. Show measured LUFS, target LUFS,
	proposed gain in dB and secondary multiplier, plus boost/headroom limits. Analyze
	filler on the same basis. Keep neutral/manual gain and explicit Apply; no silent
	gain changes, re-encoding, or promise that 25% means quarter perceived loudness.
	Select a common target through listening/headroom tests, not by forcing gains near 1.
- Acceptance: robust low/high tempo and half/double fixtures, realistic music failures
	retained as private tests, no invented BPM on silence, independent LUFS agreement
	within a justified tolerance, gain applied exactly once, and Start class silent
	on iPhone Safari as well as desktop. These are required tests, not completed claims.

### P1: One Routine Workspace And Explicit Cue Editing

Keep Teach quiet. Use the existing Edit area as one routine workspace with a clear
library entry point rather than simultaneous local and household selection panels.
Recommended navigation label: **Routines**, with list and editor states in the same
area, plus **Teach** and **Settings**. The guide above retains today's labels.

- Provide **New routine**, Open and Duplicate. New creates an empty independent ID;
	Duplicate is explicitly a copy. Prompt before discarding dirty work.
- A persistent editor identity strip shows name, source (On this device/Household),
	draft or published revision, lock, and saved/unsaved/conflict state. Opening a row
	is one explicit action; mere selection must not silently change the destination.
- One primary Save button names its destination. A separate Share to household
	action handles first upload. Existing-household replacement remains an explicit,
	confirmed operation. Save draft and Publish for playback-only members stay distinct,
	with publication status visible after saving an updated draft.
- Share presents mutually exclusive **Create household routine / Replace existing
	household draft** choices while the source is local. Replace selects a target for
	review without opening/adopting it first; show both source and target plus the target
	revision. Cancel, a locked target and a stale If-Match preserve the source. Opening
	a household draft is a different action: it makes that draft the edit/save destination.
- **Prepare for teaching** is accessible from the editor or selected routine. It
	prepares a detached revision and takes the user to Teach in a ready, silent state.
	Teach shows the prepared name/revision and whether the authoring draft differs.
- Teach has a deliberate **Practice / Class** state. In Practice, **Edit cue times**
	enables cue selection/adjustment and disables timeline seeking on the same surface.
	Leaving cue-edit mode restores seeking. Class Mode permits neither editing nor
	accidental authoring gestures.
- Permit fine-tuning for a matching unlocked local or household draft when the user
	can edit. Do not simply remove the cloud guard: preserve media references, base
	revision, dirty state, concurrency checks and exact prepared/draft identity.
	Publications and cached read-only copies remain read-only; offer Open draft explicitly.
- Selecting a cue opens a compact time panel with m:ss.s entry and real -/+ nudge
	buttons (0.1 s/1 s steps; count cues use beat-grid increments). Keep an accessible
	ordered cue list for crowded/overlapping markers and large touch targets. Cue drag
	is an optional shortcut, not the only way to adjust on a phone.
- Live practice edits update only the selected cue timing in the practice snapshot
	and draft. They never silently update publications or someone else's class. Save
	remains explicit; a 412/423 leaves local edits available for review/copy, not lost.
	Cloud expiry preserves playback and a clearly marked unsaved local practice buffer;
	it cannot turn an unverified old cloud draft into an authorized shared mutation.
- First implementation freezes cue editing and selection while Save is pending, but
	never freezes Pause/Stop or cancels playback. Retain base server revision, immutable
	media map, dirty generation and identity epoch with the practice buffer. Accept a
	response only for that submitted generation/identity. Preserve the buffer on
	conflict, lock, expiry, forbidden response or cancellation; show review/copy paths.
	Reauthentication rechecks role/head before shared Save. If concurrent editing during
	Save is introduced later, it must retain subsequent edits as dirty rather than replace
	them with the older response. Test that race explicitly before enabling it.
- Acceptance: real iPhone Safari touch/nudge/seek-mode checks, cue overlap and rotation,
	disabled reasons, unlock/lock race, expired session, stale save, unsaved navigation,
	and no change to an already-running Class Mode snapshot.

### P2: Per-Transition Filler Flyouts

Place a compact transition command **between adjacent song entries**. Its flyout has
**Use routine default / No filler / Custom**. Custom includes recording, gain,
Timed/Hold, duration when timed, and transition fade choices. Inheritance is explicit;
turning off a gap must not require editing the global default.

Store the override on the outgoing entry ID, not an array index or song title.
Reordering moves that entry's after-song rule with it. Last-entry overrides are
retained but not played as routine-to-walk-out filler: that boundary belongs to
class setup. Duplicates copy rules with new entry IDs; immutable assets remain referenced.
Use a versioned schema and defaults so omitted overrides preserve existing playback.

Resolve every transition before preparation, then include all required filler assets
in readiness, hashes, API validation, publication snapshots, exports and quota/reference
handling. Archived library recordings remain usable by existing references. Flyouts
respect routine locks and role checks; nothing auto-unlocks or mutates a playing class.

### P3: Independent Walk-In And Walk-Out Playlists

Introduce a reusable **Music playlist** entity independent of a Routine, and a
versioned **Class setup** that references a routine revision, optional walk-in and
walk-out playlist revisions, and independent optional announcement fillers before
and after the routine. Do not prepend/append these songs to routine choreography.

Manage playlists in the library/workspace. Choose them in a collapsed **Class setup**
drawer before preparation. Teach shows a compact ready summary and one primary
Play/Pause action; it does not gain a row of permanent Walk-in/Filler/Walk-out buttons.
Playlist/class-setup creation and changes require owner/editor permissions; playback-only
users load published setups. Prepare pins playlist ordering, routine revision, recordings,
gains and fades so later library changes cannot alter the run.

Selecting an existing setup/revision changes device selection only. Editing the saved
setup's routine, playlists or announcement choices is a separate owner/editor action
with that setup's own lock, If-Match revision, explicit Save and immutable Publish.
Published setups can reference only published routine/playlist revisions that the
player is authorized to read. Draft-only assets cannot be exposed via a setup. A
locked setup is not editable through its drawer. Temporary volume/ducking overrides
are run state; arbitrary run-only compositions are deferred rather than silently
persisted or passed off as a saved setup.

Phase and transport are separate state fields. The following table describes running
phases only; the transport rules below take precedence while paused/stopped.

| Running Phase | Natural Completion | Instructor Advance |
| --- | --- | --- |
| Walk-in | Repeat the entire playlist in order | Pre-routine announcements if configured, otherwise routine |
| Pre-routine announcements | Loop the selected filler indefinitely | Begin routine |
| Routine, nonfinal song | Resolve that entry's filler override/default, then next song | Next track skips the remainder and this gap to the next song; it is not a skip-entire-class command |
| Routine, timed/held between-song filler | Timed advances; held loops | Continue reaches the next routine song |
| Routine, final song | Post-routine announcements, else nonempty walk-out, else Finished | Final Next track routes to the same destination as natural completion; label it Begin announcements, Begin walk-out or Finish accordingly |
| Post-routine announcements | Loop the selected filler indefinitely | Begin walk-out if configured, otherwise Finished |
| Walk-out | Proposed default: play once, then Finished | End the walk-out through an explicitly named Finish action |

Transport rules:
- Ready is silent. Play starts the first nonempty configured phase, even if that
	is pre-routine announcements without walk-in. An empty routine prevents Ready.
- Pause freezes the current phase, cursor, fade/envelope progression and hold intent.
	Resume restores them. Disable phase Advance and filler Continue while paused;
	a paused routine Next track may select the next routine song silently, but cannot
	cross from the final song to announcements/walk-out until resumed. This exception
	must be visibly distinguished from phase Advance and tested.
- Stop cancels voices, alarms, pending handoffs and hold intent and returns to Ready
	at the first configured phase, still silent. This is the recommended initial policy.
- Finished stays silent; explicit Replay returns to the first configured phase.
	Changing views/fullscreen never triggers Play, Resume, Replay or Advance.
- Omitted/empty optional playlists are visibly summarized as absent. Nonempty
	playlists with missing/corrupt audio are errors, not an excuse to skip the phase.
	Post-routine announcements without walk-out hold until a correctly labeled Finish.

For walk-in, Advance means **Begin announcements** or **Begin routine**, not next
song. Keep any Next song command secondary and distinct. Announcement Advance means
**Begin routine** or **Begin walk-out**. Contextual labels reduce accidental phase
skips; switching views or entering Class Mode never advances or starts music.

Use the existing Now/Next display for phase labels as requested: Walk-in, Announcements,
Walk-out. Routine phases retain the real movement cues. Keep actual song titles visible
as secondary attribution; suppress routine cue beeps/countdowns outside the routine.
The exercise clock starts at the routine, not at walk-in. Separate phase/track elapsed
time from routine elapsed time; elapsed values come from audio time, never interval ticks.

Implement one session/phase controller over the existing audio engine, not separate
players that compete for the audio device. It owns transitions, pause/resume, stop,
repeat intent and generation cancellation. Fade/handoff cannot leave both phase loops
running. Existing per-track filler belongs inside Routine; announcement filler belongs
to class boundaries. They may reference the same immutable recording but have separate settings.

All phases must be downloaded and verified before the class is Ready, including
playlists, per-gap fillers and both announcement loops. No live URL/session renewal is
needed during a prepared class. Missing/archived assets cannot silently skip music;
archived-but-retained referenced bytes remain valid. Bound decode/cache memory to the
current/next segments, not every song across all three playlists. Shared hashes should
reuse identical assets, with server-enforced access and no public household media.

Acceptance includes full-playlist wrap, empty optional phases, one-song playlists,
advance during a fade, repeated taps, pause/stop/resume in every phase, no automatic
start at entry, announcement holds lasting indefinitely, last routine track with/without
filler, expiry/offline playback, queue/cancellation races, and real iPhone/Bluetooth testing.

### Proposed End-to-End Workflows

1. **Create:** Routines > New routine > add/reorder songs > add cues > configure only
	desired gap overrides > Save to the shown destination > optionally Share, choosing
	a new household copy OR confirmed replacement while still local > publish when needed
	 > optional Class setup > Prepare for teaching. Ends ready and silent.
2. **Revise:** Routines > open household draft > edit > Practice/Edit cue times >
	 save that same draft > publish updated revision if required > prepare the intended
	 class setup/revision. No download/open/save ambiguity and no reimporting music.
3. **Teach:** select a saved routine/class setup > Prepare > confirm Ready > enter
	 Class Mode silently > Play. Use the single contextual advance at phase boundaries.
	 An existing prepared copy may open offline, but must show its pinned revision/status.

### Decisions To Confirm During Implementation

- Walk-out play-once is a recommendation; the user specified repetition only for walk-in.
	Allow repeat only if subsequently requested, rather than guessing it is required.
- Default announcements: selected filler at the saved filler gain, loop until Advance;
	a no-music announcement hold is an optional later choice, not silently substituted.
- Recommended phase fades reuse the existing bounded fade behavior, configurable in
	Class setup. Confirm desired handoff duration in listening tests; do not infer BPM matching.
- Stop initially resets to the first configured phase, silently. A separate Restart
	routine command is a later option to confirm, not an implicit skip of walk-in.
- Footer version visibility in Class Mode should be unobtrusive and not cover controls.
- The initial plan retains manual, explicit saving. Autosave/undo requires its own
	conflict/recovery design and is not a shortcut around household revision checks.

### Delivery Order And Gates

1. Record analysis evidence and approve the reviewed guide/plan. No live choreography
	 or gain changes solely to make current test fixtures pass.
2. Deliver P0 small controls/build identity plus measured analyzer corrections behind
	 focused tests; test exact stored audio, not only ideal generated clicks/tones.
3. Deliver P1 routine selection/save identity and cue-edit mode with iPhone acceptance.
4. Add versioned P2 transition overrides through shared schema, API, cache, exports,
	 editor and runtime, with migration and locked/publication tests.
5. Add independent playlists/class setup and the P3 phase controller, then verify the
	 complete offline teaching sequence. No new always-on Azure service or Standard upgrade.
6. Publish only a reviewed, fully tested frontend/API artifact; expose release/build
	 identity and update instructions. Keep user source files, accounts and saved media intact.

### Independent Review Disposition

The [separate review](workflow-review.md) rejected the current experience as the best
workflow: missing New/selective gaps and blocked household fine-tuning cannot be solved
by help text alone. Its F2-F5 design/documentation concerns are incorporated above:
explicit phase/transport routing, save-generation/pending-edit rules, saved-setup
permissions, and mutually exclusive upload/replacement. The guide now begins with
short recipes and retains detailed limits below them. Product findings such as
auto-start and blocked household cue editing remain open implementation work; this
documentation revision does not claim those runtime defects are fixed.

## Historical Product Plan

The following records earlier decisions. Current implementation status is in README
and contracts; historical Entra/hosting-only and missing-backend statements are obsolete.

## Approved Scope

Household members have the necessary music rights, as stated by the user. Individual sign-ins share one private household library. Owner/editor/playback-only roles; all editors see drafts, players see published routines. A second trusted owner is allowed, the last owner cannot be removed, and existing identity-provider account security is used initially. No public signup or external sharing.

Music sources are explicit local uploads and Plex playlists. Selected routine tracks may be copied to private Azure storage and downloaded to devices. Public GitHub hosts code/releases only. Budget is **USD 30/month total**, including about 40 songs, variants, storage operations, processing and transfers. This is a budget target, not a guaranteed spending cap.

### Plex Is Import-Only

Select a Plex playlist, review its track order, and import a snapshot into a new routine draft. Create independent entry IDs, including for repeated songs. Bring the selected audio into the private application library through the same validated preparation pipeline as uploads; unavailable tracks are reported and prevent readiness rather than silently changing the order. Cues and all subsequent arrangement, filler, tempo and alert settings belong to the application routine.

Plex server/playlist/track IDs are optional provenance, not a live binding. There is no playlist polling, synchronization, refresh/reconciliation, automatic replacement or write-back to Plex. Playlist renames, reordering, additions, removals and deletion do not modify existing routines. Once audio is successfully imported and prepared, the routine does not depend on Plex availability. An unfinished or failed import may need Plex again; it never marks missing audio ready.

Importing that playlist again creates another draft, not an update to the first. Edits to an existing routine happen explicitly in this app and obey its lock/version checks. Never match or move cues by playlist position, title alone, or a replacement recording's approximate duration.

The urgent milestone is two selected songs followed by the user's fourteen-song barre class. Full song repeats are supported; no section looping, external remotes, extra languages or live generated music in the initial pilot. Touchscreen control, built-in speaker and Bluetooth are the target routes.

## Timing And Playback

Songs focus on body areas and carry predetermined moves. Complete scope includes source timestamps, musical counts/phrases with an explicit verified grid, and fixed-seconds exercise intervals. Timestamp/count cues follow prepared tempo changes; a 30-second exercise remains 30 seconds. A routine selects per-song/block or continuous intervals. Music and exercise clocks are separate and derive from audio time.

Crossfade hands primary song cues to incoming audio when it starts. Extended filler holds keep music playing while freezing the exercise schedule until Continue at the defined handoff. Pause freezes both. Interruptions require manual resume, not surprising auto-play. Speech reduction and beep mute affect this run, not saved choreography. Missing media prevents readiness; errors do not silently reorder or skip the class.

Filler uses selectable instrumental/drum sounds with saved parameters and exact output assets: timed, perpetual hold, optional crossfade, and eventual gradual outgoing-to-incoming BPM bridge. Songs remain original-tempo by default; optional pitch-preserving variants are prepared ahead of class using an established engine. No cloud dependency during a prepared session. New sound requires explicit regeneration and a new saved revision.

The current milestone intentionally implements a smaller versioned schema. The full step/cue/clock model must be introduced before claiming continuous intervals, instruction blocks or tempo processing are supported. See README for actual current capabilities.

## Routines And Locks

Drafts are versioned with compare-and-swap writes. Published content is immutable and a prepared class pins its revision. Lock protects shared name, order, cues, filler, tempo, alerts, publish/revert and deletion. Any owner/editor may explicitly unlock after confirmation. Save cannot implicitly unlock; old tabs and background jobs cannot overwrite a newer lock. Duplicate creates a new unlocked draft without altering the original.

Library assets referenced by locked/published routines must not be replaced or garbage-collected. Device layout, volume and local playback remain changeable while a routine is locked. Lock state and permissions are enforced by API mutations, not just disabled buttons. Local IndexedDB lock checks are only rehearsal safeguards until the authenticated server is connected.

## Presentation And Offline

Shared musical content, personal preferences and per-device/class layouts are distinct. Phone/tablet portrait/landscape layouts, progress height, cue text and timers must not overwrite each other. Seven accents (red, orange, amber, green, teal, blue, violet), light/dark and high contrast. Neutral surfaces, tested contrast, accessible controls, explicit labels. US English catalog with a future localization boundary; no second language now.

Prepare verifies every required audio asset and stores compressed files, not whole-class decoded PCM. Decode a bounded current/next window. An active class pins its app/media version. No forced seven-day expiry or sign-in during offline playback; token expiration only blocks cloud operations. Explicit logout clears private local data; disconnected copies cannot be remotely revoked. Browser eviction remains possible, so preflight and actual device tests are mandatory.

## Azure Direction

### Approved First Hosted Stage

On September 14 the user selected secure hosting first, shared storage next, the Visual Studio Enterprise subscription, and Microsoft sign-in. A new isolated resource group and SWA Free instance in West US 2 are proposed. Do not touch church/streaming resources. The initial invitation is handled privately through Azure role management, assigning only `household`; never store the user's email or invitation URL in tracked parameters.

This stage hosts the existing device-local app with a household entry role, not a fake shared database. No Functions, Blob music library, Entra app registration, paid analytics or always-ready compute is provisioned. Built-in AAD sign-in allows Microsoft identities generally, but only invited identities with `household` may enter; a valid Microsoft login alone is insufficient. Private music remains local. The broader owner/editor/player API roles are retained in the future plan rather than claimed active now. Free hosting has no SLA and stops serving beyond its quotas; the USD 30 total allowance remains a ceiling for later agreed infrastructure, not permission for automatic upgrades.

Current provisioning blocker: Azure CLI refresh credentials expired. The user must renew CLI authentication privately before target-existence/provider checks or any Azure writes can run. Prepared infrastructure and upload tooling live in `infra/`, and tool caches remain ignored under `local-media/tools`. The lead reviews the hosted-mode artifact hash and live anonymous/uninvited denial before sharing a URL. No Azure resources or invitations have been created as part of this preparation.

Default: SWA Free public application shell plus independently authenticated on-demand Functions, private Hot Blob, Table/Queue, Key Vault and an event-driven Consumption media job with zero idle executions. No VM, Premium Functions or keep-warm process. Standard (~USD 9/month) is an optional reviewed upgrade, not an automatic use of the larger budget.

API must validate signature, issuer, audience, scope and active household membership. Never trust an arbitrary client-principal header or role from JSON. Managed identity and least-privilege RBAC; private blobs, short-lived single-object download grants and strict endpoint/origin allowlists. Plex token stays server-side, with TLS/SSRF/redirect validation. Quarantine uploads, bounded parsing/rendering and atomic quota admission. Cost alerts at USD 15/24/30, bounded jobs/retries/logs/retention; alerts do not stop billing.

At five minutes per song and 256-320 kbps, forty compressed songs are roughly 0.4-0.5 GB before variants. Size the actual files; allow several GB for processed material and bounded backups. Transfers/operations and identity features count in the total budget. Check region/subscription pricing and remaining shared allowances before provisioning.

## Delivery Gates

1. Local contracts, private intake exclusions, named squad and test tooling.
2. Two-song local player/editor and tested backend security domain. This is the current implementation milestone.
3. Real supplied-song rehearsal on iPhone/tablet/Bluetooth, then validated 14-song preparation. A narrower candidate needs explicit supported-feature acceptance, not silent removal of requested features.
4. Authenticated Azure API/persistence/upload adapters and bounded media worker, validated in an approved isolated environment.
5. Complete interval/block and prepared tempo/bridge features; Plex import may proceed independently after upload contracts stabilize.
6. Versioned GitHub artifacts, same-build staging/production promotion with approval and rollback. No private music in Git/build/image layers/CI.

Production/cloud provisioning, commits, pushes and merges remain explicit lead/user gates. No auto-merge. Real iPhone evidence is required; desktop browser emulation is not sufficient.

## Recommended Followups

Still proposals rather than silently added requirements: optional left/right/setup cue fields, rehearsal count-in, autosave/undo, 30-day trash, owner metadata export and scheduled backup/restore, app-controlled cleanup of unpinned packages. Core permission, recovery, timing and privacy gates take priority over these additions.