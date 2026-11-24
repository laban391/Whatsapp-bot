# MOON Multi-User WhatsApp Bot — Altare deployment

This build is based on the QueenRiam status-plugins multi-user archive. It uses MySQL for isolated user sessions and WhatsApp auth storage. It is configured for Altare's Node.js 22 runtime and dynamic PORT.

## Altare settings
- Runtime: Node.js 22
- Root directory: `Whatsapp-bot-main` (if the repository contains this folder; otherwise use `.` and move its contents to repository root)
- Install command: `npm install --include=optional --foreground-scripts`
- Start command: `npm start`
- Build command: leave blank

## Required environment variables
Set these in Altare's Environment/Variables page; do not commit them to GitHub:
- `DB_HOST` — hostname of a reachable MySQL server
- `DB_PORT` — usually `3306`
- `DB_NAME` — database name
- `DB_USER` — database username
- `DB_PASSWORD` — database password
- `ADMIN_TOKEN` — long random private dashboard token

Altare supplies `PORT`; do not set it manually unless Altare specifically requires it. The app listens on `0.0.0.0`.

**Important:** The previous OptikLink database host is not automatically reachable from Altare. Use a MySQL database whose provider allows connections from Altare, and ensure its user can create tables. This ZIP does not contain database credentials.

## Deploy
1. Replace the repository contents with the contents of this ZIP, preserving the `Whatsapp-bot-main` folder if using it as the configured root.
2. Commit and push to GitHub.
3. Add all six environment variables above in Altare.
4. Clear the build/dependency cache if available, then deploy.
5. Check installation logs for `sharp` and confirm the optional Linux binary is installed before checking startup logs.

WhatsApp sessions are stored in MySQL; keep the same database between deployments.
