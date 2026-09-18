# Fitness Music Player: Current Workflows

Status: September 17, 2026. Playlist and uploaded-audio changes are implemented in this source
checkout, awaiting remote verification, with remaining limits documented below.
This is not a claim that the new build is deployed. Use the Azure app and check its
footer build timestamp for the installed release. Do not start a local preview or
browser suite on this resource-limited workstation.
Existing media and account data are not migrated by these instructions.
The earlier [workflow review](workflow-review.md) records the problems that led to
these changes; it is historical, not the current operating guide.

## Quick Recipes

1. **Create:** Routines > New routine > name > Track order > Add track >
   From audio library or Import audio > order songs/add cues > choose phases and fillers > Save.
2. **Duplicate:** open a routine > More actions > Duplicate to new routine > enter an independent name >
   edit the complete copy > Save. New routine is hidden while one is open.
3. **Fine-tune:** open an unlocked draft > Teach > wait for automatic preparation >
   Edit cue times > type, nudge or drag a selected cue > Save.
4. **Teach:** open the intended routine > Teach > check the complete phase queue >
   Start class > Play. Opening/preparation/Class Mode entry remain silent.
5. **Playlists:** Playlists > New music playlist > name > Add track > From audio library
   or Import audio > order and levels > Save. Return to
   Routines and explicitly choose it for walk-in or walk-out.
6. **Close:** Close routine at the editor footer > Save, Discard changes or Cancel.
   Save uses the same local-first path; closing does not delete the library/audio.

The standalone build uses the same **Save** button but saves only on this device.
There is no separate class name or Save class setup step.

## Before You Begin

### Playlists And Uploaded Audio

The **Playlists** workspace edits reusable music lists independently of Routines.
It has a matching header, chooser, Undo/Redo, Save and Close workflow. Song rows
show their number, duration, preview controls and level slider. Playlist editing
has no class phases, cues, filler, cue beeps or BPM controls; existing stored BPM
is retained. Save commits locally before attempting Cloud synchronization. Pending
saves and later unsaved edits remain distinct. Editing a playlist never silently
changes a routine that already adopted its saved tracks.

Use **Delete routine** in the routine footer, or the trash control beside a
deletable draft in the chooser. Review the named routine and storage location in
the confirmation. Locked routines must be unlocked first; published views do not
offer destructive editing. Routine deletion does not delete the uploaded music.
**Remove from playlist** likewise removes only that song occurrence.

Expand **Settings > Uploaded audio** to manage Songs and Fillers. Rows show
available filename, title, artist, duration and BPM metadata, with Play/Pause,
Stop, Edit and Delete. Unknown historical facts remain unknown. Upload selected
files through the existing bounded audio-processing pipeline. Preview loads only
the selected audio; browsing metadata does not download the entire library.
Metadata edits change future selections, not saved routine/playlist snapshots.
Original filename and measured duration are read-only intake facts.

**Delete audio** is unused-only and keeps the stored bytes; it is not a storage
purge. Saved histories, publications, class references, pending copies and known
local drafts can block it. An incomplete check cannot authorize deletion. Cloud
cannot inspect unsynced drafts on another device. Deletion also requires the
operator's server activation gate after all older writers are drained; until
that is established, the API reports that deletion is unavailable. See the
[API activation requirements](../api/README.md#admission-and-activation-gate).

For better upbeat filler, the [music-engine recommendation](third-party-assets.md#filler-production-recommendation)
describes SuperCollider and alternatives. This change does not bundle new tracks
or replace the sounds in saved routines.

- On Teach, **Class readiness** summarizes the prepared routine and its walk-in,
   announcement and walk-out phases. Opening a routine, restoring an active selection
   at startup, or returning to Teach after edits triggers automatic preparation.
   Wait for readiness; invalid or missing content must be resolved before playback.
   **Retry preparation** appears only after a failed preparation. Resolve the cause,
   then Retry; it does not start or resume music.
   Use **Test sound**, then **Stop sound test**, to check your actual speaker at a
   sensible volume. Sound testing is blocked while class music is playing. Speaker
   and power checkboxes are your confirmation, not automatic hardware detection.
- One **Undo edit / Redo edit** pair above the routine editor covers its name,
   phases, playlist adoption, song order, cues, filler, BPM, levels and inserted audio.
   Playlists has its own independent history. Undo changes content, not
   server revisions, locks, publication or media deletion. After Save, undo creates
   an unsaved edit against the current saved revision; Save again when ready.
- **Routines > Recoverable drafts**, directly below the selected routine's header
   metadata, lists this device's acknowledged recovery copies, including legacy
   recoveries. **Restore as new draft** never overwrites the original routine. Save
   the recovered draft explicitly; discard old copies only after reviewing them.
   Recovery survives ordinary reload/expiry, but sign-out/account switching purges
   it. It is not backup protection against clearing browser storage or device loss.
- Recovery copies are saved after a short typing debounce; wait for **Recovery up
   to date on this device** before closing. Limits are64 copies,256KiB each and4MiB
   total, with no automatic expiration. A full/blocked store reports failure rather
   than deleting your work. Explicitly saved cloud drafts remain independent.
- Owners and editors can author cloud drafts; playback-only accounts use published routines.
- One sign-in applies throughout the app. Cloud routine metadata loads after
   startup; opening a row selects it and prepares required audio. Sign in appears
   when authentication is required, not while connected or merely offline.
- Open the **Location** checkbox menu for Local/Cloud and the **Status** checkbox
   menu for Draft/Published. Multiple choices are allowed: either choice within a group matches,
   both groups must match. An empty group shows no matches. Star a routine and use
   **Favorites only** to narrow the list; favorites currently belong to this browser
   session, not a synchronized account preference. **Refresh cloud** shares that
   single toolbar and fetches later metadata. Local and Cloud copies of the same
   routine can still appear as separate rows; check their Location before opening.
- Successful Open hides the chooser including filters. **Open different routine**
   opens a searchable dialog over the unchanged editor. Close or Escape cancels;
   opening another routine offers Save, Discard changes or Cancel when needed.
   A failed open leaves the current draft and dialog intact. The current entry and
   legacy classes are labeled separately; names alone do not identify duplicates.
   Check the prominent name and Last saved/revision/status/ID
   metadata before editing; unavailable historical save times say **Unknown**.
   Routine/playlist choices, notices and Teach omit revision numbers; internal
   revision checks and explicitly selected exported metadata remain unchanged.
- One Routine owns walk-in, pre-routine filler, set list/cues/gaps, post-routine
   filler, walk-out and content levels/crossfades. Save persists that complete value.
   A prepared class remains a separate playback snapshot; returning to Teach refreshes
   it from valid edits, with confirmation before replacing playing audio.
- **More actions** contains lock/unlock, duplication, publication and deletion.
   **Publish for playback** makes the saved Cloud version available to authorized
   playback-only users; Save alone does not change that publication. Published
   routines are immutable. **More actions > Open cloud draft** changes their current
  draft, then save and publish a new revision. Explicitly unlock a locked draft first.
- Do not sign out or clear site data to refresh the app: that removes local private
  data and prepared downloads. Save changes before closing the app.

## 1. Create, Save And Share A Routine

1. With no routine open, choose **Routines > New routine**. Enter the single
   **Routine name** below Class sequence; its pencil focuses the name field and
   the prominent title follows it. To make a variant of an open routine, use
   **More actions > Duplicate to new routine** and enter a new name. The copy retains all enabled phases,
   cues, levels and immutable audio, with fresh routine/entry/cue IDs. It is an
   independent unsaved draft until Save, never an implicit overwrite/publication.
2. In **Track order > Add track**, choose **Import audio** and select your songs,
   or choose **From audio library** using the existing-audio recipe
   below. Wait for import completion and
   resolve any rejected files; an unsuccessful file is not added to the routine.
   Arrange tracks with their header grips or **Move track up/down**. Each entry
   retains its own cues, gain and outgoing filler rule.
3. Expand a track. Use **Play preview**, seek to the desired position, and choose
   **Add cue** beside the progress bar or below its cue rows. Add cue uses the
   current preview playhead when that track is loaded. Check the resulting time.
4. Enter **Move / note**. For timestamp or elapsed-time cues, enter **Value** as
   `1:05.5` or `65.5`. For musical counts, enter a count and verify the track's BPM
   and First beat first. Invalid times prevent saving. Optionally select **Beep at cue**.
5. Under **Between tracks**, choose **None**, **Timed**, or **Hold**, then the filler
   sound, its level, duration where applicable, and crossfade. Timed filler advances
   automatically; held filler waits for **Continue**. These are routine defaults.
   To change one gap, use the **Filler** action in that song's header (accessible as
   **After [song name]**). Choose Inherit, None or Custom; Custom has independent
   sound, level, timed/held behavior and crossfade. The final song's outgoing rule
   is retained but inactive. Upload custom recordings through
   **Settings > Uploaded audio > Fillers**; referenced audio cannot be deleted.
   A summary below the song shows active custom sound, timed/held duration, level
   and fade even when collapsed. It follows that song on reorder. Disabled gaps
   and a last-song custom rule are explicitly marked inactive; returning to the
   routine default removes the override summary.
6. Configure optional Class sequence phases using section 3 below. They belong to
   this Routine, not a separately saved setup. Enabled music phases need a valid
   playlist selection before Save or preparation.
7. Press the single **Save** action. It first commits the whole Routine
   durably on this device, then attempts Cloud synchronization and uploads only
   missing media. In the standalone build, the same slot says **Save**
   and does not contact Cloud. Import alone does not upload songs.
8. Check the result: **Saved on this device / Cloud sync pending** is not Cloud success.
   A queued Save survives close/reload and can finish on a later reconnect/startup
   after the same user and role are revalidated. It synchronizes explicitly saved
   work, not subsequent unsaved typing. Sign in again as the same user after expiry;
   do not sign out or clear storage to retry. A conflict/lock preserves the local
   copy and requires review, not forced overwrite. Duplicate it under a new name
   to retain a separate variant before reopening a conflicting server draft.
9. For playback-only members, finish saving the unlocked Cloud draft and
   choose **More actions > Publish for playback**. Locking does not publish. Publishing creates
   a new immutable revision; it does not alter an already-prepared class.

### Add Already Uploaded Audio

1. Open an editable unlocked routine as owner/editor, or a playlist under
   **Playlists**. Available verified audio can be edited offline; Cloud-bound
   saves remain pending until the same account reconnects successfully.
2. Choose **Add track > From audio library**. Online, the picker
   initially reads metadata pages, not every song's audio. Offline, it lists only
   known assets whose cached bytes match the descriptor's size and SHA-256; this
   is not a complete offline Cloud catalog. Uncached or mismatched audio is omitted.
3. Use **Search loaded audio** and **Load more audio** for further pages. Check songs
   in the desired insertion order, then **Add selected audio**. Cancel adds no entries.
4. Wait for selected audio to download/verify, or for the cached copy to be
   revalidated offline. Entries append with fresh IDs, empty cues and known BPM
   only; immutable assets are reused without another upload or conversion.
   Save the Routine or playlist to its displayed destination.

Use the picker row's Preview action to audition that verified asset before adding
it. Preview downloads only that selection when needed and never inserts a song.
Closing the picker stops its preview. Cancel before insertion adds no entries;
role, lock, identity and missing/corrupt-cache checks still apply.

### Analysis And Levels

Detect BPM and Analyze loudness provide suggestions, not verified choreography or
an automatic mix. BPM can be wrong by a factor of two; check against the music and
manually correct BPM and First beat before relying on counted cues. Failed BPM
detection does not prevent manually entering a BPM or using timestamps. Unknown
imported/reused song BPM stays blank. Timestamp and elapsed-second cues do not need
BPM; count cues require valid BPM/First beat. Resolve count cues before clearing
their BPM. Playlists do not expose BPM editing; existing known values, including
legacy 100 BPM, are retained. Library BPM metadata can be edited in Uploaded audio
for future selections without changing existing saved snapshots.

Content-level sliders run **0-125%**, with the percentage underneath. 100% is unity;
the normal color transitions toward red above 100%. This is linear amplitude, not
perceived loudness. A stored legacy value above 125% remains audible at its actual
stored value and visibly warned, not silently reduced. Moving its slider explicitly
sets a new value at or below 125%; that content edit can be undone. These controls
cover routine songs, default/custom/announcement filler, playlist songs
and adopted walk-in/out songs. Adjust adopted song levels directly in their Routine
phase section; these edits do not change the reusable source playlist.

Full-track BS.1770/EBU R128 measurement is separate from the new recommendation:
reference **-8 LUFS**, with a **+/-3 LU deadband (-11 to -5 LUFS, inclusive)**. Normal material
stays at **100%**, even when a separate peak warning is needed. Quiet outliers target
the nearest boundary (-11), with boosts capped at **1.25** and available **-1 dBFS
sample-peak headroom**. If headroom is at or below unity, no boost is proposed and
the quiet song stays at 100%. Loud outliers target -5, using the smaller of desired
gain and sample-peak headroom. This replaces the blanket -18 LUFS policy.

**Apply** remains explicit and undoable; neither analysis nor Save re-encodes or
changes playback timing. Raw measurements are cached with the stored audio's
SHA-256 and recommendations are recomputed, not reused after audio bytes change.
Peak/clipping warnings are separate from gain recommendations. Sample peak is not
true peak; this is not a limiter or a promise of equal perceived loudness or
clip-free crossfades, beeps and mixes. Compare songs/filler on the actual speaker.

## 2. Edit A Cloud Routine And Fine-Tune Cues

1. On **Routines**, reveal **Open different routine** if needed, select Cloud in
   **Location** and Draft in **Status**, and open the intended routine row.
   The list loads automatically after sign-in; **Refresh cloud** checks for later
   changes. Wait for verified downloads and confirm the active routine name.
2. If viewing a publication or cached copy, choose **Open cloud draft**. If
   locked, explicitly unlock it. Playback-only users cannot perform these edits.
3. Import additional songs and add/edit cues using each song's preview on Routines.
   Check the active routine and save destination before making changes.
4. Choose **Save to Cloud**, then **Teach**. Automatic preparation checks all phases
   and captures the current valid draft without starting sound. There is no normal
   manual Prepare step. Wait for readiness and use **Play** to practice.
5. On Teach, use **Edit cue times**, select the cue, then enter **Cue time (m:ss.s)**
   or use Move cue earlier/later. Timestamp steps are 0.1 or 1 second; count cues
   move by beats. Dragging and keyboard-adjusting the cue handles also work.
   Playback seeking is disabled while this editing mode is active.
6. Save from Practice to the displayed destination. A matching prepared snapshot
   keeps its paused position; edits do not start sound. A lock or revision conflict
   still blocks saving. Publish separately when ready.

Reopening the app can restore a read-only cached Cloud selection. Use **Open
cloud draft** while online, then return to Teach and wait for automatic preparation
before editing. This does not unlock drafts, edit a publication, or bypass a
stale-revision conflict. No separate setup reference needs updating.

### Timeline Controls

- In Practice, while a song owns playback, touching the progress bar seeks; its small
   marks are visual cue positions. Seeking is unavailable in Class Mode or during filler.
- In Edit cue times, the double-headed arrows beneath the bar are drag handles.
   Select a cue for the separate earlier/later buttons or focus a handle and use
   keyboard arrows.
- Editing works only outside Class Mode, on a matching unlocked local or cloud draft and
  prepared snapshot, while a song owns playback and no conflicting work is pending.
   Publications, cached-only selections, filler phases and playback-only accounts are read-only.
- Adjustment marks the draft unsaved. Save explicitly; only committed pending Saves
   may synchronize later, not arbitrary unsaved edits.
- Closely spaced handles can overlap. Safari on the user's actual iPhone has not
  been validated; these instructions do not establish that every pointer gesture works there.

## 3. Queue The Whole Class

1. Under the Import audio actions, **Class sequence** has four
   checkboxes: **Walk-in music**, **Pre-routine filler**, **Post-routine filler**
   and **Walk-out music**. Enable only the phases you want.
2. Enabled configuration sections appear in playback order: Walk-in music,
   Pre-routine filler, Track order, Post-routine filler, Walk-out music. Disabling
   a phase hides its section and removes it from the next saved Routine; its choice
   is retained if you re-enable it during this editing session. Before/after phase
   groups share spacing and are separated from the Routine name field.
3. In each music section, choose a saved **Music playlist**. Arrival and departure
   can use completely different songs and ordering. **Manage music playlists**
   navigates to the dedicated **Playlists** workspace.
   Create/save a playlist there, return to Routines, then **Refresh playlists** and
   select it. Adoption copies its current saved songs and levels into this Routine.
   Later library edits do not change this copy; explicitly reselect and Save to adopt
   a new version. Each adopted song has a level slider with its percentage below;
   changing that level edits this Routine only and is covered by its Undo/Redo.
   An enabled playlist without a selection blocks Save/preparation.
4. Each enabled filler section has independent sound, level and tempo controls
   where applicable. Pre/post-routine filler holds until the instructor advances.
   In Hold, the duration input is blank/read-only; the previous numeric timing is
   retained internally for switching back to Timed where that mode is available.
   Sound names show actual source length immediately in parentheses, for example
   **Lo-fi instrumental (CC0) (16 s)**. Short sources repeat to the Timed duration
   or until Continue/phase advance for Hold, using audio-clock scheduling and fades.
   Recorded audio never speeds up to fill a duration. Keep the existing phase and
   between-song crossfade controls; they describe different transitions.
5. Use the single **Save to Cloud** for the complete Routine, then **Teach**. All
   required songs and fillers prepare together, silently. No second setup name,
   Save class setup or Use current saved routine is required.
6. Enter **Start class**. Entry is silent. Press **Play** when ready.

Legacy saved classes remain selectable as variants in the routine chooser; opening
one for authoring resolves its pinned content into an independent complete draft.
Save it deliberately. The legacy records are not deleted or bulk migrated. There
is no separate class-setup authoring section at the bottom of Routines.

The walk-in playlist repeats until **Start Announcements** or **Start Routine** is
pressed. A before-routine loop waits for **Start Routine**. The routine then follows
its song order and per-song filler rules. Its end enters the after-routine loop, if
enabled; **Start Walk-out** leaves that loop. Otherwise walk-out starts automatically.
The walk-out playlist plays once and finishes. All these controls remain in Class
Mode, including Play/Pause, Next, Previous, Stop, volume and speech ducking.

Within the routine, held filler waits for **Continue**; timed filler advances
automatically. After pausing use **Resume** first; Continue and phase advance do
not resume paused music. Next selects the next song, not the next cue.

**Stop** silences playback and returns to the start of the current song, retaining
the current playlist/phase and queued later phases. During internal filler it
returns to the outgoing song; during an announcement it resets that loop silently.
**Previous track** restarts the current song after one second; within the first
second it selects the previous song in the same list. At the first song it stays
there. Previous preserves playing/paused state. **Replay**, after finishing, starts
the complete prepared class again.

For unified Routines, playback-only accounts need the published complete Routine;
its owned phases do not require a separately published setup or source playlist.
Legacy class publications retain their old pinned references. Class Mode remains playback-only; authoring
requires leaving it, but operating a prepared class does not.

## 4. Settings, Share And Close

**Reusable playlists:** Playlists > New music playlist (or open a saved row).
Name it, use **Add track** to import or select uploaded audio, reorder/repeat/remove
entries and set levels. Rows show duration and independent preview controls;
the playlist has no choreography controls. The same metadata-first and
verified-cache rules apply. Save commits locally first and attempts Cloud sync
when applicable. Its save/history is
independent of the open Routine; return to that Routine to adopt the saved playlist
explicitly. Library changes never silently update adopted songs or levels.

**Custom filler:** Settings > Filler library > select a recording > Analyze filler
BPM. Review confidence, correct Recording BPM manually if needed, then Apply BPM
metadata. This stores analysis separately from immutable audio; an inconclusive
result stays unknown. Built-ins show generator BPM without analysis. The bundled
lo-fi recording is pinned at measured 120 BPM, with moderate confidence and a
plausible half-time reading of 60; this is not a guaranteed musical downbeat.
Its 16-second audio always plays at original tempo. Analyze level is advisory;
set per-use filler gain in the Routine. Uploaded filler deletion belongs in
**Settings > Uploaded audio > Fillers** and is blocked while referenced; it is
not an archive-in-use operation or physical storage purge.

**Cue sheets:** use the **Share** icon beside the routine title, choose Excel or
PDF, select fields and a filename, then Download. These are local metadata exports,
not Cloud Save or Publish. Audio is not included; keep exported private notes private.
Existing field-selection, Unicode/font, formula-safety and offline behavior remain.

**Close:** at the Routines footer choose **Close routine**. Save commits locally
first and attempts Cloud; a durable pending Cloud save permits closing, but a local
save failure keeps the editor open. Discard changes closes without committing the
current unsaved buffer; existing saved/pending copies and media remain. Cancel
leaves the current editor/playback intact. Confirm stopping a loaded active class
when asked. Completed Close stops/releases audio and clears active Routines/Teach
selection, without deleting saved content. New routine becomes available again.
Close currently presents the decision dialog even for an unchanged routine.

## Pre-Class Check

- Verify the exact device, speaker/Bluetooth route, volume, first song, filler and cues.
- Open while online and wait for automatic preparation; test the complete class
   offline on the actual teaching device. Deliberately reopen the saved routine
   after Close; do not expect a deliberately closed class to restore itself.
- Keep the app in the foreground. Desktop tests do not prove iPhone interruption,
  memory, browser-eviction or Bluetooth reliability.
- Save authoring changes before leaving the page. Session expiry should not stop
  prepared playback; explicit sign-out intentionally removes local private data.

## Evidence And Limits

The behavior above is grounded in [main.ts](../frontend/src/main.ts),
[class-composition.ts](../frontend/src/class-composition.ts),
[routine-save.ts](../frontend/src/routine-save.ts),
[filler-library.ts](../frontend/src/filler-library.ts),
[loudness.ts](../frontend/src/loudness.ts) and the [contracts](contracts.md).
The [R01-R24 checklist](plan.md#unified-routine-acceptance-r01-r24) separates source
implementation from acceptance. Source now contains revision-label cleanup,
matching phase spacing, checkbox menus and one toolbar, recovery below metadata,
failure-only Retry, adopted-phase gain sliders with percentages below, Settings
BPM/audio-picker controls, and inline/background error expiry. Remaining limits
include separate Local/Cloud mirror rows and session-scoped favorites. The picker
supports preview before insertion. All 24 checks remain unchecked awaiting remote CI.

Global and inline operational errors expire 30 seconds after their latest
occurrence. Replacement, dismissal and disposal cancel stale timers; on return
from a background tab, the helper checks the deadline before retaining the text.
Clearing text does not clear field invalidity, authentication, pending Cloud state
or playback failure. Decision dialogs still need a response.

The latest supplied Fonda result reports **644 passing tests**, not a new run by
this documentation pass or completed remote CI. Read-only Cloud calibration
succeeded for **14 of 14 songs**: 12 normal at 100%, one quiet at 100% without safe
boost headroom, and one quiet capped at 125%. No private names, identifiers, paths,
per-song tables or identifying hashes are included here. This pass did not
remeasure audio. New browser/native/WASM comparisons and synthetic remote
integration verification remain pending; earlier passes do not close those gates.
No human iPhone/Bluetooth rehearsal or live authenticated acceptance is claimed.
The user authorized commit/push/merge/deploy after green gates; this documentation
pass performs none of those operations.