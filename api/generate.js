// theCP machine — serverless image endpoint (Vercel)
// POST { prompt: string, images?: [{ mimeType, data(base64) }], aspect?: "1:1"|"16:9"|"9:16" }
// -> { image: "data:image/png;base64,...", note?: string }

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

// ---- Credits (sized for ~25 people a day) ----
// Each visitor: 10 credits/day. Create = 1 credit, Combine/Edit = 2 credits.
// 25 people x 10 credits = 250 credits/day total.
const CREDITS_PER_DAY = parseInt(process.env.CREDITS_PER_DAY || "10", 10);
const COST_CREATE = 1;
const COST_COMBINE = 2;
// Safety cap on paid Gemini combines for the WHOLE site per day (~$0.04 each).
const SITE_COMBINE_CAP = parseInt(process.env.SITE_COMBINE_CAP || "50", 10);

// Best-effort memory (resets when Vercel restarts the function).
const spent = new Map();
let siteCombines = { day: "", n: 0 };
const today = () => new Date().toISOString().slice(0, 10);
const keyFor = (ip) => ip + "|" + today();
const used = (ip) => spent.get(keyFor(ip)) || 0;
const left = (ip) => Math.max(0, CREDITS_PER_DAY - used(ip));
function charge(ip, n) {
  if (spent.size > 5000) spent.clear();
  spent.set(keyFor(ip), used(ip) + n);
}
function combinesLeftSite() {
  if (siteCombines.day !== today()) siteCombines = { day: today(), n: 0 };
  return SITE_COMBINE_CAP - siteCombines.n;
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
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const info = () => ({ credits: left(ip), max: CREDITS_PER_DAY, costCreate: COST_CREATE, costCombine: COST_COMBINE });

  if (req.method === "GET") return res.status(200).json(info());
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  let { prompt = "", images = [], aspect = "1:1" } = req.body || {};
  prompt = String(prompt).slice(0, 2000).trim();
  images = Array.isArray(images) ? images.slice(0, 4) : [];
  images = images.filter((i) => i && typeof i.data === "string" && /^image\//.test(i.mimeType || ""));

  if (!prompt && images.length < 2) {
    return res.status(400).json({ error: "Type a prompt (or add at least 2 photos to combine).", ...info() });
  }

  const isCombine = images.length > 0;
  const cost = isCombine ? COST_COMBINE : COST_CREATE;
  if (left(ip) < cost) {
    return res.status(429).json({ error: `Out of credits for today! You get ${CREDITS_PER_DAY} new credits tomorrow.`, ...info() });
  }

  try {
    let image, note;
    if (!isCombine) {
      // Create: free generator first, Gemini as backup.
      try { image = await pollinationsImage(prompt, aspect); }
      catch { image = await geminiImage(prompt, [], aspect); note = "Made with Gemini."; }
    } else {
      if (combinesLeftSite() <= 0) {
        return res.status(429).json({ error: "The machine hit today's combine limit for the whole site. Try again tomorrow!", ...info() });
      }
      image = await geminiImage(prompt, images, aspect);
      siteCombines.n++;
    }
    charge(ip, cost);
    return res.status(200).json({ image, note, ...info() });
  } catch (err) {
    const msg = err.message === "NO_KEY"
      ? "Photo combining needs a GEMINI_API_KEY set in Vercel (see README)."
      : err.message;
    return res.status(502).json({ error: msg + " (No credits were used.)", ...info() });
  }
}

export const config = { maxDuration: 60 };
