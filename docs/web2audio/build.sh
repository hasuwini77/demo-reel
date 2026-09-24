#!/usr/bin/env bash
# Build the Web2Audio showcase reel: record the three clips, crossfade-join
# them into docs/web2audio.mp4, then derive docs/web2audio.gif and
# docs/og-web2audio.png from it.
#
# Run from the repo root:
#   docs/web2audio/build.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

SCENE_DIR="docs/web2audio"
DOCS_DIR="docs"
RECORD="skills/demo-reel/scripts/record.mjs"
OUT_MP4="$DOCS_DIR/web2audio.mp4"
OUT_GIF="$DOCS_DIR/web2audio.gif"
OUT_OG="$DOCS_DIR/og-web2audio.png"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "==> Recording clips into $TMP_DIR"
node "$RECORD" "$SCENE_DIR/browser.scenario.mjs" --out "$TMP_DIR/1-browser.mp4"
node "$RECORD" "$SCENE_DIR/phone.scenario.mjs" --out "$TMP_DIR/2-phone.mp4"
node "$RECORD" "$SCENE_DIR/end.scenario.mjs" --out "$TMP_DIR/3-end.mp4"

duration_of() {
    ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"
}

DUR1="$(duration_of "$TMP_DIR/1-browser.mp4")"
DUR2="$(duration_of "$TMP_DIR/2-phone.mp4")"
DUR3="$(duration_of "$TMP_DIR/3-end.mp4")"

XFADE_DUR=0.4

# offset1: where clip1->clip2 crossfade starts (end of clip1 minus the fade)
OFFSET1="$(awk -v d="$DUR1" -v x="$XFADE_DUR" 'BEGIN { printf "%.3f", d - x }')"
# duration of clip1+clip2 joined (used to place the second crossfade)
JOINED12="$(awk -v d1="$DUR1" -v d2="$DUR2" -v x="$XFADE_DUR" 'BEGIN { printf "%.3f", d1 + d2 - x }')"
OFFSET2="$(awk -v j="$JOINED12" -v x="$XFADE_DUR" 'BEGIN { printf "%.3f", j - x }')"

echo "==> Clip durations: browser=${DUR1}s phone=${DUR2}s end=${DUR3}s"
echo "==> Crossfade offsets: offset1=${OFFSET1}s offset2=${OFFSET2}s"

echo "==> Joining with crossfade -> $OUT_MP4"
ffmpeg -y \
    -i "$TMP_DIR/1-browser.mp4" \
    -i "$TMP_DIR/2-phone.mp4" \
    -i "$TMP_DIR/3-end.mp4" \
    -filter_complex "\
[0:v][1:v]xfade=transition=fade:duration=${XFADE_DUR}:offset=${OFFSET1}[v01]; \
[v01][2:v]xfade=transition=fade:duration=${XFADE_DUR}:offset=${OFFSET2}[v]" \
    -map "[v]" \
    -c:v libx264 -crf 18 -pix_fmt yuv420p -movflags +faststart -r 60 \
    "$OUT_MP4"

FINAL_DUR="$(duration_of "$OUT_MP4")"
echo "==> Final joined duration: ${FINAL_DUR}s"

echo "==> Building GIF -> $OUT_GIF"
GIF_WIDTH=780
build_gif() {
    local width="$1"
    ffmpeg -y -i "$OUT_MP4" -filter_complex \
        "[0:v] fps=15,scale=${width}:-1:flags=lanczos,split [a][b];[a] palettegen [p];[b][p] paletteuse" \
        "$OUT_GIF"
}
build_gif "$GIF_WIDTH"
GIF_BYTES="$(stat -f%z "$OUT_GIF" 2>/dev/null || stat -c%s "$OUT_GIF")"
MAX_BYTES=$((6 * 1024 * 1024))
while [ "$GIF_BYTES" -ge "$MAX_BYTES" ] && [ "$GIF_WIDTH" -gt 320 ]; do
    GIF_WIDTH=$((GIF_WIDTH - 100))
    echo "==> GIF too large (${GIF_BYTES} bytes) — retrying at width ${GIF_WIDTH}"
    build_gif "$GIF_WIDTH"
    GIF_BYTES="$(stat -f%z "$OUT_GIF" 2>/dev/null || stat -c%s "$OUT_GIF")"
done

echo "==> Extracting OG image -> $OUT_OG (playing-popup moment)"
# ~2.6s into the browser clip: popup zoomed in, "Preparing audio"/playing state on screen.
ffmpeg -y -ss 2.6 -i "$TMP_DIR/1-browser.mp4" -frames:v 1 -update 1 \
    -vf "scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630" \
    "$OUT_OG"

echo
echo "==> Done"
for f in "$OUT_MP4" "$OUT_GIF" "$OUT_OG"; do
    bytes="$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")"
    printf '%-28s %10d bytes\n' "$f" "$bytes"
done
echo "browser=${DUR1}s phone=${DUR2}s end=${DUR3}s joined=${FINAL_DUR}s"
