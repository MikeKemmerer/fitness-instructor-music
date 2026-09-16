#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BUILD_ROOT=${AUDIO_CODEC_BUILD_ROOT:-"$HOME/.cache/fitness-audio-codec/v1"}

for tool in node make gcc g++ cmake tar xz patch; do
  command -v "$tool" >/dev/null || { printf 'Missing prerequisite: %s\n' "$tool" >&2; exit 1; }
done
node --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node 22+ required");'

if [[ "${1:-}" == --check-tools ]]; then
  printf 'Native prerequisites ready; build cache: %s\n' "$BUILD_ROOT"
  exit 0
fi

if [[ "${1:-}" == --check-sources ]]; then
  node "$ROOT/scripts/prepare-audio-codec.mjs" "$BUILD_ROOT" --check-sources
  exit 0
fi

node "$ROOT/scripts/prepare-audio-codec.mjs" "$BUILD_ROOT"
export EM_CONFIG="$BUILD_ROOT/emscripten-config"
export PATH="$BUILD_ROOT/compiler/emscripten:$PATH"
export SOURCE_DATE_EPOCH=1686528000
export LC_ALL=C
emcc --version
mkdir -p "$BUILD_ROOT/work" "$BUILD_ROOT/output"
if [[ ! -f "$BUILD_ROOT/work/configure" ]]; then
  tar -xf "$BUILD_ROOT/downloads/ffmpeg.tar.gz" --strip-components=1 -C "$BUILD_ROOT/work"
  cp -R "$BUILD_ROOT/wrapper/src" "$BUILD_ROOT/work/src"
fi
cd "$BUILD_ROOT/work"
if [[ ! -f ffbuild/config.mak ]]; then
  ./configure --target-os=none --arch=x86_32 --enable-cross-compile \
    --disable-asm --disable-stripping --disable-programs --disable-doc --disable-debug \
    --disable-runtime-cpudetect --disable-autodetect --disable-everything \
    --disable-gpl --disable-nonfree --disable-version3 \
    --disable-pthreads --disable-w32threads --disable-os2threads \
    --disable-avdevice --disable-postproc --disable-swscale --disable-network \
    --nm=emnm --ar=emar --ranlib=emranlib --cc=emcc --cxx=em++ --objcc=emcc --dep-cc=emcc \
    --extra-cflags='-O3 -msimd128' --extra-cxxflags='-O3 -msimd128' \
    --enable-protocol=file,pipe \
    --enable-demuxer=aac,aiff,ape,asf,flac,matroska,mov,mp3,ogg,wav,wv \
    --enable-decoder=aac,aac_fixed,aac_latm,ac3,eac3,alac,ape,flac,mp1,mp1float,mp2,mp2float,mp3,mp3float,mp3adu,mp3adufloat,mp3on4,mp3on4float,opus,vorbis,wavpack,wmav1,wmav2,wmapro,wmalossless,pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_alaw,pcm_mulaw,adpcm_ima_wav,adpcm_ms \
    --enable-parser=aac,aac_latm,ac3,flac,mpegaudio,opus,vorbis \
    --enable-encoder=aac,pcm_f32le --enable-muxer=mp4,pcm_f32le \
    --enable-filter=aresample,aformat,anull,abuffer,abuffersink
fi
grep -q 'CONFIG_GPL 0' config.h
grep -q 'CONFIG_NONFREE 0' config.h
make -j "${AUDIO_CODEC_JOBS:-4}"
emcc -O3 -msimd128 -I. -Isrc/fftools \
  src/fftools/cmdutils.c src/fftools/ffmpeg.c src/fftools/ffmpeg_filter.c \
  src/fftools/ffmpeg_hw.c src/fftools/ffmpeg_mux.c src/fftools/ffmpeg_opt.c \
  src/fftools/opt_common.c src/fftools/ffprobe.c \
  -Wno-deprecated-declarations \
  -Wl,--start-group libavformat/libavformat.a libavcodec/libavcodec.a \
  libavfilter/libavfilter.a libswresample/libswresample.a libavutil/libavutil.a -Wl,--end-group \
  -sENVIRONMENT=worker -sWASM_BIGINT -sMODULARIZE -sEXPORT_ES6 \
  -sINITIAL_MEMORY=33554432 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=536870912 \
  -sEXPORT_NAME=createFFmpegCore \
  -sEXPORTED_FUNCTIONS="$(node src/bind/ffmpeg/export.js)" \
  -sEXPORTED_RUNTIME_METHODS="$(node src/bind/ffmpeg/export-runtime.js)" \
  --pre-js src/bind/ffmpeg/bind.js \
  -o "$BUILD_ROOT/output/ffmpeg-audio-core.js"
sha256sum "$BUILD_ROOT/output/ffmpeg-audio-core.js" "$BUILD_ROOT/output/ffmpeg-audio-core.wasm"