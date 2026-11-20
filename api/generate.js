// TheCPMachine — serverless image endpoint (Vercel)
// POST { prompt, images?: [{ mimeType, data(base64) }], aspect?: "1:1"|"16:9"|"9:16"|"orig", dims?: {w,h} }
// Create = no images, Edit = 1 image, Combine = 2–4 images.
// -> { image: "data:image/png;base64,...", note?: string }

const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

// ---- Credits (sized for ~25 people a day) ----
// Each visitor: 10 credits/day. Create = 1 credit, Combine/Edit = 2 credits.
// 25 people x 10 credits = 250 credits/day total.
const CREDITS_PER_DAY = parseInt(process.env.CREDITS_PER_DAY || "10", 10);
const COST_CREATE = 1;
const COST_COMBINE = 2;
// Cap on combines for the WHOLE site per day (keeps inside Cloudflare's free daily allowance).
const SITE_COMBINE_CAP = parseInt(process.env.SITE_COMBINE_CAP || "50", 10);

// Best-effort memory (resets when Vercel restarts the function).
const spent = new Map();
let siteCombines = { day: "", n: 0 };
const today = () => new Date().toISOString().slice(0, 10);
// Credits are counted PER DEVICE (each browser gets its own ID), so phones/laptops
// on the same Wi-Fi each get their own credits.
const keyFor = (k) => k + "|" + today();
const usedKey = (k) => spent.get(keyFor(k)) || 0;
const used = (who) => usedKey(who.dev);
const left = (who) => Math.max(0, CREDITS_PER_DAY - usedKey(who.dev));
function addKey(k, n) { spent.set(keyFor(k), Math.max(0, usedKey(k) + n)); }
function charge(who, n) {
  if (spent.size > 10000) spent.clear();
  addKey(who.dev, n);
}
// Create images are loaded by the visitor's browser; if that fails it can ask for a refund.
const tickets = new Map(); // ticket -> { ip, cost, t }
function newTicket(who, cost) {
  if (tickets.size > 5000) tickets.clear();
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  tickets.set(id, { dev: who.dev, cost, t: Date.now() });
  return id;
}

// Turn long API errors into something short and readable.
function friendly(msg = "") {
  if (/quota|RESOURCE_EXHAUSTED|rate.?limit|billing/i.test(msg)) {
    return "Photo combining isn't available right now — the AI service is out of free uses for now. Try again later!";
  }
  if (/API key not valid|API_KEY_INVALID|permission/i.test(msg)) {
    return "Photo combining isn't set up right — the site's Gemini key isn't working.";
  }
  if (/safety|blocked|prohibited/i.test(msg)) return "The AI wouldn't make that one. Try a different prompt or photos.";
  msg = String(msg).split("\n")[0];
  return msg.length > 160 ? msg.slice(0, 157) + "…" : msg;
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

// Cloudflare Workers AI (free 10,000 neurons/day ≈ 170 images). Used for Create when set up.
async function cloudflareImage(prompt) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) throw new Error("NO_CF");
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, steps: 4 }),
    }
  );
  const j = await r.json().catch(() => ({}));
  const b64 = j?.result?.image;
  if (!r.ok || !b64) throw new Error(j?.errors?.[0]?.message || `Cloudflare error ${r.status}`);
  return `data:image/jpeg;base64,${b64}`;
}

// Cloudflare FLUX.2 [klein] — combines up to 4 photos (free daily allowance).
// "orig" = keep the uploaded photo's shape (longest side 1024, multiples of 16).
function sizeFor(aspect, dims) {
  if (aspect === "orig" && dims && dims.w > 0 && dims.h > 0) {
    const s = 1024 / Math.max(dims.w, dims.h);
    const r16 = (n) => Math.max(256, Math.round((n * s) / 16) * 16);
    return [r16(dims.w), r16(dims.h)];
  }
  return SIZES[aspect] || SIZES["1:1"];
}

async function cloudflareCombine(prompt, images, aspect, dims) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID, token = process.env.CLOUDFLARE_API_TOKEN;
  if (!acct || !token) throw new Error("NO_CF");
  const [w, h] = sizeFor(aspect, dims);
  let text;
  if (images.length >= 2) {
    text = `Combine the ${images.length} input images (image 0 to image ${images.length - 1}) into ONE single, realistic, natural-looking photo. ` +
      `Keep every person, face, and object looking exactly like they do in their image. ` +
      `${prompt ? "Instructions: " + prompt : "Blend them naturally into one scene with matching lighting."}`;
  } else {
    text = `Edit image 0. Keep everything that the instructions don't mention exactly the same — ` +
      `same person, face, pose and framing. Only change this: ${prompt}`;
  }
  const form = new FormData();
  form.append("prompt", text);
  form.append("width", String(w));
  form.append("height", String(h));
  images.forEach((img, i) => {
    form.append(`input_image_${i}`, new Blob([Buffer.from(img.data, "base64")], { type: img.mimeType }), `image${i}.jpg`);
  });
  const model = process.env.CF_COMBINE_MODEL || "@cf/black-forest-labs/flux-2-klein-4b";
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  const b64 = j?.result?.image;
  if (!r.ok || !b64) throw new Error(j?.errors?.[0]?.message || `Cloudflare error ${r.status}`);
  return b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
}

// Free, no-key generator. The visitor's browser loads this URL itself
// (so the free service sees each visitor separately and doesn't rate-limit the site).
function pollinationsUrl(prompt, aspect) {
  const [w, h] = SIZES[aspect] || SIZES["1:1"];
  const seed = Math.floor(Math.random() * 1e9);
  return (
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`
  );
}

export default async function handler(req, res) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const devId = String(req.headers["x-cp-device"] || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  const who = { dev: devId ? "d:" + devId : "ip:" + ip };
  const info = () => ({ credits: left(who), max: CREDITS_PER_DAY, costCreate: COST_CREATE, costCombine: COST_COMBINE });

  if (req.method === "GET") return res.status(200).json(info());
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  let { prompt = "", images = [], aspect = "1:1", refund, dims } = req.body || {};

  // Browser couldn't load a Create image -> give the credit back.
  if (refund) {
    const tk = tickets.get(refund);
    if (tk && tk.dev === who.dev) { tickets.delete(refund); charge(who, -tk.cost); }
    return res.status(200).json({ refunded: !!tk, ...info() });
  }

  prompt = String(prompt).slice(0, 2000).trim();
  images = Array.isArray(images) ? images.slice(0, 4) : [];
  images = images.filter((i) => i && typeof i.data === "string" && /^image\//.test(i.mimeType || ""));

  if (!prompt && images.length < 2) {
    return res.status(400).json({ error: "Type a prompt (or add at least 2 photos to combine).", ...info() });
  }

  const isCombine = images.length > 0;
  const cost = isCombine ? COST_COMBINE : COST_CREATE;
  if (left(who) < cost) {
    return res.status(429).json({ error: `Out of credits for today! You get ${CREDITS_PER_DAY} new credits tomorrow.`, ...info() });
  }

  if (!isCombine && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
    try {
      const image = await cloudflareImage(prompt);
      charge(who, cost);
      return res.status(200).json({ image, ...info() });
    } catch (e) {
      console.error("Cloudflare failed, using backup:", e.message); // falls through to free backup
    }
  }

  if (!isCombine) {
    // Create backup: hand the browser a free-generator link. Credit is refunded if it fails to load.
    charge(who, cost);
    const ticket = newTicket(who, cost);
    return res.status(200).json({ url: pollinationsUrl(prompt, aspect), ticket, ...info() });
  }

  if (combinesLeftSite() <= 0) {
    return res.status(429).json({ error: "The machine hit today's combine limit for the whole site. Try again tomorrow!", ...info() });
  }
  try {
    // Cloudflare first; Gemini only if someone has set a Gemini key and Cloudflare isn't set up.
    const useCF = process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN;
    const image = useCF || !process.env.GEMINI_API_KEY
      ? await cloudflareCombine(prompt, images, aspect, dims)
      : await geminiImage(prompt, images, aspect);
    siteCombines.n++;
    charge(who, cost);
    return res.status(200).json({ image, ...info() });
  } catch (err) {
    console.error("Combine failed:", err.message);
    const msg = err.message === "NO_CF" || err.message === "NO_KEY"
      ? "Photo combining needs the Cloudflare keys set in Vercel (see README)."
      : /neuron|daily|limit|quota|capacity/i.test(err.message)
        ? "The machine used up today's free combines. Try again tomorrow!"
        : friendly(err.message);
    return res.status(502).json({ error: msg + " No credits were used.", ...info() });
  }
}

export const config = { maxDuration: 60 };
