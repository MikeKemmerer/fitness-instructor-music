# Fitness Music Player Plan

## September 15 Workflow Revision

This section is the current proposed UI/product plan. It supersedes conflicting
historical milestone and hosting statements below; the earlier implementation
already uses SWA Free, custom server accounts and private Blob storage. This is
not a deployment announcement or permission to buy additional infrastructure.
The user requested current workflow instructions and a separate review before a
more natural workflow is implemented. See [current instructions](user-guide.md)
and [independent review](workflow-review.md).

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