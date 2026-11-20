# theCP machine — AI Photo Generator

- **Create**: type a prompt → get an image.
- **Combine**: upload 2–4 photos → AI blends them into one image (or 1 photo + prompt to edit it).

## Put it online (free, Vercel)
1. Make a new GitHub repo (e.g. `thecp-machine`) and upload these files: `index.html`, `package.json`, `api/generate.js`.
2. On vercel.com → **Add New → Project** → import the repo → **Deploy**.
3. Get a free Gemini key at https://aistudio.google.com/apikey
4. In Vercel: **Project → Settings → Environment Variables** → add
   - `GEMINI_API_KEY` = your key
   - (optional) `CREDITS_PER_DAY` = credits per visitor per day (default 10)
   - (optional) `SITE_COMBINE_CAP` = max photo combines for the whole site per day (default 50)
5. **Deployments → ⋯ → Redeploy** so the key takes effect.

Text-only "Create" still works without a key (it uses a free backup generator).
"Combine" needs the Gemini key.

If Google renames the image model, set `GEMINI_IMAGE_MODEL` to the new name.

## Credits
- Every visitor gets 10 credits a day (resets at midnight UTC, which is 7 PM Eastern).
- Create = 1 credit (uses the free generator first). Combine/Edit = 2 credits (uses Gemini).
- Sized for about 25 people a day: 25 × 10 = 250 credits.
- Site-wide cap of 50 combines a day keeps Gemini costs at about $2/day max.
- Failed images don't use credits.
