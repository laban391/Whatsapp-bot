# MOON Multi-User WhatsApp Bot

This project follows the uploaded LABAN-XMD-style architecture: Express pairing website, one Baileys socket per phone number, isolated authentication keys per user, reconnect/restore, and a protected owner dashboard. Session and auth data are stored in MySQL (OptikLink-compatible), not MongoDB.

## OptikLink setup
1. Upload and extract this ZIP in your bot server.
2. Set the start command to `npm start` and use Node.js 22.
3. Add these environment variables in OptikLink (never put the password in a source file):
   - `DB_HOST=delta.optiklink.com`
   - `DB_PORT=3306`
   - `DB_NAME=s325147_Moon`
   - `DB_USER=YOUR_DATABASE_USERNAME`
   - `DB_PASSWORD=YOUR_DATABASE_PASSWORD`
   - `PORT=7538` (or the port assigned by your host)
   - `ADMIN_TOKEN=SET_A_LONG_RANDOM_SECRET`
4. Ensure the MySQL user has permission to CREATE/ALTER tables in the selected database. The app creates `user_sessions` and `auth_data` automatically.
5. Start the server. Open the website root URL to request a WhatsApp pairing code. Enter the full international number without `+`, e.g. Kenya `2547XXXXXXXX`.
6. On WhatsApp: Linked devices → Link a device → Link with phone number instead.
7. Owner dashboard: `/admin.html`; enter the `ADMIN_TOKEN` value to view sessions and disconnect active sockets.

## Important
- Each phone number gets a separate Baileys session and auth namespace in MySQL.
- Saved sessions are restored after a server restart.
- Do not share `ADMIN_TOKEN` or database credentials.
- Pairing requires an internet-accessible HTTPS website and WhatsApp to accept the pairing request.
- This package is based on the uploaded reference project and retains that project's command engine. It is not a merge of the separate WA-BASE-BOT plugin ZIP.
