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
