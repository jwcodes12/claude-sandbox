# Promo video pipeline

1. `node promo/capture.mjs` — records real two-phone gameplay (lobby, play,
   refresh-resume, connection self-heal) → /tmp/ll-promo/clips + markers.json
2. `node promo/record-cards.mjs` — renders cards.html (?card=1..6) → /tmp/ll-promo/cards
3. `node promo/render-captions.mjs` — caption band PNGs → /tmp/ll-promo/captions
4. `bash promo/assemble.sh` — ffmpeg edit → /tmp/ll-promo/lordlandlord-for-the-boys.mp4
5. Soundtrack: Gemini TTS (`gemini-3.1-flash-tts-preview`, voice Charon, key from
   ~/.config/claude-sandbox/tech-radar.env) sings each narration line as a medieval
   bard chant; `python3 promo/lute.py <secs> bed.wav` synthesizes the Karplus-Strong
   lute bed; voice lines are adelay'd to segment starts (measure seg/*.mp4 with
   ffprobe), amixed over the bed (+reverb aecho), muxed with `-c:v copy`.
6. Publish: cp to src/promo/lordlandlord.mp4 (gitignored, served by the tunnel).

Segment order: intro · roast · rebuild · [lobby+play footage] · receipts ·
[refresh footage] · [heal footage] · names · outro. Card durations live in
record-cards.mjs (DURATIONS) and assemble.sh (CARD_T) — keep in sync with the
sung-line lengths when re-cutting.
