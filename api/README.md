# Cloud HTTP API

## Uploaded Audio Management

September 17 source implementation; deployment status is recorded separately.
Public response interfaces are `LibraryMetadata`,
`ManagedAudioItem`, `ManagedAudioPage`, `LibraryUsagePage`, `LibraryDeleteResult`
in `shared/cloud-contract.ts`.

| Route | Contract |
| --- | --- |
| `GET /api/library/{songs,fillers}?cursor=...` | Author-only completed, non-deleted metadata page. |
| `GET /api/library/{songs,fillers}/{id}/metadata` | `{metadata}`, quoted metadata ETag; unknown initial revision 0. |
| `PUT .../{id}/metadata` | Exactly `{title,artist,bpm?}`, quoted If-Match; returns `{metadata}`. |
| `PUT .../{id}/intake` | Exactly `{filename,duration}`, If-Match `"0"`, only before metadata exists; returns revision 1. |
| `GET .../{id}/usage?cursor=...` | Bounded references, completeness and optional cursor; informational only. |
| `DELETE .../{id}` | Empty body, metadata If-Match; 200 `{deleted:true,bytesRetained:true}`, 202 `{pending:true}`, or explicit failure. |

Owner/editor, current-account, cookie, same-origin, CSRF and private/no-store
protections apply. Unknown/duplicate/inapplicable query parameters and unsupported
methods fail closed. No force or purge route. Upload remains the existing explicit
chunk/hash/signature-verified media protocol; intake cannot publish arbitrary media.
Title/artist permit unknown empty strings, max300 characters; optional BPM40..220.
Metadata JSON is capped at4KiB. Intake requires basename-only filename max300,
finite duration >0..1200 songs or >0..360 fillers. Duration is client-measured,
validated against a completed catalog asset, not independently measured by API.
Metadata writes preserve intake facts and never modify snapshots or recording
name/duration/hash. Initial title/duration/BPM fallback uses only verified current
routine/playlist references in one bounded scan; unavailable facts remain unknown.
Unknown legacy history blocks deletion, not description of a valid current draft. Edited titles
and BPM apply to future Add-track selection, not saved drafts/publications.

Songs deliberately includes every completed asset, even assets also used by filler
recordings. Fillers uses recording IDs and `kind:'filler'`; songs uses asset IDs and
`kind:'song'`. Thus overlap is explicit and unreferenced uploads are never hidden.
Deleting a song is blocked by retained filler descriptors. Filler deletion ignores
only its own descriptor, blocks other uses of the underlying asset, writes a
separate filler tombstone and retains the song asset. Legacy archived descriptors
remain readable, but legacy `DELETE /api/fillers/{id}` now requires metadata
If-Match and the SAME unused-only check (200 `{archived:true}` compatibility body,
202 pending). It cannot archive referenced audio anymore.

### Admission And Activation Gate

`library/gates/{assetId}` is a durable per-asset CAS record. Each new reference
claims that record before authoritative media/filler resolution, retains the claim
through immutable staging and the document head/filler record commit, and releases
only after definitive success. Save, save-and-lock, lock/unlock, duplicate, publish,
document deletion, every routine phase and filler, playlists, exact class-reference
assets and filler creation participate. Metadata writes also participate to fence
the DELETE metadata revision. Claim acquisition and closure compete on the SAME
ETag: either a writer is admitted and DELETE sees a blocker, or DELETE closes
admission and the writer cannot resolve/commit the new reference. Historical reads
do not consult admission; completed-upload replay cannot clear a tombstone.

**Operator gate is required; no configuration-free mixed-version barrier exists
in this BlobStore abstraction.** DELETE returns503 `library_delete_unconfigured`
until private control record `control/library-admission-v1` is exactly
`{"version":1,"exclusiveWriters":true}`. The API never creates this record and has
no activation endpoint. A separately authorized operator must first drain ALL old
workers/in-flight writers, establish that every writer uses this protocol, audit
retained discovery/head/history consistency, and only then attest activation.
No private records/settings were inspected or changed in this implementation.
The initial release intentionally leaves this activation gate unset. Listing,
upload, preview and metadata editing remain available; media Delete does not.
Routine deletion is a separate existing operation and remains available.
Rollback to an old writer requires disabling DELETE and draining checking work
first. Do not set this marker merely because one new worker is healthy.

Ambiguous writes, crashes and staged-but-uncommitted writes retain durable claims;
no timed expiry or automatic reconciliation. They return409
`reference_write_pending`, possibly indefinitely. Reconciliation requires an
operator to prove the writer is stopped and all staged/committed references are
known; no unsafe claim-clear HTTP route exists. Conservative quota exhaustion can
also retain a blocker. A safety gate is not a distributed transaction or lease.

With admission closed, DELETE scans retained routine/playlist/class heads (including
tombstoned heads), all linked drafts/publications, exact legacy class references
and retained filler descriptors. Unknown/gapped history, dangling indexes, missing
snapshots, descriptor mismatches and malformed storage return503
`reference_scan_uncertain`, retaining closure. Known use returns409 `media_in_use`
and reopens admission. Checkpoints are persisted in the gate; only the same
kind/ID/metadata revision can continue. Filler finalization first CAS-marks scan
completion, then writes its permanent tombstone before reopening asset admission.
No logical deletion path invokes physical `BlobStore.delete`; no storage refund,
purge or reclamation. Unsynced drafts on other devices are unknowable to Cloud;
new saves using deleted audio fail without changing those local drafts.

Finite limits:32 storage keys per manager page (including empty chunk-only pages),
128 keys per existing Add-track page, at most8 snapshot reads/8MiB payload/20seconds
per reference scan,32 scan steps,512 combined documents,128 retained revisions per
head and512 fillers. Gate is16KiB/max128 simultaneous claims per asset; each writer
claims at most256 unique assets. Metadata/gate writes use existing conservative
5GiB/20,000-operation quota controls. Completed catalogs remain bounded by4096
assets. Cursor size is4KiB for lists and8KiB for usage/checkpoints. Lists are not
transactional snapshots; usage GET is never authorization to delete.

### Validation

Run checks serially with Node22.12+ from the repository root. CI owns browser
verification; do not start local browser suites on the resource-limited workstation.

```sh
NODE_OPTIONS=--max-old-space-size=512 npm --prefix api test -- --pool=threads --maxWorkers=1 -t 'uploaded audio'
NODE_OPTIONS=--max-old-space-size=768 npm --prefix api test -- --pool=threads --maxWorkers=1 --bail=1
NODE_OPTIONS=--max-old-space-size=512 npm --prefix api run typecheck
NODE_OPTIONS=--max-old-space-size=512 npm --prefix api run build
```

New describe groups: `uploaded audio management HTTP (synthetic Blob store)`,
`uploaded audio durable admission races (two instances)`, and
`uploaded audio retained history and finite scans`. Existing shared-filler tests
now seed legacy archives explicitly for historical-read compatibility and test
current unused-only deletion separately. All are synthetic domain/HTTP-adapter
tests; they do not establish deployed ingress security or production activation.

## Approved Class Workflow

September 15 implementation: independent playlists and class setups use the real
private Blob adapter and existing account/session settings. No new resources,
environment names, account fields or media-upload formats. New tests are in the
existing `testing/cloud-api.test.ts` discovery path and `../tests/security.test.ts`.
Editor diagnostics were checked; these additions have **not been executed** in
this delegated pass. The parent/runtime owner must run:

```sh
npm --prefix api test -- --pool=threads --maxWorkers=1
npm test -- tests/security.test.ts --pool=threads --maxWorkers=1
npm --prefix api run typecheck
npm --prefix api run build
```

Public types are from `shared/class-plan.ts`. Complete bodies, not patches:

| Route | Request / Response |
| --- | --- |
| `GET /api/playlists` | `{playlists:MusicPlaylist[]}`; list entries omit media. |
| `POST /api/playlists` | `CloudMusicPlaylist {playlist,media}` -> same envelope, 201. |
| `GET /api/playlists/{id}` | `CloudMusicPlaylist`. |
| `PUT /api/playlists/{id}` | Complete `CloudMusicPlaylist` -> authoritative saved envelope. |
| `DELETE /api/playlists/{id}` | Empty body -> final `CloudMusicPlaylist`, with tombstone retained privately. |
| `POST /api/playlists/{id}/{lock,unlock,publish,duplicate}` | Same command rules as routines; returns `CloudMusicPlaylist`. |
| `GET /api/classes` | `{classes:ClassSetup[]}`. |
| `POST /api/classes` | `{setup:ClassSetup}` -> same envelope, 201. |
| `GET /api/classes/{id}` | `{setup:ClassSetup}`. |
| `PUT /api/classes/{id}` | Complete `{setup:ClassSetup}` -> authoritative saved envelope. |
| `DELETE /api/classes/{id}` | Empty body -> final `{setup:ClassSetup}`, with tombstone retained privately. |
| `POST /api/classes/{id}/{lock,unlock,publish,duplicate}` | Same command rules as routines; returns `{setup:ClassSetup}`. |
| `GET /api/classes/{id}/prepare` | `{setup,routine:CloudRoutine,walkIn?:CloudMusicPlaylist,walkOut?:CloudMusicPlaylist}`; exact resolved references. |

All lists, single reads and class prepare default to drafts. `published=true`
selects publications; `published=false` explicitly selects drafts. Players must
request publications and cannot mutate any collection. Single reads, prepare and
duplicate additionally accept `revision=N` (positive canonical safe integer),
including historical routine reads. Lists do not accept revision. Omitting it
selects latest; supplying it requires that exact committed version and state,
with **no fallback**. Duplicate accepts the read selectors and creates a new
unlocked/unpublished revision 1; playlist/routine occurrence IDs are independent.

All writes require current owner/editor account, same-origin session and CSRF.
Create requires unused ID, revision 1 and both state flags false. PUT and every
command except duplicate require quoted `If-Match`, such as `"3"`. Lock accepts
an optional complete envelope for atomic save-and-lock. Unlock, publish,
duplicate and DELETE require empty bodies. PUT/lock bodies retain the fetched
revision/flags; clients cannot set head pointers, authorship or publication state.
IDs retain the API's safe ASCII 1-80 character bound. Unknown fields, invalid
methods and unrecognized/duplicate/inapplicable query parameters fail closed.

Every successful single/command response includes the authoritative quoted ETag.
For example, publishing setup draft revision 3 returns `{setup:{...,revision:4,
published:true}}` with `ETag: "4"`; GET without `published=true` returns its separate
draft with revision 4 and `published:false`. Fetch that draft before further PUTs;
never PUT a publish response. Class prepare's ETag is the **setup** revision.
Choosing/preparing existing content performs reads, not saves or implicit locks.
423 (`class_locked`, `playlist_locked`, `routine_locked`) blocks all content,
reference, gain, announcement, publish and deletion changes. Explicit unlock is
required. Stale writes return 412 `revision_conflict`, never automatic retry.

Class references are exact `{id,revision,published}` objects. Missing references
return 404; malformed references return 400. Publication requires every routine
and playlist reference to resolve to an existing immutable publication. Draft
pins remain exact and author-only. Announcements are optional `Filler` values
with `mode:'hold'`. Playlist tracks require empty cues and absent `after`; repeated
assets are supported through distinct entry IDs and exact media-map descriptors.
Routine `Track.after` accepts only absent/inherit, `{mode:'none'}`, or
`{mode:'custom',filler,crossfade?}`. All custom recordings, including dormant final
gaps, are checked against authoritative retained library metadata on writes and
publication. Archive does not invalidate their references. Reads/preparation use
the committed descriptors, not a fresh mutable-library lookup.

Media manifest and chunk GETs retain `routineId` authorization, now optionally
with `revision`. New selectors are `playlistId=ID&revision=N` or
`classId=ID&revision=N`. For class authority N is the **published setup revision**,
not the routine/playlist revision. Exactly one authority is allowed; new
selectors require revision. Players receive only media from that exact
publication, including routine gaps and setup announcements. The server resolves
stored references; request bodies, descriptors and URLs never grant access.
Authors retain existing direct catalog access without a playback authority.

### Persistence And Limits

`src/cloud/documents.ts` owns create/save/lock/unlock/publish/delete for all three
types. Existing routine keys remain compatible. Playlists/classes use their own
`{collection}/{id}/head`, immutable `snapshots/` and `publications/` paths under
that ID, and `{collection}/index/{id}` discovery markers. Immutable staged keys
include random IDs to prevent competing writers from occupying a version path.
Exact revision reads consult the **committed head history link**, never infer a
path from a requested number or treat a staged object's existence as a commit.
History links and all current pointers commit together under the same head ETag.
CAS losers return 412; staged orphans remain charged and are never API-readable.

Each head holds at most 128 revision links and is capped at 64 KiB; no history
eviction. At the limit further versioned mutations return 409
`revision_limit_reached` before staging; duplicate to a new ID to continue.
The limit also applies to lock/unlock/delete, so do not assume an operation can
advance beyond it. Each envelope retains the existing 1 MiB input limit. Quota
reserves immutable payload bytes plus 64 KiB head allowance per mutation, and an
additional 4 KiB discovery allowance at create. The existing `routines` lifetime
quota counter now counts routines **plus** playlists **plus** classes, maximum
512 combined, including failed reserved creates. No new counter bypass, refund,
unbounded scan or giant serialized household document. Discovery uses bounded
128-key pages and rejects repeated/nonprogressing cursors. The existing 64 MiB
base reserve, 5 GiB byte quota, upload limits and seven audio types are unchanged.

Legacy heads without history can resolve only their actual current draft and
current publication pointers. Their next commit retains those known pointers;
older unknown revisions return 404 `revision_not_found` even if an old blob still
exists. A tombstone hides direct reads/listing and prevents ID reuse, but retains
history and all assets. Only exact **published** internal references may resolve
through routine/playlist tombstones when preparing an authorized class. Deleting
a playlist or routine cannot rewrite or break a published class that pinned it;
deleting a class itself removes its direct API access. No cascading asset deletion
or garbage collection is implemented.

## Current Implementation

`src/cloud/functions.ts` registers the real Azure Functions v4 HTTP handler for
`/api/{*path}`. It uses `AzureBlobStore`, not the historical in-memory repository.
The current username/password cloud contract supersedes the historical Entra
domain below. No `x-ms-client-principal`, caller-supplied role, public signup,
first-owner bootstrap, SAS URL, or browser token is trusted or issued.

This is implemented and locally tested, **not Azure-deployed or Azure-proven**.
Tests in `testing/cloud-api.test.ts` exercise real handlers/services against
explicitly fake Blob/Functions adapters. Azurite and Functions Core Tools were
not found on PATH; no Azure resources, settings or infrastructure were changed.
The agent's API-only ownership keeps these tests here rather than the requested
root `tests/cloud-api.test.ts` location.

## Server Settings

Set these only as server application settings, never `VITE_*`, browser storage,
tracked settings, command arguments, logs, artifacts or source credentials:

| Setting | Exact Contract |
| --- | --- |
| `FIM_ORIGIN` | One canonical HTTPS origin, no trailing slash, path, credentials or wildcard. Must match browser `Origin` exactly. |
| `FIM_STORAGE_CONNECTION_STRING` | Standard Azure public-cloud account-key connection string: `DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net`. Exactly those four keys, optional final semicolon. Account key must be canonical base64 for 64 bytes. No custom endpoints, SAS, HTTP or development-storage setting. |
| `FIM_STORAGE_CONTAINER` | Existing private Blob container, 3-63 lowercase letters/digits/hyphens, no consecutive hyphens. Never created automatically. |
| `FIM_ACCOUNTS_JSON` | JSON array of 1-32 exact account records, at most 32 KiB. See below. |

Each account has exactly `id`, `username`, `passwordHash`, `role`, `enabled`,
`authVersion`. IDs match `[A-Za-z0-9][A-Za-z0-9_-]{0,79}`; usernames are normalized
ASCII `[a-z0-9][a-z0-9._-]{0,63}`. Login trims and lowercases usernames, not
passwords. IDs and usernames must be unique. Role is `owner`, `editor` or
`player`; enabled is boolean; authVersion is a positive safe integer. At least
one enabled owner is mandatory. Unknown fields, malformed hashes and invalid
configuration fail closed with a sanitized 503 on every route.

Password hash format for Wicks' later setup helper:
`scrypt$32768$8$3$<32 lowercase hex salt characters>$<64 lowercase hex key characters>`.
Use Node asynchronous `crypto.scrypt`, UTF-8 password, random 16-byte salt,
32-byte derived key, `N=32768`, `r=8`, `p=3`, `maxmem=50331648`. Do not print or
log credentials. Runtime permits two concurrent hashes per worker, passwords
1-1024 UTF-8 bytes, constant-time derived-key comparison, and the same expensive
verification/error for unknown, disabled and incorrect credentials. No setup
helper or real credentials were generated in this pass.

## Authentication Contract

- `POST /api/auth/login`, JSON `{username,password}` -> `CloudSession` and
  `Set-Cookie`. Exact configured Origin is mandatory, including initial login.
  Switching from a valid existing session additionally requires its CSRF token
  and revokes that session before issuing another.
- `GET /api/auth/session` -> `CloudSession {user,expiresAt,csrfToken}`.
- `POST /api/auth/logout`, no body -> `{ok:true}`, durable revocation and expired
  cookie. Requires session, Origin and `X-CSRF-Token`.
- Cookie is `__Host-fim-session`, opaque 256-bit randomness, Path `/`, HttpOnly,
  Secure, SameSite Strict, no Domain. Only its SHA-256 digest indexes storage.
  Expiry is absolute 12 hours, with no rolling refresh. `expiresAt` is epoch ms.
- All writes require exact Origin and session-bound `X-CSRF-Token`, except
  initial login has no session token yet. Cross-origin Fetch metadata is denied.
  All JSON bodies use `Content-Type: application/json`; binary chunks use
  exactly `application/octet-stream`. Requests use same-origin credentials.
- Responses, including errors and media, are private/no-store with nosniff and
  no CORS allowance. A 401 is cloud sign-in required, never an instruction to
  stop playback, erase prepared media or redirect an offline class.
- Every operation reloads account configuration and reads the durable session.
  The session binds all configured account fields, so disable, role, username,
  password hash, authVersion and removal changes invalidate old sessions.
  Content commits recheck authorization after staging. Settings rollout must
  restart/drain all workers; process environments are not a globally atomic
  configuration database. Revocation cannot recall a response already sent or
  undo an already-authorized in-flight operation. Prepared offline copies are
  deliberately not remotely revocable.

Login admission is durable Blob CAS: eight randomly selected global shards,
eight attempts each per rolling 15 minutes (64 total maximum), and 64 fixed
username-hash buckets, five attempts each. Failed credentials consume admission;
collisions and contention may deny earlier. Retry-After is 900 seconds on login
throttling. Storage failure or exhausted CAS retries deny admission. All HTTP
traffic also has eight fixed shards of 64 requests/minute and 64 account-hash
buckets of 240/minute; fixed-window rollover can admit two adjacent windows.
No attacker-controlled username/IP can create unbounded throttle records.
These are application bounds, not volumetric DDoS protection or a cloud cost SLA.

## Routine Routes

Public shapes come from `shared/cloud-contract.ts`. Bodies are complete
`CloudRoutine {routine,media}` values, not partial patches. `media` has exactly
one immutable `CloudAsset {id,sha256,bytes,contentType}` per track-entry ID.
Every descriptor is checked against the private asset catalog. Existing strict
routine validation is reused: 100 tracks, 1,000 cues/track and a 1 MiB total
JSON bound. There is no 40-song hard count.

`Track.gain` and `Filler.gain` are independently optional finite numbers in
0..1.5. Missing means playback gain 1, not a stored default. Parsing, saves,
locks, copies and publications preserve both explicit values and absent fields;
there is no legacy-data migration or audio-byte transformation. Explicit null,
strings and other nonnumbers are invalid. Unknown fields, symbols, accessors,
inherited records and sparse arrays remain rejected by the strict parser.

| Route | Result |
| --- | --- |
| `GET /api/routines` | `{routines: CloudRoutineSummary[]}` drafts; add `?published=true` for publications. |
| `POST /api/routines` | Create supplied safe, unused ID at revision 1, unlocked/unpublished. Returns CloudRoutine, 201. |
| `GET /api/routines/{id}` | Draft; `?published=true` returns latest immutable publication, never draft fallback. |
| `PUT /api/routines/{id}` | Replace validated content; server advances revision. |
| `POST /api/routines/{id}/lock` | No body locks saved content; optional CloudRoutine atomically saves and locks. |
| `POST /api/routines/{id}/unlock` | No body; explicitly unlocks, advancing revision. |
| `POST /api/routines/{id}/publish` | No body; nonempty unlocked draft becomes a new immutable publication and advances head. |
| `POST /api/routines/{id}/duplicate` | No body; independent unlocked ID and new entry/cue IDs, preserving immutable asset references. Add `?published=true` to copy publication. Returns 201. |
| `DELETE /api/routines/{id}` | No body; revisioned tombstone, returns final CloudRoutine. ID cannot be reused. |

All mutations except create/duplicate require numeric quoted `If-Match`, e.g.
`"3"`, matching head revision. PUT/lock body metadata must match the saved
head; clients must not increment revision or mass-assign lock/publication flags.
Successful routine responses include the new quoted ETag and full CloudRoutine.
Owners/editors may mutate; players can only read published lists/snapshots.
Locked saves, publication and deletion fail even for owners. Explicit unlock is
required. Stale caller writes are never silently retried. Race losers return 412.

Publishing head revision R returns a **publication** CloudRoutine with
`routine.published: true`, `routine.revision: R + 1`, and ETag `"R+1"` (the
quoted numeric value). The separate saved draft has `published: false` at the
same revision immediately after publish. Owners/editors can continue updating
that SAME ID with PUT; publication does not make its unlocked draft read-only.
Fetch `GET /api/routines/{id}` without `published=true`, confirm the target and
revision, then PUT the complete draft CloudRoutine with its returned revision
unchanged and its ETag as `If-Match`. The server advances revision, not the
client. A concurrent change still rejects the save; do not retry automatically.

Do not PUT the publish response itself: `published: true` is invalid write
metadata (400 `invalid_routine_state`), not an editable publication. Reusing
POST create with an existing ID returns 409 `routine_exists`; it is not an
overwrite operation. Stale If-Match returns 412 `revision_conflict`; locked
content returns 423 `routine_locked`, including gain-only changes by an owner.
No force-overwrite or publication-edit endpoint is needed or exposed.

Snapshots/publications are immutable private blobs. Save, lock, unlock, publish
and delete commit through the **same** conditional routine-head ETag. Publication
bytes are never overwritten; later publication changes only the head pointer.
Exact historical reads and retained references now follow the Approved Class
Workflow section above. `heads/` holds tiny routine discovery markers; list reads
the authoritative heads, with the combined lifetime entity limit documented above.

## Shared Filler Library

The filler library is implemented and locally tested, not deployed or verified
against live Azure in this pass. It uses the existing private Blob container,
settings, session authentication and media upload protocol. No new resources,
account settings or public audio assets are required.

| Route | Body / Response |
| --- | --- |
| `GET /api/fillers` | Owner/editor only; 200 `{fillers:FillerRecording[]}`, active entries sorted by exact name then ID using deterministic code-unit ordering. |
| `GET /api/fillers/{id}` | Owner/editor only; 200 authoritative `FillerRecording` directly, including archived entries. Unknown safe ID: 404 `filler_not_found`; invalid ID: 400 `invalid_id`; player: 403 `forbidden`. |
| `POST /api/fillers` | Owner/editor only; exact JSON `{name,duration,asset}` -> 201 `FillerRecording {id,name,duration,asset}`. ID is a new server UUID, never supplied by the caller. |
| `DELETE /api/fillers/{id}` | Owner/editor only; empty body -> 200 `{archived:true}`. Repeating archive succeeds without another write. Missing ID returns 404 `filler_not_found`. |

POST and DELETE require the exact configured Origin and session-bound CSRF token.
Archive reads and conditionally replaces the SAME filler record using its Blob
ETag, with at most four contention attempts; it does not require a client
If-Match header. Account state is checked again after quota/index staging and
before record insertion or archive CAS. Players cannot manage or list fillers.

Name is nonblank plain text, at most 160 characters. Duration must be finite,
greater than zero and at most 360 seconds. The asset descriptor is exact
`{id,sha256,bytes,contentType}`: a safe existing catalog ID, lowercase SHA-256,
44 bytes through 128 MiB, and canonical `audio/wav`, `audio/mpeg`, `audio/mp4`,
`audio/ogg`, `audio/flac`, `audio/aac` or `audio/webm`. Unknown fields, inherited records, hidden fields,
accessors and symbols are rejected at every nested parser boundary. Descriptor
ID, byte count, SHA-256 and MIME must match the completed private catalog;
unfinished uploads are not catalog entries. Upload completion verifies actual
length and full hash and applies the existing bounded media signature checks.

**Duration remains declared metadata, not a server-measured playback duration.**
Filler POST does not decode audio or extract/catalog a WAV duration. The existing
WAV upload check validates PCM header geometry and its general 1,200-second
upload ceiling; it is not a 360-second filler-duration measurement. Compressed
signatures do not prove codec validity or actual duration. Native client import
and pre-class preparation must decode and validate the actual duration against
their six-minute bound; do not claim server-side full audio analysis.

Each recording uses a <=4 KiB private `fillers/records/{id}` record containing
`{recording,archived}` and a tiny retained `fillers/index/{id}` discovery marker.
The existing `QuotaBudget` reserves 8 KiB and one lifetime filler allocation
BEFORE either addition. There are at most 512 lifetime reservations, including
charged failed additions; missing legacy quota counters start at zero. Archive
does not refund quota. Listing reads pages of at most 128 markers and scans at
most 512, rejecting oversized, repeated or nonprogressing cursors. An index
marker staged before a failed record insert is skipped. No household snapshot
or unbounded index entity is created.

`routine.filler.sound = 'recording'` requires an exact embedded recording;
built-in sounds reject a recording property, even explicit undefined. Cloud
routine parsing resolves its ID against the retained library record, including
archived entries, and compares ALL recording/asset metadata. A valid asset with
a fabricated library ID, name or duration cannot be saved. The domain parser
alone checks shape, not cloud membership. Save, lock, publish and duplicate
preserve the descriptor without regeneration or fallback. Duplicate returns
only `{routine,media}`; the recording remains inside `routine.filler`.

Client integration: an explicitly approved household save of a local recording
must first upload its media, POST the library record and use that returned NEW
recording ID in the cloud routine. Do not send a device-local recording ID or
add a top-level recording field. This API pass does not implement the UI flow.

On a fresh client, GET by recording ID before treating an absent list entry as
device-local. A 200 returns `{id,name,duration,asset:{id,sha256,bytes,contentType}}`,
with no archive/origin flag or wrapper. Compare every field exactly against the
retained descriptor; a known mismatch must fail, never become a new import.
Only 404 `filler_not_found` permits offering an explicitly confirmed new import;
authentication, validation and storage errors do not prove local origin.
The lookup uses the same session/owner-editor checks as list, is private/no-store,
and never rewrites `{recording,archived:true}`, restores active status, reads
audio bytes or reserves quota. Existing traffic throttles still apply. No filler
PUT route is added, and routine PUT/descriptor resolution remains unchanged.

Archive removes only future list choices. Records, audio, saved drafts, locks
and raw immutable publications remain intact. Both media GET routes allow a
player's selected published routine to authorize its referenced recording asset,
even with filler mode `none` and after archive; unrelated or draft-only assets
remain denied. Owner/editor media access is unchanged. Prepared playback uses
the embedded snapshot and verified local bytes, not a live library query.

## Media Contract For Client Wiring

| Route | Body / Response |
| --- | --- |
| `POST /api/media/uploads` | JSON `{bytes,sha256,contentType}` -> 201 `{id,assetId,chunkBytes:2097152,chunkCount,expiresAt}`. SHA-256 is lowercase hex of complete bytes; size 44 bytes through 128 MiB. |
| `PUT /api/media/uploads/{id}/chunks/{index}` | Binary, zero-based index. Exactly 2 MiB except final remainder. -> `{index,sha256}` of that chunk. Upload sequentially; identical retries accepted, differing bytes rejected. |
| `POST /api/media/uploads/{id}/complete` | No body -> 200 CloudAsset directly ONLY after completion, or 202 CompletionPending with `Retry-After: 0` (exact shape below). Repeat with the same upload ID; never supply a cursor or asset descriptor. |
| `POST /api/media/uploads/{id}/abort` | No body -> `{aborted:true}`. Only open uploads; sealed/completed uploads reject abort. Owner or initiating editor only. |
| `POST /api/media/uploads/cleanup` | No body, owner only -> `{releasedSlots,more}`. Fences at most eight expired uploads per call and frees their active slots; never refunds byte charges. |
| `GET /api/media/{assetId}` | JSON `{asset,chunkBytes:2097152,chunkCount}`, not the whole file. |
| `GET /api/media/{assetId}/chunks/{index}` | Authenticated binary chunk, <=2 MiB, `application/octet-stream`, `X-Content-SHA256`, Content-Length, no-store. No Range, redirect, SAS or bearer URL. |

Upload requires owner/editor. Existing upload operations require its initiating
account or an owner. Players must append `?routineId={publishedRoutineId}` to
**both** media GET routes; server verifies the latest published snapshot actually
references the asset. Owners/editors may omit it. Clients concatenate chunks in
index order, verify full descriptor SHA-256 and decode/readiness locally before
declaring preparation complete. No live request is needed during a prepared class.

Completion has two disjoint response shapes:

```ts
// HTTP 200: final CloudAsset, no envelope and no pending/done fields.
{ id: string, sha256: string, bytes: number, contentType: string }
// HTTP 202, Retry-After: 0: acknowledged progress, NOT an asset.
{ pending: true, done: false, phase: 'copying' | 'publishing',
  copiedChunks: number, chunkCount: number }
```

Clients MUST branch on HTTP status before accepting a CloudAsset: `response.ok`
alone is insufficient. A 202 must not be saved in routine media, used to prepare
audio or shown as a completed upload. Repeat the empty authenticated POST with
the SAME ID using a bounded call count and total elapsed-time limit; stop on
expiry/authorization/hash errors. Healthy 64-chunk completion needs nine calls
(one hash phase, eight copy batches); allow additional bounded attempts for
deadline yields or transient failures. `Retry-After: 0` allows an immediate next
call, not an unbounded polling loop. The lead owns frontend/shared-contract
wiring; this API-only change does not implement that client loop.

The first successful call seals the immutable chunk map, checks every length and
chunk hash, validates the first 64 KiB header and hashes ALL chunks in order with
four bounded concurrent reads. Only an exact full SHA-256 match is CAS-persisted
on that sealed upload head as `finalization: {sha256,copiedChunks:0}`. It then
returns 202 copying/0 without creating any permanent chunks or catalog. No
partial or serialized cryptographic hash state is stored. Hash interruption
requires rehashing, never trusting a partially verified prefix.

Each later call copies at most eight chunks, starting at the persisted cursor.
Each immutable permanent write is checked against the validated chunk hash, then
the SAME upload-head ETag conditionally advances the cursor by exactly one.
Concurrent losers return 409 `upload_conflict`; they cannot overwrite bytes,
advance a stale cursor or publish. Retry reloads the durable head, not a
caller-supplied offset. A failed acknowledgement may cause one identical chunk
to be recopied/checked, but never restarts acknowledged copies or full hashing.
After the last chunk, CAS marks the head complete BEFORE creating the immutable
catalog. This fences cleanup against publication. A lost catalog/quota response
is recoverable from that complete head without any chunk reads, including after
upload expiry; completion already committed before expiry. A normal completed
retry returns the same CloudAsset. Legacy complete heads can return an existing
catalog but cannot create one without a verification marker.

The cooperative work budget is 20 seconds: copying yields a 202 with its durable
cursor, or phase `publishing` if all chunks committed and catalog work remains.
An unfinished hash returns 503 `finalization_timeout`; failed Azure I/O returns
503 `storage_unavailable`. A storage timeout may follow a successful write, so
retry reloads its head. No background job or in-request retry-until-success loop
is used. Existing quota reservations include both staging/permanent copies;
progress does not charge extra copies or refund failed work. Cleanup still only
releases expired active slots and never refunds byte charges.

Supported canonical content types: `audio/wav`, `audio/mpeg`, `audio/mp4`,
`audio/ogg`, `audio/flac`, `audio/aac`, `audio/webm` (the seven `MEDIA_TYPES`).
Upload bodies remain exactly `{bytes,sha256,contentType}` and catalog descriptors
exactly `{id,sha256,bytes,contentType}`. MIME parameters and aliases are not
canonical; adding types does not add fields, coerce numbers or alter quota.
Raw chunk responses stay `application/octet-stream`; MIME is descriptor metadata,
never an authorization token. Both existing GET routes require the same session
and published-asset authorization for every type; no public route is added.

WAV validates RIFF sizing, PCM 8/16/24/32-bit or
float32, mono/stereo, 8-96 kHz, block/byte rates and <=1200 seconds. WAV data must
be the final chunk; format/data headers must fit the initial 64 KiB. MP3 checks
Layer III framing after bounded ID3; Ogg checks Opus/Vorbis BOS identification;
FLAC checks STREAMINFO framing.

MP4 walks sized atoms from byte zero, permitting leading `free`, `skip` and
`wide` atoms before a complete `ftyp` with the existing supported major brands
(`M4A `, `M4B `, `isom`, `iso2`, `mp41`, `mp42`). Both 32-bit and extended
64-bit sizes must fit the asset and inspected prefix. No magic search inside
padding, size overflow, oversized atom, or missing/out-of-prefix `ftyp` is
accepted. This is NOT a full MP4 track/protection inspection.

ADTS AAC walks frame lengths from byte zero with at least two complete frames.
It checks sync/layer, Main/LC/SSR profile, defined sample-rate index, mono/stereo
channel configuration, one raw data block per frame, CRC-aware header length,
consistent stream configuration and frame bounds against the asset. A frame may
cross the 64 KiB inspection boundary after two complete frames; payloads, CRCs
and the remainder of the stream are not decoded or verified as AAC. ADTS with
leading metadata or unsupported header modes returns an explicit upload error.

WebM parses bounded EBML element IDs/sizes, a `webm` DocType header, a Segment
(including common FFmpeg unknown-size Segments), and complete Tracks metadata
before the first Cluster. Every TrackEntry must be audio with `A_VORBIS`,
`A_OPUS` or `A_AAC`, a positive track number/UID, mono/stereo audio metadata
and sensible sample rates when present. Video tracks, Video elements and
ContentEncodings on TrackEntry are rejected, including when beside a valid
audio track. Unknown-size metadata, invalid/oversized element sizes, duplicate
critical fields and required metadata beyond 64 KiB fail `415 unsupported_media`.
Only Segment/Cluster can have unknown sizes; cluster payloads and later metadata
are not inspected. CodecPrivate data and actual audio packets are not validated.

These bounded structural signatures **do not prove codec validity, duration,
native playability, absence of all video/protection, or decode success**. In
particular MP4 brands alone cannot exclude DRM or video, and WebM checks cover
only the inspected metadata. Full client container inspection and actual local
decoding remain required. Malformed/protected input must fail; do not treat the
server accepting a small header fixture as comprehensive DRM validation.

Native-playable ADTS AAC and supported audio-only WebM retain exact source bytes,
MIME and SHA-256 through upload, song/filler save, duplication, publication and
authenticated chunk download. The API never transcodes. The client import policy
converts new Opus and eligible unsupported, non-protected audio to AAC-LC M4A at
a 256000 bit/s target; `A_OPUS` recognition here preserves existing immutable
assets, not an exemption from that new-import policy. Previously stored assets
are never silently converted or relabeled on download. Large header regions or
unsupported structures return an explicit upload error, not server conversion.

HTTP never buffers the whole 128 MiB file: hashing prefetches at most four <=2 MiB
chunks, and copying reads one chunk at a time. Chunks are immutable, completion
seals the upload head, and catalog publication occurs only after validation and
all permanent copies commit. Only one completion and four
total API requests run concurrently per worker. Body read deadline is 10 seconds,
Azure request deadline 35 seconds, individual Azure I/O 12 seconds; host timeout
45 seconds. Download streams are destroyed on either storage deadline, including
a stalled body after successful headers. Interrupted uncommitted completion is
retryable while the 24-hour upload is live.

## Storage And Lifecycle Gate For Wicks

Use an isolated Azure Blob account/container. Disable public Blob access at the
account and container. Handler also checks container access policy before serving
requests. Do not enable Blob versioning or soft-delete copies in this quota-scoped
store without revising accounting. Credentials remain server settings; no managed
identity assumption for SWA Free. Runtime never provisions or changes ACLs.

Key prefixes: `sessions/`, `throttle/`, `traffic/`, `control/quota`, `heads/`,
`routines/{id}/head`, `snapshots/{id}/`, `publications/{id}/`,
`uploads/{id}/{head,chunks/index}`, `assets/{id}/{catalog,chunks/index}`,
`fillers/index/{id}`, `fillers/records/{id}`.
Storage JSON is private. There is no Table dependency or household-content JSON.

`control/quota` is a small CAS ledger of counters plus at most 64 upload IDs.
Limit: 5 GiB conservative allocation, including 64 MiB reserved control/session
overhead, two media byte copies (staging + permanent), 128 KiB/upload overhead,
snapshot/head costs and abandoned/failed operations. Also bounded to 64 active
uploads, 4,096 lifetime upload allocations, 512 lifetime routine allocations,
512 lifetime filler allocations and
20,000 ledger-charged mutations. Reservations happen **before** allocating blobs.
Contention retries are capped at four. Failed CAS, failed hashes, duplicate create
races and deleted routines remain charged; cleanup frees upload slots only.
Thus usable media capacity can be below 2.5 GiB, not a promised 5 GiB library.
Forty ordinary songs are a workload target, not a worst-case-size guarantee.

Mandatory lifecycle rules, owned by infrastructure and **not applied here**:
- Delete `sessions/` base blobs after two days since modification; server enforces
  the stricter absolute 12-hour TTL regardless of physical deletion.
- Delete `uploads/` base blobs after seven days since modification. Upload
  operations expire after 24 hours. Call owner cleanup to release expired slots,
  including interrupted initiation or sealed failed uploads. Physical deletion
  alone does not refund the ledger or release slots.
- Never lifecycle-delete `control/`, `throttle/`, `traffic/`, `heads/`, `routines/`,
  `snapshots/`, `publications/`, `assets/` or `fillers/`. Committed media is not staging.
  The new private `fillers/` prefix must retain the existing default-safe
  treatment for prefixes outside the session/upload expiry rules; no lifecycle
  changes are made here.

No automatic refund, asset deletion or snapshot GC is claimed. Failed completion
can leave charged permanent chunks without a catalog. Before capacity exhaustion,
review an out-of-band reconciliation/GC procedure with writes stopped; never reset
the ledger, delete a live head or refund before immutable data is demonstrably
unreferenced. Lifecycle operation, storage billing and physical retention remain
deployment validation gates. No unattended cleanup scheduler was deployed.

## Package And Deployment Contract

API has its own pinned package and lockfile: `@azure/functions` 4.16.2,
`@azure/storage-blob` 12.28.0, esbuild 0.25.12, TypeScript 6.0.2,
Vitest 4.1.11, Node types 22.19.15. Runtime is Node 22.12+ (<23).
From repository root with the required Node binary first on PATH:

```sh
export PATH=/home/kemmie/.npm/_npx/4bb4bc87b1b72b6c/node_modules/node/bin:$PATH
node /home/kemmie/.npm/_npx/e609a7c1edf98e65/node_modules/npm/bin/npm-cli.js --prefix api ci
node api/node_modules/vitest/vitest.mjs run --root api --config vitest.config.ts --maxWorkers=1 --pool=forks --reporter=json --outputFile=test-results.json
node api/node_modules/typescript/bin/tsc --project api/tsconfig.json
node /home/kemmie/.npm/_npx/e609a7c1edf98e65/node_modules/npm/bin/npm-cli.js --prefix api run build
node /home/kemmie/.npm/_npx/e609a7c1edf98e65/node_modules/npm/bin/npm-cli.js --prefix api audit --omit=dev
```

The alternative cached CLI avoids this machine's npm 10 `edgesOut` failure. No
root install is needed. `npm --prefix api test/typecheck` are scripts via
`npm --prefix api test` and `npm --prefix api run typecheck` respectively.
JSON result is `api/test-results.json` (API-root relative).

Build from the full workspace so esbuild can include the shared contracts/parser.
`package.json` main is `dist/functions.cjs`; that bundle includes application,
shared validation and Blob SDK code, with `@azure/functions` external. The
managed Functions artifact root must contain `host.json`, `package.json`,
`package-lock.json`, `dist/functions.cjs` and production `node_modules/` installed
from this API lock in a **separate reviewed staging directory**. Skip API rebuild
for a prebuilt artifact; do not ask Oryx to compile a source-only API without
its shared workspace inputs. Runtime dependencies can be installed there with
`npm ci --omit=dev`; do not copy dev dependencies, tests, reports, raw environment,
local settings or household media. Do not stage the API inside public static
assets. Wicks owns SWA Free managed Functions/runtime selection (`node:22`),
server settings, private-storage lifecycle, public-static/private-API routing,
artifact review and explicitly authorized deployment. App-level HTTP auth uses
Functions `authLevel: anonymous` intentionally: every private route authenticates
our cookie independently, with no SWA principal-header shortcut.

Required live gates: real HTTPS cookie/Set-Cookie behavior through SWA, exact
Origin/CSRF enforcement, direct unauthenticated/spoofed-header rejection, settings
rollout/revocation, real Azure ETag conflicts and failure recovery, 2 MiB binary
ingress/egress and each phase of 128 MiB completion within managed timeouts, lifecycle deletion,
quota workload and real 40-song iPhone offline/Bluetooth preparation. None is
established merely by the fake-adapter tests or a successful bundle.

Errors are JSON `{error:stable_code}`; meaningful statuses are 400 validation,
401 sign-in/credentials, 403 permissions/Origin/CSRF, 404 missing, 409 upload or
ID conflict, 412 stale revision, 413 request bytes, 415 unsupported media/type,
422 media hash mismatch, 423 locked, 428 missing If-Match, 429 throttled,
503 unconfigured/unavailable/busy and 507 allocation exhausted. No exception,
password, token, cookie or storage setting is logged/echoed by application code.
Platform telemetry must likewise exclude headers, bodies and sensitive settings.

## Historical Domain Reference (Test Only)

Everything below describes the older dependency-free Entra-shaped services in
`src/{auth,memberships,repository,routines,validation}.ts`, not the deployed-boundary
design above. Only strict content validation is reused. `HouseholdRepository`
and `testing/in-memory-repository.ts` are not imported into the cloud HTTP path.
Entra/membership adapters discussed below remain unimplemented and are **not used**.

## Trust Boundary

`src/auth.ts` defines the nominal `VerifiedPrincipal` adapter input: immutable
tenant/object identity plus delegated scopes, with no client role. The brand is
compile-time guidance, **not cryptographic proof or runtime authentication**.
There is intentionally no JSON/header/JWT decoder or production principal factory.
The test file casts synthetic fixtures to this type; these casts authenticate nobody.

STILL REQUIRED before exposure to traffic:

- Real Entra/platform validation of signature against trusted rotating signing
  keys, exact issuer/tenant and audience, token lifetime, permitted calling client
  and delegated scope. Configure the platform to reject anonymous requests with
  401; test direct-origin bypass and expired/wrong-issuer/wrong-audience tokens.
- A trusted server-side adapter producing `VerifiedPrincipal` only from that
  verified context, never request JSON, arbitrary JWT claims or an arbitrary
  `x-ms-client-principal` header. Strip/block spoofable headers at the actual ingress.
  Keep the verified principal immutable and out of browser-controlled storage.
- Active household membership and role lookup for every operation. The core does
  this inside its repository transaction, not from body roles or cached claims.
  The configured exact tenant and scope are also checked by the core. Final scope
  registration and policy configuration belong to the real adapter integration.
- Approved out-of-band initial owner provisioning and recovery. An empty test
  household is inaccessible, not permission to make its first visitor an owner.

## Service Contract

Construct `RoutineService` and `MembershipService` with a trusted repository and
`{ tenantId, requiredScope }`. These are server-side dependencies, not user input.
All public operations return promises and take a principal plus household ID.

| Operation | Owner | Editor | Player |
| --- | --- | --- | --- |
| Read/list published snapshots | Yes | Yes | Yes |
| Read/list drafts | Yes | Yes | No |
| Create/save/publish/delete/lock/unlock/duplicate | Yes | Yes | No |
| List/change/remove memberships | Yes | No | No |

Unknown or inactive members are denied. Routine IDs are household-scoped; authors
leaving does not delete the household's work. No publication read falls back to a
draft, including reads by a guessed revision.

`create(principal, householdId, content)` and
`save(principal, householdId, id, expectedRevision, content)` accept unknown bodies.
Content is the complete editable replacement, not a patch or a full `Routine`:
`schemaVersion`, `name`, `tracks`, `filler`, `crossfade`, `beepEvery`, `beepRemaining`.
Optional `beepOnceRemaining` accepts finite numbers from 0 through 1200 seconds;
0 or omission disables this single warning without changing `beepRemaining`'s
countdown. Omitted values remain absent rather than being defaulted. The warning
is shared content protected by locks and retained in duplicates and publications.
`id`, `revision`, `locked`, `published`, roles and all other unknown fields are
rejected, never assigned. Nested records must contain exactly the schema fields.
Accessors, custom prototypes, symbol/hidden fields, sparse/exotic arrays, nonfinite
numbers and wrong primitive types are rejected before `shared.validateRoutine`.
Plain JSON/null-prototype records are supported; this parser is not a sandbox for
executing arbitrary JavaScript proxies. Host adapters must enforce request-byte
limits before parsing JSON. IDs are nonblank strings up to 160 characters; cues
are bounded to 1,000 per track; counts are positive safe integers. Other content
bounds follow the shared validator, with numeric magnitude capped at safe-integer
range. Text is preserved literally, never treated as markup.

`publish`, `delete`, `lock` and `unlock` have the same first four arguments as
`save`. Every command requires a positive safe-integer expected **head revision**.
All five mutations compete on that same head, including publication pointer
updates. Every successful command advances it, even a repeated explicit lock or
unlock. Locked save/publish/delete fail for owners too; any active owner/editor
may explicitly unlock. Missing revision is checked before lock state; valid but
stale writes against a locked head return 423, and against an unlocked head 412.
Authorization precedes existence/state checks. Revision exhaustion fails closed.

Drafts always have `published: false`. Publishing requires at least one valid
track, revalidates saved content, advances the head and appends a separate frozen,
cloned snapshot with `published: true`. Publication revision is its head revision
at creation, so publication numbers can have gaps. `getPublished(..., revision?)`
returns the selected historical snapshot or the current published pointer; draft
edits, locks and later publishes never rewrite earlier snapshots. Snapshot lock
flags describe publication time, not current head lock state. A failed operation
changes neither head nor publication state.

`duplicate(..., source)` accepts `'draft'` (default) or a published revision number.
It may copy a locked source since it never mutates that source. The new routine
has a generated ID, revision 1, no publications, and is unlocked. Deletion creates
a revisioned tombstone, hiding the head and its snapshots from all service reads;
physical retention/cleanup is not implemented. Already returned copies remain
unchanged. Repository results and inputs must never share mutable stored references.

Membership `list` returns `{ revision, members }`. Owner-only `set` takes that
household-wide membership revision and exactly `{ tenantId, objectId, role, active }`;
`remove` takes the revision and exactly `{ tenantId, objectId }`. This is explicit
owner administration, not a way to supply the acting user's role. Mutations advance
the membership revision and atomically preserve at least one active owner, including
concurrent self-demotion, mutual demotion, disabling and removal. A stale retry must
refetch and reauthorize; no operation silently promotes a replacement owner.

## Error Mapping

`ServiceError` exposes a stable `status` and `code`; an HTTP adapter still needs
to map them to bounded responses without leaking tokens or internal errors.

| Status | Meaning |
| --- | --- |
| 400 | Invalid runtime body, revision format, or unpublishable content |
| 401 | Missing/invalid principal input; real token rejection is adapter work |
| 403 | Wrong scope/tenant, inactive/missing membership, role denial, last owner |
| 404 | Missing/deleted routine, unpublished revision, household or member |
| 412 | Stale head/membership revision, revision exhaustion or identity conflict |
| 423 | `routine_locked` |
| 428 | `revision_required` |

## Persistence Is Not Implemented

`HouseholdRepository.transact` is a semantic contract: authorize current membership,
read/check/mutate atomically, commit only on success, return detached results.
Callbacks must be synchronous, have no external side effects and retain no live
storage references. The test repository serializes all callbacks within one
instance/process and clones the entire household for rollback and isolation. Two
service instances sharing that repository participate in the same queue; separate
repository instances or processes do not. This is **not an Azure transaction**, an
ETag implementation, durable storage, or a production scalability design.

STILL REQUIRED: a real Table CAS adapter/design using the SAME head entity ETag
for saves, publishing, deletion and locks, and an atomic household membership
guard/version for concurrent owner changes and membership revocation versus routine
writes. Document entity partitioning and conditional batch limits; never replace
the test transaction with independent read/check/write requests. Serialize or
conditionally guard the membership version together with writes in supported
same-partition transactions. Reevaluate authorization/lock state on conflicts;
do not blindly retry a stale client revision or automatically unlock.

For large routine content, stage immutable private Blob content, then conditionally
commit the Table head pointer. Blob and Table writes are **not one transaction**;
orphan cleanup, failed conditional writes, immutable-object write protection,
idempotency and publication-read consistency still need integration tests. Never
try to serialize this in-memory household/map into one giant Table entity.

This core does not verify media existence/readiness, issue media grants, implement
uploads, HTTP/CORS, audit persistence, token expiry, cloud revocation or deployment.
Unit tests establish local domain semantics only, not deployed Azure security.

## Focused Verification

From the repository root:

```sh
npx --yes --package=node@22 --package=npm@11 npm test -- tests/security.test.ts
```

No new dependencies are required. Do not run a frontend build as proof of this
kernel's security or while other owners are editing frontend files.