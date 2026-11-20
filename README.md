# theCP machine — AI Photo Generator

- **Create**: type a prompt → get an image.
- **Combine**: upload 2–4 photos → AI blends them into one image (or 1 photo + prompt to edit it).

## Put it online (free, Vercel)
1. Make a new GitHub repo (e.g. `thecp-machine`) and upload these files: `index.html`, `package.json`, `api/generate.js`.
2. On vercel.com → **Add New → Project** → import the repo → **Deploy**.
3. Get a free Gemini key at https://aistudio.google.com/apikey
4. In Vercel: **Project → Settings → Environment Variables** → add
   - `GEMINI_API_KEY` = your key
   - (optional) `DAILY_LIMIT` = images per visitor per day (default 20)
5. **Deployments → ⋯ → Redeploy** so the key takes effect.

Text-only "Create" still works without a key (it uses a free backup generator).
"Combine" needs the Gemini key.

If Google renames the image model, set `GEMINI_IMAGE_MODEL` to the new name.
