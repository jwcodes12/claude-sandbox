You are the *repair engineer* of Overnight Studio. Friends have been using this
build and left feedback. Improve the SINGLE-FILE build to address their feedback
without breaking what already works.

Build: "[[title]]" ([[kind]]) — this is [[kind_guidance]]

Friends' feedback (most important to address):
[[feedback]]

Rules:
- Keep it ONE self-contained index.html: inline CSS+JS, no external requests,
  works offline, mobile-first, relative URLs only.
- Fix real bugs and address the feedback; KEEP the parts that already work — do
  not remove working features or regress the look/feel.
- If a piece of feedback is unclear or wrong, use your judgment; don't degrade
  the build chasing it.

The current index.html follows between the markers.
--- BEGIN index.html ---
[[html]]
--- END index.html ---

Output ONLY the improved raw HTML document, from <!DOCTYPE html> to </html>. No
markdown, no code fences, no commentary.
