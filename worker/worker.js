/**
 * PinShop Cloudflare Worker (ESM)
 *
 * Endpoints:
 *   GET  /board?url=<pinterest board url>  -> { pins: [{ image_url, title, description, link }] }
 *   POST /identify   body: { image_url, title, description }  -> identification JSON
 *
 * Secrets (set with `npx wrangler secret put <NAME>`):
 *   ANTHROPIC_API_KEY  (required)
 *   ALLOWED_ORIGIN     (optional) e.g. https://your-username.github.io
 */

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";
const ANTHROPIC_VERSION = "2023-06-01";

// Pretend to be a normal browser so Pinterest doesn't immediately reject us.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (url.pathname === "/board" && request.method === "GET") {
        return await handleBoard(request, env);
      }
      if (url.pathname === "/identify" && request.method === "POST") {
        return await handleIdentify(request, env);
      }
      if (url.pathname === "/" || url.pathname === "/health") {
        return json({ ok: true, service: "pinshop-worker" }, 200, request, env);
      }
      return json({ error: "Not found" }, 404, request, env);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500, request, env);
    }
  },
};

/* -------------------------------------------------------------------------- */
/* CORS                                                                       */
/* -------------------------------------------------------------------------- */

function corsHeaders(request, env) {
  const allowed = env.ALLOWED_ORIGIN; // may be undefined
  const reqOrigin = request.headers.get("Origin") || "";
  let origin = "*";
  if (allowed) {
    // Only echo the origin back if it matches the configured one.
    origin = reqOrigin === allowed ? allowed : allowed;
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status, request, env) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders(request, env),
    },
  });
}

/* -------------------------------------------------------------------------- */
/* /board                                                                     */
/* -------------------------------------------------------------------------- */

async function handleBoard(request, env) {
  const reqUrl = new URL(request.url);
  let boardUrl = reqUrl.searchParams.get("url");
  if (!boardUrl) {
    return json({ error: "Missing ?url= parameter" }, 400, request, env);
  }

  boardUrl = boardUrl.trim();
  if (!/^https?:\/\//i.test(boardUrl)) boardUrl = "https://" + boardUrl;

  try {
    const u = new URL(boardUrl);
    if (!/pinterest\./i.test(u.hostname)) {
      return json({ error: "URL must be a pinterest.com board URL" }, 400, request, env);
    }
  } catch {
    return json({ error: "Invalid URL" }, 400, request, env);
  }

  // 1) Try the RSS feed first (cleanest data).
  let pins = await pinsFromRss(boardUrl);

  // 2) Fall back to scraping the board HTML for image URLs.
  if (!pins.length) {
    pins = await pinsFromHtml(boardUrl);
  }

  if (!pins.length) {
    return json(
      { error: "No pins found. Board may be private, empty, or Pinterest blocked the request." },
      404,
      request,
      env
    );
  }

  return json({ pins }, 200, request, env);
}

function rssUrlFor(boardUrl) {
  // Strip trailing slash, append .rss
  const trimmed = boardUrl.replace(/\/+$/, "");
  return trimmed + ".rss";
}

async function pinsFromRss(boardUrl) {
  try {
    const res = await fetch(rssUrlFor(boardUrl), { headers: BROWSER_HEADERS });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml);
  } catch {
    return [];
  }
}

function parseRss(xml) {
  const pins = [];
  const items = xml.split(/<item>/i).slice(1);
  for (const chunk of items) {
    const block = chunk.split(/<\/item>/i)[0];

    const title = decodeEntities(stripCdata(tagValue(block, "title")));
    const link = decodeEntities(stripCdata(tagValue(block, "link")));
    const description = stripCdata(tagValue(block, "description"));

    // The image usually lives in the description HTML as <img src="...">,
    // or in an enclosure/media tag.
    let image_url =
      attrValue(block, "enclosure", "url") ||
      attrValue(block, "media:content", "url") ||
      firstImgSrc(description);

    if (image_url) {
      image_url = upscalePinimg(decodeEntities(image_url));
      pins.push({
        image_url,
        title: cleanText(title),
        description: cleanText(stripTags(description)),
        link: link || "",
      });
    }
  }
  return pins;
}

async function pinsFromHtml(boardUrl) {
  try {
    const res = await fetch(boardUrl, { headers: BROWSER_HEADERS });
    if (!res.ok) return [];
    const html = await res.text();

    // Grab unique i.pinimg.com image URLs out of the raw HTML/JSON blob.
    const re = /https:\/\/i\.pinimg\.com\/[^"'\\\s)]+\.(?:jpg|jpeg|png|webp)/gi;
    const seen = new Set();
    const pins = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      const upscaled = upscalePinimg(m[0]);
      const key = pinimgKey(upscaled);
      if (seen.has(key)) continue;
      seen.add(key);
      pins.push({ image_url: upscaled, title: "", description: "", link: boardUrl });
      if (pins.length >= 50) break;
    }
    return pins;
  } catch {
    return [];
  }
}

// Pinterest serves multiple sizes under /<size>/. Prefer a big one for vision.
function upscalePinimg(u) {
  return u.replace(/\/(\d+x\d*|\d+x|236x|474x|564x|736x)\//, "/originals/");
}

// Two URLs that only differ by size are the same pin.
function pinimgKey(u) {
  return u.replace(/\/[^/]+\//, "/");
}

/* -------------------------------------------------------------------------- */
/* /identify                                                                  */
/* -------------------------------------------------------------------------- */

async function handleIdentify(request, env) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "Server missing ANTHROPIC_API_KEY" }, 500, request, env);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400, request, env);
  }

  const imageUrl = body.image_url;
  if (!imageUrl) {
    return json({ error: "Missing image_url" }, 400, request, env);
  }

  // Fetch and base64 the image.
  let base64, mediaType;
  try {
    const imgRes = await fetch(imageUrl, { headers: BROWSER_HEADERS });
    if (!imgRes.ok) throw new Error("Image fetch failed: " + imgRes.status);
    mediaType = imgRes.headers.get("Content-Type") || "image/jpeg";
    if (!/^image\//.test(mediaType)) mediaType = "image/jpeg";
    const buf = await imgRes.arrayBuffer();
    base64 = arrayBufferToBase64(buf);
  } catch (err) {
    return json({ error: "Could not load image: " + err.message }, 502, request, env);
  }

  const context = [
    body.title ? `Title: ${body.title}` : "",
    body.description ? `Description: ${body.description}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = buildIdentifyPrompt(context);

  const anthropicReq = {
    model: ANTHROPIC_MODEL,
    max_tokens: 600,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          { type: "text", text: prompt },
        ],
      },
    ],
  };

  let claudeRes;
  try {
    claudeRes = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(anthropicReq),
    });
  } catch (err) {
    return json({ error: "Anthropic request failed: " + err.message }, 502, request, env);
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return json({ error: "Anthropic error: " + errText }, claudeRes.status, request, env);
  }

  const data = await claudeRes.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = extractJson(text);
  if (!parsed) {
    return json({ error: "Could not parse identification", raw: text }, 502, request, env);
  }

  return json(parsed, 200, request, env);
}

function buildIdentifyPrompt(context) {
  return [
    "You are a product identification assistant for a shopping app.",
    "Look at the image and identify the single main purchasable item shown.",
    "The image is the primary signal (~80%). Use any provided text only as supporting context (~20%).",
    context ? "\nPin context:\n" + context : "",
    "",
    "Respond with ONLY a JSON object, no markdown, no prose, in exactly this shape:",
    "{",
    '  "item": "short product name, e.g. \\"ribbed knit cardigan\\"",',
    '  "color": "primary color/pattern, or empty string",',
    '  "brand": "brand if clearly identifiable, else empty string",',
    '  "category": "one of: clothing, shoes, accessories, bags, jewelry, beauty, home, furniture, decor, kids, fitness, other",',
    '  "amazon_query": "best search phrase to find this on Amazon",',
    '  "general_query": "a broader search phrase usable on any retailer",',
    '  "confidence": "high | medium | low"',
    "}",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function tagValue(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function attrValue(block, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["']`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function firstImgSrc(html) {
  const m = html && html.match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  return m ? m[1] : "";
}

function stripCdata(s) {
  return s ? s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim() : "";
}

function stripTags(s) {
  return s ? s.replace(/<[^>]+>/g, " ") : "";
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim().slice(0, 400);
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extractJson(text) {
  if (!text) return null;
  // Strip code fences if present.
  let t = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    // Fall back to grabbing the first {...} block.
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}
