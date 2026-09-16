# Bundled Assets

Household music is never bundled. The exception is the specifically licensed public filler recording tracked in `licensed-media.json`; source and emitted bytes are hash-checked by the privacy gate and the runtime/offline worker.

## Lo-fi Instrumental

- Source: [lofi hip hop by omfgdude](https://opengameart.org/content/lofi-hip-hop).
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/), as stated on the source page at retrieval.
- Version: `lofi-hip-hop-v1`, 16-second conditioned excerpt, 22,050 Hz mono PCM16. Exact source/derived hashes and transformation are in `licensed-media.json`.
- Original recorded pitch and tempo retained; not tempo-matched or pitch-shifted. A conditioned repeat is not a guarantee of perfect phrase alignment for every song. Audition before teaching.
- Existing saved synthetic sounds are retained; choose **Lo-fi instrumental (CC0)** explicitly for an existing routine. Future revisions of this recording require a new asset ID, never overwriting these bytes.

## PDF Font

Noto Sans Regular from [Noto Fonts](https://github.com/notofonts/noto-fonts), distributed under SIL Open Font License 1.1. The unmodified font includes its upstream metadata; the full license ships in `frontend/public/licenses/NotoSans-LICENSE.txt` and the production distribution. PDF generation embeds this font; the font's license does not apply to the generated document.

Font SHA256: `b85c38ecea8a7cfb39c24e395a4007474fa5a4fc864f6ee33309eb4948d232d5`.

The current PDF exporter supports its validated Latin, Greek and Cyrillic text range. It reports unsupported characters instead of silently dropping them; Excel preserves arbitrary Unicode strings. UI remains US English.

## Local AAC Conversion

### Implementation And Limits

`frontend/src/audio-conversion.ts` exports `convertToM4a(file, { signal }?)`, returning `{ blob, duration }`. The blob is real AAC-LC in MP4/M4A (`audio/mp4`), not renamed source bytes. A locally compiled, audio-only **FFmpeg 5.1.4 LGPL-2.1-or-later** core provides the native AAC encoder, demuxers, resampler and MP4 muxer. The earlier GPL `@ffmpeg/core@0.12.10` dependency has been removed from the frontend package and lockfile. No MediaRecorder, WebCodecs encoder dependency, hand-written muxer, CDN, external service, isolation headers or additional Azure resources are used. The core is single-threaded with SIMD; unsupported WASM/SIMD fails explicitly.

The recipe enables AAC/ALAC, native Opus/Vorbis, FLAC, MPEG audio, APE, WavPack, WMA, AC-3/E-AC-3 and selected common PCM/ADPCM decoders. Allowed containers are AAC ADTS, AIFF, APE, ASF, FLAC, Matroska/WebM, MOV/MP4/M4A, MP3, Ogg, WAV and WavPack. This is not support for every possible codec in those containers: AMR, Speex, uncommon PCM/ADPCM variants and other unconfigured codecs fail closed. The exact decoder/parser/filter lists are in the build recipe and generated configuration inside the source archive. No video decoder or encoder is enabled, but libavformat retains video stream descriptors and disposition flags so explicitly attached pictures can be discarded and moving video rejected without decoding either. SDK-provided musl iconv is present; no separate external codec library or SDL port is linked.

The file name is never passed to the worker. A sliced Blob becomes fixed `/input.bin` in a private in-memory filesystem; content detection does not depend on its extension. Runtime errors contain stable `conversion_*` codes only, never native log text, source names or tags. Protocols are limited to `file,pipe`, and allowed demuxers exclude playlists/network protocols. Input video streams are allowed only when the demuxer reports the exact numeric JSON disposition `attached_pic: 1`, requested with `stream_disposition=attached_pic`. Missing, malformed or other flag values fail closed; a PNG codec, single frame or filename is not evidence of attached artwork. Every moving-video stream, protected content, multiple audio streams and channels other than mono/stereo remain rejected. Conversion selects `-map 0:a:0 -vn` and discards pictures and metadata without modifying the original source. No normalization or routine gain is applied. Opus pre-skip, final granule and output gain are handled by FFmpeg.

Source admission rejects more than 32 MiB before reading bytes or starting a worker. A streams-first probe omits tags and bounds the input to eight streams, including the single audio stream and any pictures. It checks protection tags and encryption side data on every stream, then scans every input packet's side-data type without audio-only selection or a one-packet shortcut, including packets belonging to discarded pictures. Probe JSON writes are capped before accumulation at 128 KiB for stream descriptors and 4 MiB for packets; overflow rejects the input instead of accepting a partial scan. A full streaming PCM-counting pass, which discards samples immediately, verifies duration before AAC encoding. Declared duration comes from the audio stream; container duration is a fallback only when there are no picture streams. It rejects over 360 seconds, malformed decoding, inconsistent declared durations and over 128 MiB of equivalent float PCM at 48 kHz. Thus 360-second stereo can exceed the decoded-memory policy and be rejected; six minutes is not an unconditional promise for stereo. Encoding preserves channels, uses `aac_low`, 256000 bit/s target and 48000 Hz, strips metadata/chapters, enables faststart/edit lists, and never trims or downmixes to pass limits. The output is bounded below 16 MiB and must contain exactly one audio stream, AAC LC, with no attached-picture disposition, 48 kHz, matching channels, zero start time and duration within one AAC frame (1024/48000 seconds). The input-artwork exception never applies to output validation. Returned duration is the measured source sample timeline, not padded AAC frame length. Silence can encode below the bitrate target.

One worker at a time per module/page; waiting cancellation cannot release a still-running predecessor. Total admission-to-result deadline is 300 seconds, including queue time and loading; individual native commands have 180-second deadlines. Abort, worker failure, timeout and completion terminate the worker and release the queue. Temporary filesystem entries are unlinked in a finally block; termination frees the worker, compiled module and native heap. The pinned core has two verified ABI quirks: successful ffprobe can leave `ret=-1`, and clean ffmpeg exit emits the exact `Aborted()` marker. These are accepted only with otherwise valid command/output checks; other diagnostics fail closed and are never forwarded.

Native FFmpeg allocations are limited to 64 MiB per allocation. Emscripten links an unshared 32 MiB initial memory with `ALLOW_MEMORY_GROWTH=1` and `MAXIMUM_MEMORY=536870912`; the browser test verifies growth works and exceeding 512 MiB throws `RangeError`. The old minified-import `a.N` hook has been removed. The worker does not retain decoded PCM. **512 MiB is a native linear-heap ceiling, not a total browser RSS guarantee.** Source/output MEMFS, byte copies, WASM compilation, caller native decode and browser overhead are additional. A browser-terminated worker reports `conversion_worker_failed`; there is no reliable cross-browser distinction between OS memory pressure and other worker crashes. Real low-memory iPhone acceptance remains required.

The caller must native-decode the returned blob and verify finite samples, channels, sample rate, duration and its existing decoded-memory limit before hashing/cache/upload/IndexedDB commit. Keep invocation-bound account/reset checks and abort on explicit account changes. Never convert immutable fetched assets (`preserveBytes`) or block direct playable imports on converter availability. The converter has no persistence or upload behavior. Desktop tests verify native decode, but do not substitute for the caller's runtime validation.

### Exact Assets And Offline Handoff

The generated ESM JS/WASM live in `frontend/src/assets/codecs/` and are imported with Vite `?url`. The focused Vite 8.3.0 build emitted these exact assets, all present in `.vite/manifest.json`:

| Asset | Bytes | SHA-256 |
|---|---:|---|
| `/assets/ffmpeg-audio-core-Dbodaru-.js` | 81943 | `9ccec78786ef9d9ed1bbdfe6af56218ab7dfe1b6aae066c8324c36f07ee40df9` |
| `/assets/ffmpeg-audio-core-Cl4s-ECt.wasm` | 2460050 | `978adc54750b888c10b605105bfc22a99ea46ee2b255dad43ccd045e4b90fdf2` |
| `/assets/audio-conversion.worker-DSoMjl1b.js` | 4863 | `036aec230a7bd9494f4c2bbc62aea32d859738a435683b13fa7d71f05bdef372` |

Worker names/hashes may change with the integrated build; remeasure them. The lead must explicitly admit the exact WASM asset/hash in the service worker, privacy checker and deployment validator, serve it as `application/wasm`, and verify cached response hashes. Do not broadly allow arbitrary WASM, media or private audio. Runtime core assets total **2,541,993 bytes**, plus the 4,863-byte worker. The source archive is **19,521,396 bytes**, SHA-256 `45360ad6c7469beec37a3a91560353750a41473b61337ec67561cbb9e2b20394`. Exact static source/license hashes and sizes are in `frontend/public/licenses/ffmpeg-audio-core-v1-SBOM.json`. Existing public assets plus these files must fit the reviewed SWA Free artifact limit. **Do not precache the source archive for playback.** It must remain available as a normal same-origin download to binary recipients.

The focused browser test uses an explicit test-only service-worker asset list and the unchanged production CSP, including `wasm-unsafe-eval`, with `crossOriginIsolated=false`. It proves fresh-worker conversion from cached code while offline, with no additional server requests. **It does not claim the production service worker or release validator has already been updated.** Those are outside this delegate's file ownership.

### License And Corresponding Source

The current binary's actual `-version` and `-L` output confirms **FFmpeg 5.1.4, LGPL version 2.1 or later**, with explicit `--disable-gpl --disable-nonfree --disable-version3` and all threading disabled. The generated configuration is checked again by the packager. Native Opus is FFmpeg's own decoder, not libopus. AAC output is user audio, not made LGPL merely by running the encoder. No application license was selected or changed; this is not legal advice or a codec-patent clearance.

The earlier 32,232,419-byte npm core was GPL-2.0-or-later and had unresolved corresponding-source provenance for its numerous external libraries. **That earlier core remains unsuitable for this release and is not shipped by the replacement.** Its local test success was not redistribution approval. The replacement does not inherit its video libraries, floating dependency branches, SDL ports or memory ABI.

Pinned source/toolchain identities are in `scripts/audio-codec-inputs.json`:

- FFmpeg n5.1.4: `4729204c17f756e186d622060088371d10b34f7e`.
- ffmpeg.wasm v12.15 bindings and modified fftools: `71aa99d37c02a7b4c435275ca9ef50e612f6efa1`. The complete `src/` overlay used in compilation is compared byte-for-byte with the pinned upstream archive. No local native/binding modifications were made.
- Emscripten 3.1.40: `5c27e79dd0a9c4e27ef2326841698cdd4f6b5784`; SDK `ae245715ef50e036b68a2412a323129676bf8300` maps it to Linux x86_64 compiler release `c3122846bb040798aab975f61008c37eb19476de`.
- The exact ordinary compiler archive is hash-pinned (`5501e750c92f5a54b27ee101f6816e7416f154cb4181b73fd0be3faae947016c`). It is downloaded into the owned local cache, not distributed in the browser bundle. No container or global installation was used.

Actual distribution files, not a future source offer:

1. `/licenses/ffmpeg-audio-core-v1-LGPL-2.1.txt`: complete LGPL 2.1 text.
2. `/licenses/ffmpeg-audio-core-v1-NOTICES.txt`: FFmpeg license inventory and compiled-input copyright/permission headers, MIT binding license, Emscripten MIT/NCSA and Node-derived notices, musl notices, compiler-rt Apache-2.0 WITH LLVM-exception/legacy NCSA, IJG notices and dlmalloc's upstream public-domain statement. Some compiled-input notices conservatively cover code eliminated during linking.
3. `/licenses/ffmpeg-audio-core-v1-SBOM.json`: component licenses/source identities, original and selected-source hashes, memory/features and exact artifact hashes. Bundled musl/compiler-rt identities are anchored to the included Emscripten source commit rather than guessed independent release versions.
4. `/sources/ffmpeg-audio-core-v1-source.tar.gz`: complete FFmpeg source including its original license files, complete required binding/native overlays, Emscripten `src/` and `system/` runtime sources, SDK source, current build/preparation/package scripts, generated configuration and a source-bundle hash manifest. Unrelated wrapper websites, Arial font/images and Emscripten test/media/site trees are excluded. FFmpeg files with media-like suffixes under `tests/ref/` are text test references, not recordings. Compiler-host tooling is separately pinned; no Emscripten runtime modifications need an additional patch.

The archive's `BUILD.txt` explains rebuilding and replacing both core resources together. All code linked into this library is supplied; application JavaScript communicates with it in a separate worker and is not a proprietary object linked into the WASM. Preserve recipients' ability to modify/rebuild/relink the core and retain all notices/source access in the actual distribution. There is no source obfuscation or application-license change in this work.

Build from the project with Linux x86_64, Node 22+, Python 3 for Emscripten, make, gcc/g++, cmake, tar, xz/bzip2, patch and diff:

```sh
bash scripts/build-audio-codec.sh
node scripts/package-audio-codec.mjs "$HOME/.cache/fitness-audio-codec/v1"
```

For the supplied source archive, extract into a new directory and run `AUDIO_CODEC_BUILD_ROOT="$PWD" bash scripts/build-audio-codec.sh` from its root. It reuses bundled, verified sources and obtains only the hash-pinned ordinary compiler if absent. The source bundle's preparation path is checked independently; an independent second full bit-identical compile is not claimed. The local build is complete, but production allowlists, source-download availability, release review and physical-device acceptance remain lead-owned gates. Do not deploy until those gates pass.

### Verification

Run from the repository root with Node 22.12+, installed Chromium, native `ffmpeg` and `ffprobe`:

```sh
node node_modules/vitest/vitest.mjs run tests/audio-conversion.test.ts --maxWorkers=1 --reporter=verbose
node frontend/node_modules/typescript/bin/tsc --noEmit -p frontend/tsconfig.json
node node_modules/typescript/bin/tsc --noEmit
```

Before the attached-picture correction, the **20-test suite passed against the replacement**, including all original 12 cases. It builds the converter in memory without overwriting `frontend/dist`. Coverage includes mono/stereo Opus with 2 MiB tags, FLAC/Vorbis, 24-bit WAV, MP3, ADTS AAC, ALAC M4A, WebM Opus and AIFF; native AAC LC decode/ffprobe; 48 kHz and preserved channels; 220-290 kbit/s on ten seconds of complex noise; unchanged original hashes and absent source tags; Opus -6 dB output gain, non-frame-aligned duration and first/last waveform alignment within two samples; CENC/video/malformed/multiple-stream/channel/duration/memory rejection; abort/recovery, queue/deadline and feature-absence behavior; actual license/configuration and memory maximum; manifest assets; fresh-worker cached offline execution under the unchanged CSP; and complete source/archive/hash/notice checks. Added attached-picture regressions generate synthetic PNG artwork and mono/stereo Opus `METADATA_BLOCK_PICTURE` or MP3 attachments at runtime, independently probe input/output, verify source hashes and metadata removal, and compare cached/offline output bytes. Further cases retain rejection of unflagged single-frame/multi-frame PNG video and cover malformed dispositions, bounded streams/probe writes, encryption on later audio/picture packets and strict output rejection. **These additions and the modified worker have not been executed in this no-terminal pass; the commands above remain pending.** No native binary, license pin or corresponding-source archive was changed or rebuilt. Synthetic temporary fixtures live only in ignored local-media and are removed; generated artwork stays in test memory. No household music was inspected, copied, logged or uploaded during this correction. Specific household-file checks, physical iPhone/Safari/Bluetooth, low-memory-device acceptance, production service-worker integration and release approval remain separate gates.

## Loudness Analysis

### Release Evidence

Reviewed September 14, 2026, using public upstream sources without fetching credentials or changing installed dependencies.

- Pinned npm dependency: `ebur128-wasm@3.0.0`, published October 27, 2022. The registry archive contains seven files, 107,308 unpacked bytes; the WASM itself is 87,519 bytes. It has no npm runtime dependencies, which does **not** mean the WASM has no Rust dependencies. The previously recorded frontend npm audit reported zero vulnerabilities on September 14, 2026; it was not rerun for this notice-only change and is not a Rust/WASM security audit. The wrapper is not claimed to be actively maintained.
- [npm release metadata](https://registry.npmjs.org/ebur128-wasm/3.0.0) identifies `gitHead` **f03e208f15f734ac7ca6fe1454b029819c7c24a4**, matching the upstream [3.0.0 release commit](https://github.com/streamonkey/ebur128_wasm/commit/f03e208f15f734ac7ca6fe1454b029819c7c24a4), dated October 27, 2022. [GitHub tags](https://api.github.com/repos/streamonkey/ebur128_wasm/tags) returned an empty list; this is a commit-pinned reference, not an asserted `v3.0.0` tag.
- npm archive identity: SHA-1 `277a237493ba256e359d88b0d94b52557d4a9400`; SRI `sha512-H6cphLlVCJpUpYUX8n2qnHMmGXjhPJqXN6TDqv2J80/dERa7MFzQ5rMNxV9eoF0B3YyO8LL3CQ9bckVhcjekGg==`. These identify the published archive, not a reproducible native build or a new local byte-hash measurement.
- The release [Cargo manifest](https://raw.githubusercontent.com/streamonkey/ebur128_wasm/f03e208f15f734ac7ca6fe1454b029819c7c24a4/Cargo.toml) is at the repository root, declares version `3.0.0` and Apache-2.0, and enables `console_error_panic_hook` by default. The complete [release tree](https://api.github.com/repos/streamonkey/ebur128_wasm/git/trees/f03e208f15f734ac7ca6fe1454b029819c7c24a4?recursive=1) has no Cargo.lock or NOTICE; the release [.gitignore](https://raw.githubusercontent.com/streamonkey/ebur128_wasm/f03e208f15f734ac7ca6fe1454b029819c7c24a4/.gitignore) explicitly excludes Cargo.lock and the generated package. The npm package also has no native lockfile or NOTICE. The demo's npm lockfile does not resolve Rust crates.
- Release-pinned [entry points](https://github.com/streamonkey/ebur128_wasm/blob/f03e208f15f734ac7ca6fe1454b029819c7c24a4/src/lib.rs), [analyzer setup](https://github.com/streamonkey/ebur128_wasm/blob/f03e208f15f734ac7ca6fe1454b029819c7c24a4/src/analyzer.rs) and [interleaving/panic hook](https://github.com/streamonkey/ebur128_wasm/blob/f03e208f15f734ac7ca6fe1454b029819c7c24a4/src/utils.rs) use `Mode::I` and `loudness_global()`. The application uses the inspected native ABI without modifying the upstream JavaScript or WASM.

### Dependency Inventory And Notices

The binary inspection recorded `ebur128-0.1.6` and `console_error_panic_hook-0.1.7` source paths. Other versions below are **notice-source versions, not proven linked versions**. Cargo requirements are semver ranges, not exact pins; no dependency resolution was reconstructed and passed off as the original build.

| Component | Version evidence / declared requirement | License used and notice source |
|---|---|---|
| ebur128-wasm | npm `3.0.0`, matching release manifest and commit | Apache-2.0; complete npm LICENSE retained verbatim via the worker's raw import. No additional upstream NOTICE found. |
| ebur128 | Binary source path `0.1.6`; wrapper requirement `0.1.6` | MIT; [0.1.6 LICENSE](https://raw.githubusercontent.com/sdroege/ebur128/0.1.6/LICENSE), Jan Kokemüller (2011) and Sebastian Dröge (2020). |
| bitflags | Native [0.1.6 manifest](https://raw.githubusercontent.com/sdroege/ebur128/0.1.6/Cargo.toml) requires `1.0`; exact resolution unknown | MIT option of MIT/Apache-2.0; [1.3.2 notice](https://docs.rs/crate/bitflags/1.3.2/source/LICENSE-MIT), The Rust Project Developers (2014). |
| smallvec | Native requirement `1.0`; exact resolution unknown | MIT option of MIT OR Apache-2.0; [1.10.0 notice](https://docs.rs/crate/smallvec/1.10.0/source/LICENSE-MIT), The Servo Project Developers (2018). |
| dasp_frame | Native requirement `0.11`; exact resolution unknown | MIT option of MIT OR Apache-2.0; [0.11.0 package source identity](https://docs.rs/crate/dasp_frame/0.11.0/source/.cargo_vcs_info.json) pins the [notice](https://raw.githubusercontent.com/RustAudio/dasp/221b81038c528bf3fc364a8ab5cc4b2e52f7dbfc/LICENSE-MIT), RustAudio Developers (2016). |
| dasp_sample | Native and dasp_frame requirements `0.11`; exact resolution unknown | MIT option of MIT OR Apache-2.0; [0.11.0 package source identity](https://docs.rs/crate/dasp_sample/0.11.0/source/.cargo_vcs_info.json) pins the [same notice text](https://raw.githubusercontent.com/RustAudio/dasp/97c3bb9b2363c0b46ac1633858bf1054fd02a980/LICENSE-MIT), RustAudio Developers (2016). |
| wasm-bindgen | Wrapper requirement `0.2.63`; panic hook requirement `0.2.37`; exact resolution unknown | MIT option of MIT/Apache-2.0; [0.2.83 notice](https://raw.githubusercontent.com/rustwasm/wasm-bindgen/0.2.83/LICENSE-MIT), Alex Crichton (2014), also covering that repository's macro, macro-support, backend and shared crates. |
| console_error_panic_hook | Binary source path `0.1.7`; wrapper requirement `0.1.6`, default-enabled | MIT option of Apache-2.0/MIT; [0.1.7 notice](https://docs.rs/crate/console_error_panic_hook/0.1.7/source/LICENSE-MIT), Nick Fitzgerald (2018). |
| cfg-if | [Panic hook 0.1.7](https://docs.rs/crate/console_error_panic_hook/0.1.7/source/Cargo.toml) requires `1.0.0`; exact resolution unknown | MIT option of MIT/Apache-2.0; [1.0.0 notice](https://docs.rs/crate/cfg-if/1.0.0/source/LICENSE-MIT), Alex Crichton (2014). Also declared by the wasm-bindgen notice-reference version. |

Full copyright, permission, inclusion-condition and warranty/liability text is embedded for every listed MIT notice. The two dasp crates share one identical upstream notice, explicitly naming both. The MIT option is selected for the dual-licensed Rust dependencies, so coverage does not depend on treating the wrapper's Apache license as a blanket license for them. No additional NOTICE was found in the reviewed package listings; the wrapper retains its entire Apache license.

The reviewed [dasp_frame manifest](https://docs.rs/crate/dasp_frame/0.11.0/source/Cargo.toml) depends only on dasp_sample, whose [manifest](https://docs.rs/crate/dasp_sample/0.11.0/source/Cargo.toml) has no dependencies. The reviewed [bitflags](https://docs.rs/crate/bitflags/1.3.2/source/Cargo.toml), [smallvec](https://docs.rs/crate/smallvec/1.10.0/source/Cargo.toml) and [cfg-if](https://docs.rs/crate/cfg-if/1.0.0/source/Cargo.toml) have no additional default-enabled runtime dependencies. This bounds the identified normal dependency graph; it does not prove the historical compiler flags or all linked code.

For build-time context only, [wasm-bindgen 0.2.83](https://docs.rs/crate/wasm-bindgen/0.2.83/source/Cargo.toml) requires its same-version procedural [macro](https://raw.githubusercontent.com/rustwasm/wasm-bindgen/0.2.83/crates/macro/Cargo.toml); [macro-support](https://raw.githubusercontent.com/rustwasm/wasm-bindgen/0.2.83/crates/macro-support/Cargo.toml) and [backend](https://raw.githubusercontent.com/rustwasm/wasm-bindgen/0.2.83/crates/backend/Cargo.toml) declare quote, syn, proc-macro2, bumpalo, log and once_cell. Those compiler-host dependencies are not evidence of runtime linkage and are not claimed as resolved shipped components. Dev/test-only crates and opt-in native C test tooling are likewise not treated as runtime dependencies. This inventory is not a complete compiler/toolchain SBOM.

### Distribution And Release Decision

Vite `?url&inline` embeds the pinned WASM in manifest-listed worker JavaScript. The complete Apache license and aggregate MIT notices remain reachable through the existing initial `{ kind: 'ready', license }` response; no new fields, runtime analysis changes, public `.txt` asset, deployment allowlist changes or network license fetches are required. Notice URLs are attribution text, not runtime requests. Changes to this string require a fresh worker build and artifact hash review; this source edit does not update any already-built or deployed artifact.

The known missing dependency-notice gap is addressed in source. **No known permission blocker remains for the identified dependency set, provided the released artifact retains these notices.** The absent original Cargo.lock, exact remaining native versions, compiler/toolchain identity and native rebuild attestation are provenance/reproducibility limitations, not by themselves license-permission failures. No claim is made of a reproducible native build, complete SBOM, active upstream maintenance or comprehensive WASM security audit. Newly identified distributed code or additional notice obligations must still be reviewed before release.

The existing focused test now checks each notice heading, copyright, source URL, complete MIT terms and exact npm Apache license in the built worker's initial response, then performs the existing offline measurement. Editor diagnostics reported no errors after the worker/test edits. Terminal execution was intentionally not performed during this license review because the lead may be running Playwright. From the repository root with Node 22.12+ and the existing Chromium installation, the lead's narrow verification command is:

```sh
npm test -- tests/loudness.test.ts -t "bundles WASM and its license"
```

The lead still owns the production rebuild, privacy/deployment validation, artifact hash approval and release decision. These artifact checks remain gates; obtaining an unavailable historical Rust lockfile is not substituted for a license obligation.