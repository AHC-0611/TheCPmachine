// theCP machine — serverless image endpoint (Vercel)
// POST { prompt: string, images?: [{ mimeType, data(base64) }], aspect?: "1:1"|"16:9"|"9:16" }
// -> { image: "data:image/png;base64,...", note?: string }

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "20", 10);

// Best-effort per-visitor limit (resets when the function cold-starts).
const usage = new Map();
function overLimit(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const key = ip + "|" + day;
  const n = (usage.get(key) || 0) + 1;
  usage.set(key, n);
  if (usage.size > 5000) usage.clear();
  return n > DAILY_LIMIT;
}

const SIZES = { "1:1": [1024, 1024], "16:9": [1344, 768], "9:16": [768, 1344] };

async function geminiImage(prompt, images, aspect) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("NO_KEY");

  const parts = [];
  for (const img of images) {
    parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
  }
  let text = prompt;
  if (images.length >= 2) {
    text =
      `Combine these ${images.length} photos into ONE single new, realistic image. ` +
      `Keep the people/objects recognizable. Instructions: ${prompt || "blend them naturally into one scene"}`;
  } else if (images.length === 1) {
    text = `Edit this photo. Instructions: ${prompt}`;
  }
  if (aspect && aspect !== "1:1") text += ` Make the image ${aspect} aspect ratio.`;
  parts.push({ text });

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
    }
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Gemini error ${r.status}`);

  const outParts = j?.candidates?.[0]?.content?.parts || [];
  const img = outParts.find((p) => p.inlineData || p.inline_data);
  if (!img) {
    const said = outParts.map((p) => p.text).filter(Boolean).join(" ");
    throw new Error(said || "The AI didn't return an image. Try rewording your prompt.");
  }
  const d = img.inlineData || img.inline_data;
  return `data:${d.mimeType || d.mime_type || "image/png"};base64,${d.data}`;
}

// Free, no-key fallback for text-only generation.
async function pollinationsImage(prompt, aspect) {
  const [w, h] = SIZES[aspect] || SIZES["1:1"];
  const seed = Math.floor(Math.random() * 1e9);
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${w}&height=${h}&seed=${seed}&nologo=true`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Backup generator error ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const type = r.headers.get("content-type") || "image/jpeg";
  return `data:${type};base64,${buf.toString("base64")}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  if (overLimit(ip)) {
    return res.status(429).json({ error: `Daily limit reached (${DAILY_LIMIT} images). Come back tomorrow!` });
  }

  let { prompt = "", images = [], aspect = "1:1" } = req.body || {};
  prompt = String(prompt).slice(0, 2000).trim();
  images = Array.isArray(images) ? images.slice(0, 4) : [];
  images = images.filter((i) => i && typeof i.data === "string" && /^image\//.test(i.mimeType || ""));

  if (!prompt && images.length < 2) {
    return res.status(400).json({ error: "Type a prompt (or add at least 2 photos to combine)." });
  }

  try {
    const image = await geminiImage(prompt, images, aspect);
    return res.status(200).json({ image });
  } catch (err) {
    // Text-only? fall back to the free generator.
    if (images.length === 0) {
      try {
        const image = await pollinationsImage(prompt, aspect);
        return res.status(200).json({ image, note: "Made with the backup generator." });
      } catch (e2) {
        return res.status(502).json({ error: e2.message });
      }
    }
    const msg = err.message === "NO_KEY"
      ? "Photo combining needs a GEMINI_API_KEY set in Vercel (see README)."
      : err.message;
    return res.status(502).json({ error: msg });
  }
}

export const config = { maxDuration: 60 };
