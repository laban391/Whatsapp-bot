# LABAN-XMD — PXXL + MongoDB edition

This build uses Baileys for WhatsApp, MongoDB Atlas for session/auth storage, and Express for the pairing website/API. MySQL dependencies and code are not included.

## PXXL deployment

1. Upload these project files to a GitHub repository (the contents of this folder should be at the repository root).
2. Connect that repository to PXXL and select Node.js 22.
3. Set the start command to `npm start`.
4. Add the environment variables below in PXXL's Environment Variables/Secrets panel. Do not commit real keys to GitHub.
5. Deploy.

Required variables:
- `MONGO_URI`: MongoDB Atlas connection string, including the intended database name in the path.

Optional variables:
- `PORT`: usually supplied by the host; default is 3000.
- `GEMINI_API_KEY`: enables `.ai`, `.gpt`, and `.gemini`.
- `GEMINI_MODEL`: defaults to `gemini-2.5-flash-lite`.

## MongoDB session preservation

The server uses Mongoose models `UserSession` and `AuthData`, which map by default to the `usersessions` and `authdatas` collections. Use the same MongoDB database that contains your existing LABAN-XMD sessions if you want those sessions restored. Do not delete these collections.

## Notes

- The project includes the existing commands, media/download features, pairing website, and session restore flow from the PXXL project snapshot.
- Install dependencies with `npm install` during the build/deploy process.
- If the host blocks native package install scripts, check the build log for the specific package; do not remove unrelated features or dependencies to work around it.
