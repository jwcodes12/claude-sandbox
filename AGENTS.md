# Agent Notes

This is a personal vibecode monorepo. Keep changes scoped to the app the user asked about unless they explicitly request repo-wide cleanup.

## Structure

- `apps/agi-markets`: existing Next.js App Router app.
- `apps/tech-radar`: static generated news radar with RSS ingestion, SQLite cache, topic clustering, and Netlify/Vercel deploy scripts.
- Add new apps under `apps/<short-name>`.
- Add `packages/*` only after there is real shared code across apps.

## Commands

- Root default dev: `npm run dev`
- Build everything: `npm run build`
- Lint everything: `npm run lint`
- App-specific commands: `npm run <script> -w <workspace-name>`
- Tech Radar worker: `npm run worker:force -w @claude-sandbox/tech-radar`
- Tech Radar static preview: `npm run dev -w @claude-sandbox/tech-radar`

## Deploy

Each app should be deployable independently. For Netlify or Vercel, configure the service root/base directory to the app folder.

`apps/tech-radar` deploys generated `public/` output. OCI scheduling templates live in `ops/systemd`.
