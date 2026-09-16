# Fitness Music Player: Current Workflows

Status: September 15, 2026. This guide describes the current source checkout.
Cloud wording, automatic list loading, after-track indicators and inline class
sequence controls are included in this source. Use the Azure app and check its
footer build timestamp for the installed release; no local preview is required.
Existing media and account data are not migrated by these instructions.
The earlier [workflow review](workflow-review.md) records the problems that led to
these changes; it is historical, not the current operating guide.

## Quick Recipes

1. **Create:** Routines > New routine > import/order songs > preview and add cues >
   choose default or per-song filler > Save to the displayed destination.
2. **Fine-tune:** open an unlocked draft > Prepare for Practice / Teach > Edit cue
   times > select a cue and type, nudge or drag its time > Save.
3. **Teach the whole class:** Routines > Class sequence checkboxes > choose playlists
   and filler > Save class setup > Prepare for Practice / Teach > Start class > Play.
   Operate every phase from Class Mode; no library navigation is needed during class.

## Before You Begin

- On Teach, **Class readiness** summarizes the prepared routine and its walk-in,
   announcement and walk-out phases. A changed draft/selection needs Prepare again.
   Use **Test sound**, then **Stop sound test**, to check your actual speaker at a
   sensible volume. Sound testing is blocked while class music is playing. Speaker
   and power checkboxes are your confirmation, not automatic hardware detection.
- Routines, playlists and class setups now have **Undo edit / Redo edit**. Undo
   changes authoring content, not a playing class or server history. After Save,
   undo produces an unsaved edit; use explicit Save again when ready.
- **Routines > Recoverable drafts** lists this device's acknowledged recovery
   copies. **Restore as new draft** never overwrites the original routine. Save
   the recovered draft explicitly; discard old copies only after reviewing them.
   Recovery survives ordinary reload/expiry, but sign-out/account switching purges
   it. It is not backup protection against clearing browser storage or device loss.
- Recovery copies are saved after a short typing debounce; wait for **Recovery up
   to date on this device** before closing. Limits are64 copies,256KiB each and4MiB
   total, with no automatic expiration. A full/blocked store reports failure rather
   than deleting your work. Explicitly saved cloud drafts remain independent.
- Owners and editors can author cloud drafts; playback-only accounts use published routines.
- One sign-in applies throughout the app. Cloud routine metadata loads after
   startup; opening a row selects and downloads its audio. Sign in appears only
   when authentication is required, not while connected or merely offline.
- A routine on this device and a cloud routine are different save destinations.
   Open the intended library row before editing, and check the displayed destination.
- A prepared routine is a playback snapshot. Later editor changes do not automatically
  change it; prepare again when you intend to replace the playback snapshot.
- Published routines are immutable. Open cloud draft to change their current
  draft, then save and publish a new revision. Explicitly unlock a locked draft first.
- Do not sign out or clear site data to refresh the app: that removes local private
  data and prepared downloads. Save changes before closing the app.

## 1. Create, Save And Share A Routine

1. Open **Routines > New routine** and enter a name. Duplicate creates an independent
   copy instead, retaining the source tracks, cues and settings.
2. Choose **Import audio** and select your songs. Wait for import completion and
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
   is retained but inactive. Custom recordings come from **Settings > Filler library**;
   removing a library choice does not break saved references.
   A summary below the song shows active custom sound, timed/held duration, level
   and fade even when collapsed. It follows that song on reorder. Disabled gaps
   and a last-song custom rule are explicitly marked inactive; returning to the
   routine default removes the override summary.
6. Choose **Save on this device** to save locally. This does not upload songs or
   sync the routine to Cloud.
7. While the source is still local, choose ONE sharing path:
   **Save to Cloud** creates a new cloud routine and uploads its selected
   audio after confirmation. Alternatively, select an existing cloud target and
   use **Update existing cloud routine** without first opening that target or
   uploading a new cloud copy. Review the target name and revision before replacing
   its draft. Completing a new upload adopts that cloud selection and hides the local
   replacement action, so replacement is an alternative, not the next step after upload.
8. Wait for completion and confirm the resulting active routine/destination. A failed
   upload is not a cloud save. Subsequent **Save to Cloud** updates the open
   cloud draft with revision checks. A lock or conflict requires reviewing the
   current draft; it is not permission to force an overwrite. Keep your unsaved work
   until you decide whether to copy it or explicitly reopen the current server draft.
9. For playback-only household members, save the unlocked cloud draft and
   choose **Publish saved routine**. Locking does not publish. Publishing creates
   a new immutable revision; it does not alter an already-prepared class.

### Analysis And Levels

Detect BPM and Analyze loudness provide suggestions, not verified choreography or
an automatic mix. BPM can be wrong by a factor of two; check against the music and
manually correct BPM and First beat before relying on counted cues. Failed BPM
detection does not prevent manually entering a BPM or using timestamps.

The current loudness target is -18 LUFS. Gain is a linear amplitude multiplier:
1 is neutral, 0.5 is about -6 dB, and 0.25 is about -12 dB. It is not a percentage
of perceived loudness. Apply only after comparing songs and filler at a sensible
master volume. Gain does not rewrite the audio file. Manual boosts and overlapping
signals can clip; there is no guaranteed true-peak limiter.

## 2. Edit A Cloud Routine And Fine-Tune Cues

1. On **Routines**, choose **Cloud > Drafts** and open the intended routine row.
   The list loads automatically after sign-in; **Refresh cloud** checks for later
   changes. Wait for verified downloads and confirm the active routine name.
2. If viewing a publication or cached copy, choose **Open cloud draft**. If
   locked, explicitly unlock it. Playback-only users cannot perform these edits.
3. Import additional songs and add/edit cues using each song's preview on Routines.
   Check the active routine and save destination before making changes.
4. Choose **Save to Cloud** and confirm to save the draft. Then go to
   **Prepare for Practice / Teach**. Preparation checks required media and captures a
   snapshot; it does not start the music. Use **Play** to practice.
5. On Teach, use **Edit cue times**, select the cue, then enter **Cue time (m:ss.s)**
   or use Move cue earlier/later. Timestamp steps are 0.1 or 1 second; count cues
   move by beats. Dragging and keyboard-adjusting the cue handles also work.
   Playback seeking is disabled while this editing mode is active.
6. Save from Practice to the displayed destination. A matching prepared snapshot
   keeps its paused position; edits do not start sound. A lock or revision conflict
   still blocks saving. Publish separately when ready.

Reopening the app can restore a read-only cached cloud selection. Use **Open
cloud draft** on Teach while online, then prepare the current draft before
editing. This does not unlock drafts, edit a publication, or bypass a stale-revision
conflict. A changed class setup's exact routine reference must also be updated.

### Timeline Controls

- In Practice, while a song owns playback, touching the progress bar seeks; its small
   marks are visual cue positions. Seeking is unavailable in Class Mode or during filler.
- In Edit cue times, the double-headed arrows beneath the bar are drag handles.
   Select a cue for the separate earlier/later buttons or focus a handle and use
   keyboard arrows.
- Editing works only outside Class Mode, on a matching unlocked local or cloud draft and
  prepared snapshot, while a song owns playback and no conflicting work is pending.
   Publications, cached-only selections, filler phases and playback-only accounts are read-only.
- Adjustment marks the draft unsaved. Save explicitly; separate device and cloud
   copies do not synchronize automatically.
- Closely spaced handles can overlap. Safari on the user's actual iPhone has not
  been validated; these instructions do not establish that every pointer gesture works there.

## 3. Queue The Whole Class

1. Save the routine. Under the Import audio actions, **Class sequence** has four
   checkboxes: **Walk-in music**, **Pre-routine filler**, **Post-routine filler**
   and **Walk-out music**. Enable only the phases you want.
2. Enabled configuration sections appear in playback order: Walk-in music,
   Pre-routine filler, Track order, Post-routine filler, Walk-out music. Disabling
   a phase hides its section and removes it from the next saved setup; its choice
   is retained if you re-enable it during this editing session.
3. In each music section, choose a saved **Music playlist**. Arrival and departure
   can use completely different songs and ordering. **Manage music playlists**
   opens the reusable library: New music playlist > name > import/order songs >
   Save. Return to the inline section and use **Refresh playlists** to see new lists.
   The routine's songs remain separate. An enabled playlist without a selection
   prevents saving/preparing the changed class.
4. Each enabled filler section has independent sound, level and tempo controls
   where applicable. Pre/post-routine filler holds until the instructor advances.
   Set the class setup name and crossfade, then **Save class setup**. This saves
   and selects the setup; routine Save is still a separate action. New setups use
   the routine's save destination. Existing setups retain their destination and
   exact references; **Use current saved routine** deliberately updates that
   reference after a routine revision. Locked/published setups remain read-only.
5. Use **Prepare for Practice / Teach**. All referenced songs and filler are prepared
   together. The setup pins exact saved revisions; later library edits do not change
   an already-selected or prepared class. Update the setup references and prepare
   again when deliberately adopting revised content.
6. Enter **Start class**. Entry is silent. Press **Play** when ready.

The older Class setup / library panel remains available for selecting, publishing,
locking, duplicating or deleting saved setups. Selecting another setup prompts
before discarding unsaved inline changes. Changes do not alter an already-playing
class; save and explicitly prepare when ready to replace it.

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

Playback-only accounts need published routines, playlists and a published class
setup referencing those publications. Class Mode remains playback-only; authoring
requires leaving it, but operating a prepared class does not.

## Pre-Class Check

- Verify the exact device, speaker/Bluetooth route, volume, first song, filler and cues.
- Prepare while online; test the complete class offline on the actual teaching device.
- Keep the app in the foreground. Desktop tests do not prove iPhone interruption,
  memory, browser-eviction or Bluetooth reliability.
- Save authoring changes before leaving the page. Session expiry should not stop
  prepared playback; explicit sign-out intentionally removes local private data.

## Evidence And Limits

The behavior above is grounded in [main.ts](../frontend/src/main.ts),
[editor.ts](../frontend/src/editor.ts), [class-panel.ts](../frontend/src/class-panel.ts),
[player.ts](../frontend/src/player.ts) and the [contracts](contracts.md).
Local browser tests use synthetic songs; they do not establish physical iPhone,
Bluetooth or live authenticated Azure acceptance. Check the app footer's build
timestamp before assuming an installed copy contains this follow-up.