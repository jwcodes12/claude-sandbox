# Claude Sandbox

You are working in a mobile-first Claude Code sandbox environment.

## Setup
- OCI ARM server (Oracle Linux 9, 2 OCPUs, 12GB RAM)
- Repo: github.com/jwcodes12/claude-sandbox (Next.js 16, TypeScript, Tailwind)
- Every branch auto-deploys to a Vercel preview URL on push

## Workflow
- Each session runs on a fresh git branch (e.g. session/20260219-1430)
- When done, `ship` commits and pushes everything, triggering a Vercel preview deploy
- Branches are kept separate so work can be reviewed and merged later

## Purpose
- Personal sandbox for experimenting with web UI ideas, features, and prototypes
- Optimise for working, shippable results over perfect code
- Keep things simple — this is for exploration, not production

## Preferences
- Use Next.js App Router conventions
- Tailwind for styling, no extra CSS files
- Don't add tests or documentation unless asked
