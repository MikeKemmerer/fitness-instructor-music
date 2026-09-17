# Testing And Physical Instructor Pilot

## Current Verification Scope

September 16, 2026: unified Routine changes are implemented in source, awaiting
remote verification. The [R01-R24 acceptance checklist](plan.md#unified-routine-acceptance-r01-r24)
lists every requested behavior, confirmed source fixes and remaining limits. This documentation update
ran Markdown editor diagnostics only, no commands, build, browser/native/WASM tests,
Git operations, servers or Cloud actions. No new deployment is claimed.

**This resource-limited workstation uses Azure for interactive handoff. Do not
start or restore local preview/dev servers or run local-server browser suites here.**
Use synthetic remote CI for browser/native/WASM integration and screenshots;
separately authorized workstation checks must be serial, memory-bounded and
non-server. Existing browser passes cover older source, not this revision.

The latest supplied Fonda result reports **644 passing tests**; it was not rerun
by this docs pass and is not a remote CI or new browser/native/WASM result. All
24 acceptance boxes remain unchecked awaiting remote CI. Source review confirms
the reported revision-label, phase-spacing, recovery-placement, checkbox-menu,
single-toolbar, failure-only Retry, adopted-phase gain/percentage placement,
Settings blank-BPM/picker, and inline/background error-expiry fixes. Do not list
those as missing implementation while waiting for remote behavioral evidence.

Remote acceptance must cover the complete Routine through local-first Save,
Cloud pending/reconnect/reload under the same validated user, lost acknowledgment,
conflicts/locks, immutable publication, one history, chooser/filter/favorite states,
Create/Duplicate/existing audio, Settings playlist adoption and Close decisions.
Verify silent automatic preparation on Open/startup/Teach, stale-load cancellation,
active-playback confirmation, all phases/fillers/cues/gains and no implicit Publish.
Exercise Hold's blank duration, source-length parentheses/looping, unknown BPM/count
guards, custom/built-in filler BPM, legacy >125% preservation, and 30-second error
display without clearing safety state. Close every R01-R24 acceptance check with evidence.

Specifically verify checkbox-menu keyboard/Escape behavior and the single wrapping
toolbar at desktop/mobile sizes; recovery immediately below metadata; Retry only
after preparation failure; percentages below all content sliders; and owned-phase
gain edits/Undo without source-playlist changes. Test From Audio Library in both
Routines and Settings: metadata-only online browsing, ordered insertion, cancellation,
identity/role/lock guards, and offline known-cache size/hash validation rejecting
missing/corrupt bytes. Cloud playlist editing remains online-only. Cover optional
Settings BPM, unchanged redraws that do not restart error timers, new errors that
do, and expiry on return from a background tab without clearing validation or
pending/auth/playback state. Decision dialogs must stay open.

Remaining source limits need resolution or explicit acceptance: Local/Cloud mirror
rows can appear separately, favorites are browser-session scoped, and no preview
exists inside the picker before insertion. Offline cached browsing and Settings
picker reuse are implemented, not remaining gaps.

The loudness gate must test the actual measurement path and `recommendLoudness`:
-8 LUFS reference, +/-3 LU deadband [-11, -5] inclusive, normals at unity, quiet boosts capped
at 1.25 and available -1 dBFS sample-peak headroom, no quiet boost when headroom is
at or below unity, loud-outlier reduction using the smaller of desired gain toward
-5 and headroom, and separate clipping warnings. Verify raw
measurement reuse only for matching audio hashes and recomputed recommendations.
Browser/native/WASM comparisons for this revision remain pending. Synthetic remote
fixtures or non-identifying aggregate calibration numbers are allowed; private
song/routine names, per-song tables, identifying hashes and real audio are not.
Numerical agreement is not proof of equal perceived loudness or clip-free mixing.

The supplied read-only Cloud calibration completed successfully for **14 of 14
songs**: median approximately -8 LUFS, median absolute deviation approximately
0.9 LU; 12 normal proposals at 100%, one quiet at 100% without safe boost headroom,
and one quiet capped at 125%. This is 13 unity proposals, not 13 normal songs.
Calibration was not rerun during this docs pass and does not close the new remote
browser/native/WASM or human-listening gates. No identifying report paths or media
footprint are included in public documentation or CI.

The user approved commit/push/merge/deploy after green gates; those operations belong
to the lead/release executor, not these docs. Require a new final release receipt
and live checks before calling this revision deployed. Report the known source-
archive HTTP packaging issue separately. Never restore a local preview after upload.

## Physical Instructor Pilot

Record results privately, not in public GitHub test artifacts. Before a rehearsal,
record device/OS/browser or installed-PWA version, app build, speaker/connection,
routine revision, class duration, available storage and power arrangement. Start
with the instructor's actual iPhone/iPad and speaker, then desktop/tablet backups.
Hardware inventory and 3-5 pilot participants still need user confirmation.
No human phone/Bluetooth verification is recorded for this revision.

| Scenario | Procedure | Pass Condition |
| --- | --- | --- |
| Preparation | Open a saved whole Routine with distinct arrival/departure songs, both announcement loops and custom gaps; open Teach and wait | All phases listed; missing audio blocks Ready; automatic preparation and Class Mode entry stay silent until Play |
| Normal class | Run 45-90 minutes or the longest intended class with pauses and long holds | No app-caused stop, unexpected transition or lost cues |
| Offline | Open online, wait for automatic preparation/offline readiness, enable airplane mode, reload, wait and explicitly Play | Complete cached class operates without login/network-dependent playback; no automatic resume |
| Cloud expiry | Let the server session expire while playing | Prepared playback continues; cloud authoring requests require sign-in |
| Pending Save | Save changes offline, verify Saved on this device / Pending Cloud, close/reload, reconnect as the same validated user | Local saved work survives and only queued saved content synchronizes; unsaved later typing is not uploaded; conflict retains local copy |
| Close decisions | Change cues and a phase, try Cancel, then Save or Discard changes; confirm stopping playback | Cancel keeps editor/playback; local failure blocks Close; durable pending Cloud permits it; completed Close releases audio without deleting library/media |
| Levels and BPM | Compare unity, a capped quiet proposal, no-headroom quiet material and legacy >125%; try seconds cues with blank BPM and count cues without BPM | Honest gain/warnings, no silent legacy clamp or fabricated BPM; count cues require a valid grid; record listening rather than promise perfect equality |
| Speaker interruption | Disconnect/reconnect Bluetooth and select the intended output | No surprise replay; record actual platform behavior and manual recovery |
| Calls/assistant/screen lock | Interrupt during a song, fade and held filler | Record stop/resume behavior; no unsupported background-playback claim |
| Draft recovery | Edit without Save, wait for recovery acknowledgment, reload, restore a copy | Work recovered under a new ID; original saved revision unchanged |
| Undo | Edit, Save, Undo, then inspect both prepared and saved versions | Undo creates an unsaved edit; no publication or playing-snapshot mutation |
| Storage pressure | Test on a separate synthetic profile with constrained storage | Failure shown honestly; no silent eviction of recovery copies |
| Identity change | Sign out after creating a synthetic recovery copy | Private drafts/audio/recoveries removed before another user enters |

Foreground-only teaching is the current pilot assumption. Screen locking,
background playback, calls and Bluetooth behavior require observed results before
they are supported promises. Reload/crash playback-position recovery is deferred;
after reload wait for automatic preparation of the restored selection and explicitly
press Play. A deliberately closed Routine must be reopened from the chooser first.
Do not use private real-class traces in CI.

Pilot targets are 20 completed classes with zero app-caused stops/lost edits and
recorded handling for each interruption, not a claim of current acceptance. Note
every failure and compare authoring/navigation time with an observed baseline.
If browser constraints prevent the required workflow, review native audio and
budget before implementation rather than assuming a web wrapper solves it.
## Other Machines: Windows And WSL

**All server, certificate, forwarding and firewall instructions below are retained
only for a different, adequately resourced development machine. Do not run them on
this workstation.** The current handoff uses the existing Azure HTTPS app after
the release gate; do not replace that handoff with a local preview. Any future
exception here requires explicit user approval.

Vite development and preview bind to `0.0.0.0`, not just loopback. A WSL NAT address is not the Windows Ethernet/Wi-Fi address. Windows localhost forwarding alone does not expose a WSL server to other LAN devices.

### Trusted HTTPS

The app requires a secure context for cryptographic IDs, integrity checks and offline service workers. Desktop `localhost` is an exception; `http://<LAN address>` is not. An HTTP page now shows an HTTPS-required message rather than crashing. Browser certificate warnings alone are not a reliable way to establish a trusted secure context on a phone.

Use a development certificate covering the Windows LAN hostname/IP you will open, issued by a CA trusted by the phone (for example, a deliberately installed local development CA). Never share the CA private key. Keep the server certificate/key under ignored `local-media/certificates/`. This project does not install a CA or change trust settings automatically.

On that other machine, from the project directory in WSL, after the certificate is available:

```sh
export REHEARSAL_HTTPS_CERT="$PWD/local-media/certificates/lan.pem"
export REHEARSAL_HTTPS_KEY="$PWD/local-media/certificates/lan-key.pem"
npm run build
npm --prefix frontend run preview -- --port 5208 --strictPort
```

Both variables are required together. They configure development/preview only, not an Azure deployment. Omit both for ordinary desktop localhost HTTP tests. Changing the origin (scheme, address or port) creates a separate browser store; import or prepare the two test songs on the phone rather than expecting the desktop library to appear there.

### WSL NAT Forwarding

Inspect the active physical interface on Windows and the WSL address first. If a forwarding rule already exists for your port, review it rather than blindly replacing it. WSL addresses can change after restart. No router port forwarding or public tunnel is needed.

An administrator must run the following in Windows PowerShell, substituting the current addresses and active Ethernet/Wi-Fi interface. Limit exposure to the trusted Private network and local subnet:

```powershell
$WindowsLanAddress = '<Windows LAN IPv4>'
$WslAddress = '<current WSL IPv4>'
$Interface = '<Ethernet or Wi-Fi interface name>'
$Port = 5208
netsh interface portproxy add v4tov4 listenaddress=$WindowsLanAddress listenport=$Port connectaddress=$WslAddress connectport=$Port protocol=tcp
New-NetFirewallRule -Name 'FitnessPreview5208' -DisplayName 'Fitness preview LAN 5208' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -LocalAddress $WindowsLanAddress -RemoteAddress LocalSubnet -Profile Private -InterfaceAlias $Interface
```

Open `https://<Windows LAN IPv4>:5208/` on the phone after trusting the matching certificate. Do not use the WSL address or `127.0.0.1` on the phone. Guest Wi-Fi/client isolation can still block peers. A firewall permission error requires the owner/administrator; the agent must not bypass it.

Remove only the rules you added when finished (Administrator PowerShell):

```powershell
netsh interface portproxy delete v4tov4 listenaddress=$WindowsLanAddress listenport=$Port
Remove-NetFirewallRule -Name 'FitnessPreview5208'
```

### Other-Machine Acceptance

The standalone local build has no Cloud authentication; expose it only to the
trusted household network. The static server must not expose `local-media/`,
certificates or private songs. Use the explicit file picker. Test two songs,
preview/cue controls, recorded filler, pause/resume and Bluetooth. Save the complete
Routine, open Teach and wait for automatic preparation, then close/reopen the
installed app and test airplane-mode playback. This is distinct from the editor's
Close routine command, which deliberately clears active selection. No desktop test
establishes phone reliability. The existing authenticated Azure HTTPS app is the
current workstation handoff; new source changes require their own verified release.