# Independent Workflow Review: September 15, 2026

Separate second-review pass with its own source comparison and analysis, not an endorsement of the workflow researcher's conclusions. Scope: the three instructions in [docs/user-guide.md](user-guide.md) and the new September 15 section of [docs/plan.md](plan.md). Only this report is owned by this pass.

## Findings, Highest Severity First

### F1 - High: Entering Class Mode Currently Starts Audio

The guide correctly warns about this; it is a product defect against the requested silent-entry workflow, not an inaccurate warning. [main.ts](../frontend/src/main.ts#L463) calls `player.play()` for idle, paused and finished states before entering Class Mode. Finished can therefore replay, too. P0's separation is necessary.
Acceptance: entering/exiting Class Mode leaves idle, paused, playing and finished transport unchanged, including paused announcement filler. No Play, Resume, Replay or phase advance may be dispatched by navigation/fullscreen. Only a separate explicit playback gesture starts sound.

### F2 - High: The Proposed Phase Table Leaves Boundary Commands Ambiguous

[docs/plan.md](plan.md#L139) mixes phases with transport states and leaves Next track on the final routine song, paused filler, and the post-announcement label without walk-out insufficiently specified. Today's [player.ts](../frontend/src/player.ts#L502) finishes at the last track; that cannot simply become the new session controller's Finish behavior.
Acceptance: adopt the phase/transport matrix below. Last-song completion and an explicit last-song skip must resolve the same post-routine destination. Paused filler offers Resume, not Continue/Advance. An absent or empty optional walk-out resolves to Finished, with a Finish label rather than Begin walk-out.

### F3 - High: Household Fine-Tuning Needs A Save-Completion Contract

The guide correctly says Teach cue editing is disabled for **every household selection**, including an unlocked owner's draft: [main.ts](../frontend/src/main.ts#L991). The plan's CAS/dirty-state language is directionally right but does not choose an in-flight editing policy. [saveCloudDraft](../frontend/src/main.ts#L432) snapshots before asynchronous work; [acceptCloudEnvelope](../frontend/src/main.ts#L422) replaces the draft and clears dirty state on success.
This is a regression risk when enabling new controls, not evidence of present data loss: existing busy/selection guards prevent that editing path. Acceptance: use the timestamp-safe protocol below, with a delayed-save/new-cue-edit case proving that an older response cannot discard newer work or report it saved.

### F4 - High: Choosing Content And Editing A Saved Class Are Not Separated Enough

P3 proposes versioned independent playlists and pinned preparation, but does not explicitly distinguish selecting an existing published setup from modifying that setup's playlist/routine choices. A role check on creation alone does not protect an existing locked setup. See [docs/plan.md](plan.md#L123) and the current same-head rules in [docs/contracts.md](contracts.md#L55).
Acceptance: selecting an existing authorized revision changes only device selection. Altering a saved setup requires explicit owner/editor authoring, its own revision/lock checks and Save; publishing remains separate. A player may load existing published content without authoring permission. Any run-only composition policy must be explicit and labeled unsaved, never a silent write to the saved class.

### F5 - Medium: The Guide's Upload/Replace Sequence Can Become Unavailable

Workflow 1 presents Save to Household before Update existing household routine. Completing the first adopts a cloud selection; [main.ts](../frontend/src/main.ts#L399) then hides replacement. The existing-target branch must happen **instead of first upload**, while the source is still local. A reader following steps 7 then 8 cannot perform the stated sequence.
Parent repair: split New household upload from Replace selected household draft in [docs/user-guide.md](user-guide.md#L44). The plan must show the branch, not merely promise confirmation. Acceptance: Open edits the selected draft itself; Replace keeps the local source and names both source and target ID/revision before overwriting. Cancel, dirty-navigation cancellation, locked target and 412 preserve work. No title matching or automatic replacement.

### F6 - Medium: Workflow 1 Cannot Deliver Two Requested Authoring Operations

The guide acknowledges both limitations: no empty New routine after opening another routine, and only global Between tracks settings. [editor.ts](../frontend/src/editor.ts#L569) edits `routine.filler`, not individual gaps. Duplicate is not New; manually deleting copied songs is not an acceptable creation recipe.
Acceptance: explicit New creates a fresh ID and empty tracks after dirty-work confirmation. Per-gap controls support inherited default, None and Custom; only selected gaps play filler. These are required UI/data changes, not problems solved by longer instructions.

### F7 - Medium: The Guide Needs Recipes, Not More Operational Branches

Its truthful caveats are useful, but the three main paths are interrupted by upload alternatives, publications, analysis and repeated preparation advice. Workflow 2's edit/save/prepare loop is a workaround, not the best fine-tuning UX. The separate Preview timing output is redundant for timestamp/elapsed cues ([editor.ts](../frontend/src/editor.ts#L444)); count cues still need computed time.
Parent repair: lead with three short recipes and place exceptions below them. Clarify that progress seeking applies only in Practice while a song owns playback, not Class Mode/filler ([main.ts](../frontend/src/main.ts#L982)). Distinguish Resume from Continue in workflow 3. Keep Play preview; remove the redundant timing column, not audition controls.

## Independent Verdict On Each Instruction

| Workflow | Current Verdict | Best Next Workflow |
| --- | --- | --- |
| 1. New routine, songs, selected fillers, cues, local save/upload | Not complete: initial empty draft works, later New and selective gaps do not. Separate local and household saves are legitimate requested destinations. | New > import/order > cues and gap controls > Save on this device > choose new household upload OR explicit replacement; publish only when needed. |
| 2. Open cloud, add cues, Prepare/Teach, fine-tune | Possible through Edit, but Teach fine-tuning is blocked; repeated save/prepare destroys the flow of practice. | Open the actual household draft > edit > Prepare for teaching > Practice/Edit cue times > Save to the same draft; explicitly prepare the final revision for Class. |
| 3. Quick teach | Short only when the intended revision is already prepared; Start class currently combines setup and sound. Cloud opening needs connectivity; already-prepared playback does not. | Load a pinned saved choice > Prepare when necessary > enter Class silently > Play; reuse an already-ready snapshot without mandatory re-download/sign-in. |

## Recommendation Decisions

Accepted here means this review recommends it, not user approval or implemented behavior.

| Decision | Accept / Reject | Concrete Condition |
| --- | --- | --- |
| One Routines list/editor workspace; New/Open/Duplicate | Accept | Row Open is one action; selection, dirty discard and saved destination remain distinguishable. |
| One Save naming destination; separate Share and Publish | Accept | Local save never uploads; opening a draft is not replacing it; publication shows which saved revision is playable. |
| Cloud cue-time editing by removing `cloudSelection` alone | Reject | Preserve exact draft/media/revision identity, role/lock checks, pending-operation guards and unsaved edits. |
| Practice cue selection with real time/nudge controls | Accept | Timestamp/elapsed retain anchor kind; counts snap to verified grid. Seeking is off on the editing surface; an ordered cue list handles overlapping markers. |
| Silent Class entry and contextual phase Advance | Accept | Enter never starts or advances; Resume is never Advance; last-song action names its destination. |
| Per-outgoing-entry filler override | Accept | Rule follows stable entry ID through reorder; default inheritance is visible; final-entry rule is dormant, not class-boundary filler. |
| Independent Music playlists and saved Class setup | Accept | Explicit revisions, roles, locks, private media access and detached preparation; no source synchronization that silently changes saved content. |
| Walk-out plays once, then Finished | Accept as proposal | Not a confirmed requirement to loop walk-out. Expose Finish; empty walk-out and Stop behavior are defined before implementation. |
| Footer showing active build plus waiting-update status | Accept | Active app/controlling-worker identities are truthful; a waiting worker is not labeled active and cannot interrupt class. |
| Force gains near 100%, auto-boost, or change target to -14 LUFS now | Reject | Confirm target through same-blob measurements and listening/headroom comparison; Apply remains explicit. |
| More help text as the primary UX fix | Reject | Reduce controls/branches and show selection/save/readiness state; keep detailed recovery instructions outside the main recipe. |

## Required Phase And Transport Matrix

Required sequence: entire walk-in playlist repeats until Advance; optional before-routine announcement filler loops indefinitely until Advance; routine; optional after-routine filler loops indefinitely until Advance; optional walk-out. Only walk-in repetition is required; walk-out play-once is the proposal above.
Phase and transport must be separate fields. The following running-phase transitions never override Pause.

| Phase / Condition | Natural Completion | Primary Action / Exact Result |
| --- | --- | --- |
| Ready or stopped | Silent; no phase progression | Play starts first nonempty configured phase; routine is mandatory. |
| Walk-in | Next song in order; last wraps to first, not last-song repeat | Begin announcements if before-filler exists, otherwise Begin routine. Secondary Next song stays in walk-in. |
| Before-routine announcements | Selected filler repeats indefinitely | Begin routine; exactly one handoff. |
| Routine, nonfinal song | Resolve this outgoing entry's filler/default, then next song | Next track skips remainder and this gap to next song, retaining running/paused state as applicable. |
| Routine's timed/held gap | Timed advances; held repeats until Continue | Continue reaches next routine song; never a whole-class advance. |
| Routine, final song | After-filler, else nonempty walk-out, else Finished | Final Next track has the same routing; label Begin announcements, Begin walk-out or Finish. No final per-gap filler. |
| After-routine announcements | Selected filler repeats indefinitely | Begin walk-out if nonempty; otherwise Finish. No fictitious next song. |
| Walk-out | Proposed: next song, last completes to Finished | Finish stops this phase; any secondary Next song follows play-once ordering. |
| Paused, from any phase including filler | No clock, loop or fade progression | Resume restores same phase/offset/hold intent; disable phase Advance/Continue until resumed. Next track may stage a paused routine song silently, never advance paused filler. |
| Finished | Silent | Explicit Replay returns to the first configured phase; view changes do nothing. |
| Stop, from any phase | Cancel voices, alarms, pending handoffs and hold intent | Recommended reset to Ready at the first configured phase, still silent; confirm this policy in the plan. |

An omitted/empty optional playlist is visibly summarized as absent. A configured nonempty playlist with missing/corrupt audio is **not** empty and blocks Ready. An empty routine blocks Ready. After-filler without walk-out remains an indefinite hold until Finish.
Acceptance: one-song and multi-song wrap; all before/after-filler combinations; empty walk-out; final skip versus natural completion; pause/resume during each fade/hold; Stop plus late completion; repeated Advance taps produce one transition. No overlapping phase loops or routine cues/beeps outside Routine.

## Timestamp-Safe Cloud Fine-Tuning

1. Enter Edit cue times only for the matching unlocked draft/practice revision, exact track-entry/media identity and current owner/editor eligibility. Read current head/status when online; cached publication/selection is not editable authority. Preserve the blanket Class Mode guard.
2. Start with timestamp edits: retain cue ID, note, beep, anchor kind and original-source seconds. Reuse validated cue-only update behavior ([player.ts](../frontend/src/player.ts#L602)); never rebuild media/order or retime counted cues implicitly. Practice gets a detached working snapshot; saved publications and other prepared classes remain unchanged.
3. Keep base server revision, immutable media map, dirty generation and identity epoch with the buffer. Reuse media descriptors on cue-only saves. Fetch/check the head and commit with the same revision's If-Match; a timestamp/wall-clock comparison is not CAS ([cloud-library.ts](../frontend/src/cloud-library.ts#L470)).
4. Recommended first implementation: freeze cue edits and selection while saving, as existing busy guards do. If editing remains possible, reconcile the response only with its submitted generation, advance the base revision, and retain later edits as dirty. Never unconditionally accept an older snapshot as the newest editor state.
5. A 412, 423, 401, forbidden response or cancellation preserves the buffer and prepared playback. Show review/copy/retry paths, not automatic overwrite/unlock. Retry after reviewing fresh head/status; a lock-then-unlock still invalidates the old revision. Block new cloud mutations under expired/forbidden status.
6. Ordinary expiry must not block teaching or force navigation to sign-in. A previously eligible author's local practice buffer may remain unsaved, clearly lacking current server authorization; publication/player/cached-read-only views do not gain editing rights. Reauthenticate the same account and recheck role/head before shared Save. Explicit sign-out/account switch retains the existing private-data purge boundary, not cross-account buffer recovery.

The plan already states some of these invariants; it needs the generation/pending-save decision and status matrix as explicit acceptance cases, not a promise that existing generic CAS alone covers new controls.

## Saved Plan Versus Runtime

- Saved Class setup contains explicit routine/playlist revisions, ordering, gains, fades and announcement choices. Runtime contains phase, cursor, transport, hold/advance intent, temporary duck/beep state and cancellation generation. Choosing or playing the same saved setup cannot rewrite it.
- Source-independent playlists use independent occurrence IDs; repeated songs retain distinct occurrences while reusing immutable authorized asset hashes. Library/source changes affect only explicitly selected future revisions, never prepared playback.
- Each saved entity needs its own guarded revision/lock mutations and immutable publication; a setup must not smuggle draft-only playlist media to a player. Prepare verifies all chosen revisions and required private audio before Ready, with bounded current/next decode memory.
- Reorder example: A's after-song rule follows A when A/B/C becomes B/A/C, now between A and C. Moving A last retains the dormant rule; moving it back reactivates it. Show that outcome in the transition summary. Duplicate assigns new occurrence IDs and copies rules; deleting an entry deletes its rule, not referenced audio.
- One controller schedules the engine. Phase/track elapsed and routine exercise time derive from audio time; the exercise clock starts with Routine and freezes during explicit extended holds/pauses. UI interval ticks only render state. Reload/interruption recovery is not proven and must never autoplay.

## Text-Only Workflow Mockups

These are proposed walkthroughs, not screenshots or completed designs.

- **Create:** Routines list > New routine > editor with name, destination and Unsaved status > Import audio > ordered songs with cue rows and between-song transition commands > Save on this device > Share menu: New household routine / Replace existing draft. Replacement opens a named-target review, not the target editor.
- **Revise:** Routines > Household draft row Open > identity strip with revision/lock > edit/add cues > Prepare for teaching > Practice with Edit cue times > select cue and time/nudge panel > Save to Household. Changed practice shows Unsaved; Class uses an explicitly chosen final prepared version.
- **Teach:** saved setup row > Prepare > compact Ready summary of walk-in, before filler, routine, after filler, walk-out > Enter Class Mode > Play. Now/Next shows phase labels outside Routine and real moves within it; one contextual boundary command plus transport, no permanent five-phase button row.

## Current Versus Proposed Action Counts

These are enumerated navigation/command actions, **not observed user timings, taps, a usability study or a measured improvement**. Each named command/selection/confirmation below counts once. Typing, song/cue editing, file-picker internals, waits, retries and optional publication are excluded equally. Preconditions are explicit; unsupported paths have no invented count.

| Scenario And Starting State | Current Sequence / Count | Proposed Sequence / Count |
| --- | --- | --- |
| Create/share, already in empty Edit; content authoring excluded | Import audio > Save on this device > Save to Household > confirm: **4**. After another routine is open, empty creation is unsupported. Selective gaps also unsupported. | Already in empty editor: Import audio > Save on this device > Share to household > confirm: **4**. New routine adds **1** when needed; creation gains capability, not an invented click saving. |
| Open existing cloud draft, already on Edit/Drafts with populated list; no dirty work | Select target > Open selected routine: **2**. Explicit Refresh household adds **1** when needed. | Draft row Open: **1**. Validation/download still happens; no claimed latency saving. |
| One cloud fine-tune cycle, currently in paused Practice with matching draft | Edit tab > adjust Value > Save to Household > confirm > Teach tab > Prepare routine > confirm replacement: **6** excluding Value editing. | Edit cue times > select cue > adjust time > Save to Household > confirm: **4** excluding time editing. Mode/selection can be reused for more cues; final Class preparation is separate. |
| Quick class, exact routine open but not prepared, already on Teach | Prepare routine > Start class: **2**, but second action starts sound. | Prepare for teaching > Enter Class Mode > Play: **3**. The extra explicit action prevents surprise audio. |
| Quick class, exact snapshot already prepared and idle | Start class: **1**, starts sound. | Enter Class Mode > Play: **2**; no redundant preparation or forced cloud sign-in. |

Counts do not claim the current workflow satisfies silent entry. Save/prepare confirmations protecting dirty or active work must not be removed merely to lower totals. The parent should shorten the guide around these paths after resolving unsupported branches.

## Analyzer And Release Evidence Limits

- The new [plan's analyzer evidence](plan.md#L13) records synthetic candidate ranking: 160 BPM beats 80 because raw matched-beat count outweighs coverage (68.5% versus 96.3%). This demonstrates a scoring bias, not any actual song's correct BPM or downbeat. No independent analyzer execution was performed in this review.
- Recorded full-track FFmpeg EBU R128 results on four **originals** are -6.4, -12.0, -8.0 and -6.4 LUFS. At -18 LUFS, expected linear gains are approximately 26%, 50%, 32%, 26%, before additional peak limiting. These explain low multipliers; they do not prove the app gravely miscalculates a differently stored blob. Compare the exact cached/native/PCM/AAC bytes, analyzer settings and gain stage before diagnosing the second discrepancy. Filler remains unmeasured.
- Retain the existing -18 LUFS target pending explicit confirmation. A -14 LUFS comparison is a listening/headroom experiment, not an approved target change or automatic volume boost. Show measured/target LUFS, proposed dB and multiplier, peak method and explicit Apply; manual/overlapping signals still require clipping checks.
- Source checkout and candidate are not deployed proof. Latest recorded completed production release remains the earlier Opus fix, combined hash prefix `da061b7b`, until the parent records an actual live artifact check. AAC/drag verification activity or a waiting service worker does not change that statement. No deployment or live check was performed here.

## Risk Priorities And Handoff

1. **Before UX implementation:** parent repairs F2-F5 in the plan/guide; resolve silent entry, phase routing, target selection, save completion and saved-versus-run identity. Do not implement by deleting guards.
2. **Before feature acceptance:** validate cue/save/lock/expiry races, inherited/reordered transition rules, immutable publications, all-phase readiness and transport cancellation. Analyzer corrections require same-blob evidence; version labels require build provenance.
3. **Before teaching-readiness claims:** physical iPhone Safari/installed-PWA, actual Bluetooth route, airplane-mode relaunch and full-class rehearsal, including holds, fades, interruption/manual resume and memory pressure. No design plan or desktop test guarantees these outcomes.

This pass used read-only documentation/source inspection and writes only this report. No terminal, Git, Azure, browser, audio analyzer, app execution or test tools were run. Focused editor diagnostics are the only requested post-write validation; runtime and independent user-usability evidence remain unverified. Guide/plan/contract repairs belong to the parent, not this report's writer.

## Documentation Recheck

After the parent revised the guide and plan, a separate read-only recheck found no
remaining blocking ambiguity for F2-F5/F7. The guide now has quick recipes and
mutually exclusive sharing choices. The plan defines phase/transport routing,
saved-setup permissions, pending-save edit freezing and generation checks. Local
document links were validated separately. This closes the documentation issues,
not the open runtime defects or physical-device acceptance requirements above.