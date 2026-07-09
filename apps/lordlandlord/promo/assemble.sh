#!/bin/bash
# promo/assemble.sh — cut cards + footage into the final promo mp4.
# Inputs: /tmp/ll-promo/cards/0*.webm, /tmp/ll-promo/clips/{A,B}.webm (+markers.json)
# Output: /tmp/ll-promo/lordlandlord-for-the-boys.mp4
set -euo pipefail

D=/tmp/ll-promo
SEG=$D/seg
mkdir -p "$SEG"
BG=0x241609
CAP=$D/captions
ENC="-r 30 -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p -an"

# ---- card segments (already 1280x720; pinned to the sung-line timeline) --------
CARD_T=(8.5 16.1 10.8 9.8 13.8 8.6)
i=0
for f in "$D"/cards/0*.webm; do
  i=$((i+1))
  ffmpeg -y -v error -ss 0.5 -i "$f" -t "${CARD_T[$((i-1))]}" -vf "scale=1280:720,setsar=1" $ENC "$SEG/c$i.mp4"
done

# ---- footage: side-by-side lobby+play (1.5s - 17.5s) ---------------------------
ffmpeg -y -v error \
  -f lavfi -i "color=c=$BG:s=1280x720:r=30" \
  -ss 1.5 -to 17.5 -i "$D/clips/A.webm" \
  -ss 1.5 -to 17.5 -i "$D/clips/B.webm" \
  -i "$CAP/lobby.png" -i "$CAP/play.png" \
  -filter_complex "\
    [1:v]scale=-2:720,setsar=1[a];\
    [2:v]scale=-2:720,setsar=1[b];\
    [0:v][a]overlay=260:0:shortest=1[t1];\
    [t1][b]overlay=660:0[t2];\
    [t2][3:v]overlay=0:576:enable='lt(t,6.1)'[t3];\
    [t3][4:v]overlay=0:576:enable='gte(t,6.1)'[v]" \
  -map "[v]" $ENC "$SEG/f1.mp4"

# ---- footage: B refreshes mid-game (17.9s - 23.0s) ------------------------------
ffmpeg -y -v error \
  -f lavfi -i "color=c=$BG:s=1280x720:r=30" \
  -ss 17.9 -to 23.0 -i "$D/clips/B.webm" \
  -i "$CAP/refresh.png" \
  -filter_complex "\
    [1:v]scale=-2:720,setsar=1,setpts=PTS*1.176[b];\
    [0:v][b]overlay=460:0:shortest=1[t1];\
    [t1][2:v]overlay=0:576[v]" \
  -map "[v]" $ENC "$SEG/f2.mp4"

# ---- footage: connection kill → self-heal, both views (23.2s - 28.4s) ------------
ffmpeg -y -v error \
  -f lavfi -i "color=c=$BG:s=1280x720:r=30" \
  -ss 23.2 -to 28.4 -i "$D/clips/A.webm" \
  -ss 23.2 -to 28.4 -i "$D/clips/B.webm" \
  -i "$CAP/heal.png" \
  -filter_complex "\
    [1:v]scale=-2:720,setsar=1,setpts=PTS*1.115[a];\
    [2:v]scale=-2:720,setsar=1,setpts=PTS*1.115[b];\
    [0:v][a]overlay=260:0:shortest=1[t1];\
    [t1][b]overlay=660:0[t2];\
    [t2][3:v]overlay=0:576[v]" \
  -map "[v]" $ENC "$SEG/f3.mp4"

# ---- concat: intro, roast, rebuild, lobby+play, receipts, refresh, heal, names, outro
cat > "$SEG/list.txt" << EOF
file '$SEG/c1.mp4'
file '$SEG/c2.mp4'
file '$SEG/c3.mp4'
file '$SEG/f1.mp4'
file '$SEG/c4.mp4'
file '$SEG/f2.mp4'
file '$SEG/f3.mp4'
file '$SEG/c5.mp4'
file '$SEG/c6.mp4'
EOF
ffmpeg -y -v error -f concat -safe 0 -i "$SEG/list.txt" -c copy -movflags +faststart "$D/lordlandlord-for-the-boys.mp4"

ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$D/lordlandlord-for-the-boys.mp4"
echo "ASSEMBLE DONE"
