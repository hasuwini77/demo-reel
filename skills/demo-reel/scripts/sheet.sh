#!/usr/bin/env bash
# Contact sheet + smoothness check for a recorded demo.
#   scripts/sheet.sh demo.mp4 [sheet.png] [every_seconds=2.5] [columns=4]
set -euo pipefail
in="$1"; out="${2:-${in%.*}-sheet.png}"; every="${3:-2.5}"; cols="${4:-4}"
dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$in")
rows=$(python3 -c "import math;print(max(1, math.ceil(float('$dur')/float('$every')/$cols)))")
ffmpeg -y -loglevel error -i "$in" -vf "fps=1/$every,scale=480:-1,tile=${cols}x${rows}:padding=4:color=white" -frames:v 1 "$out"
fps=$(ffprobe -v error -select_streams v -show_entries stream=r_frame_rate -of default=nw=1:nk=1 "$in")
total=$(ffprobe -v error -select_streams v -count_frames -show_entries stream=nb_read_frames -of default=nw=1:nk=1 "$in")
echo "sheet: $out  ($dur s, $fps fps, $total frames)"

# Jank: per-frame luma difference to the next frame (tblend + signalstats) and
# hard cuts (scene score > 0.35), in one decode.
tmp=$(mktemp -d); trap 'rm -rf "${tmp:?}"' EXIT
ffmpeg -nostdin -loglevel error -i "$in" -filter_complex \
    "[0:v]split[a][b];[a]format=gray,tblend=all_mode=difference,signalstats,metadata=print:file=$tmp/diff[da];[b]select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=$tmp/cuts[db]" \
    -map "[da]" -f null - -map "[db]" -f null -
python3 - "$tmp/diff" "$tmp/cuts" <<'EOF'
import re, sys
def load(path):
    rows = []
    for line in open(path):
        if line.startswith("frame:"):
            rows.append({"t": float(re.search(r"pts_time:([\d.]+)", line).group(1))})
        elif (m := re.match(r"lavfi\.(?:signalstats\.)?(YAVG|YMAX|scene_score)=([\d.]+)", line)):
            rows[-1][m.group(1)] = float(m.group(2))
    return rows
d, cuts = load(sys.argv[1]), [r for r in load(sys.argv[2]) if r["scene_score"] > 0.35]
avg, peak = [r["YAVG"] for r in d], [r["YMAX"] for r in d]
VISIBLE = 64  # a diff peak below this is codec noise: nothing on screen moved
# Frozen frame: nothing moved, while both neighbours move > 3x as much (a
# duplicated frame in the middle of motion). Pop: a visible change > 3x both
# neighbours, i.e. a single-frame jump; typing and discrete UI pops look the
# same, so pops are listed for a look, not counted as jank.
frozen = [i for i in range(1, len(d) - 1) if peak[i] < VISIBLE
          and min(peak[i - 1], peak[i + 1]) >= VISIBLE and min(avg[i - 1], avg[i + 1]) > 3 * avg[i]]
pops = [i for i in range(1, len(d) - 1) if peak[i] >= VISIBLE and avg[i] > 3 * max(avg[i - 1], avg[i + 1])]
# diff row i compares frame i and i+1; report the later frame (the one on screen).
at = lambda rows: ", ".join(f"#{i + 1} {d[i]['t']:.2f}s" for i in rows[:12]) + (" …" if len(rows) > 12 else "")
print(f"jank: {len(frozen)} suspicious frames, {len(cuts)} hard cuts")
if frozen: print(f"  frozen: {at(frozen)}")
if cuts: print("  cuts: " + ", ".join(f"{r['t']:.2f}s" for r in cuts[:12]))
if pops: print(f"  pops ({len(pops)}, typing or UI jumps; check they're intended): {at(pops)}")
EOF
