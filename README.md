# PinShop

Paste a public Pinterest board URL → AI vision identifies each item → get Amazon (with your affiliate tag) + fallback retailer links.

Two pieces:
- **`docs/`** — static frontend (HTML/CSS/JS). Hosts free on GitHub Pages.
- **`worker/`** — Cloudflare Worker that scrapes Pinterest boards and calls Claude vision. Free tier, holds your Anthropic API key so it never touches the browser.

---

## Quick start (full deploy, ~30 minutes)

You need:
- A GitHub account
- A Cloudflare account (free)
- An Anthropic API key — https://console.anthropic.com/
- (optional but recommended) An Amazon Associates account — https://affiliate-program.amazon.com/

### 1. Push this folder to GitHub

```bash
cd "<this folder>"
git init
git add .
git commit -m "Initial PinShop"
gh repo create pinshop --public --source=. --push
```

(or use the GitHub web UI to create the repo and drag files in.)

### 2. Deploy the Cloudflare Worker

```bash
cd worker
npm install
npx wrangler login            # opens browser, sign into Cloudflare
npx wrangler secret put ANTHROPIC_API_KEY   # paste your key when prompted
npx wrangler deploy
```

Wrangler prints a URL like `https://pinterest-shop-worker.YOUR-SUBDOMAIN.workers.dev`. Copy it.

(Optional: lock the Worker to only your site's origin once Pages is live: `npx wrangler secret put ALLOWED_ORIGIN` → paste `https://YOUR-USERNAME.github.io`.)

### 3. Turn on GitHub Pages

In your repo on GitHub:
1. **Settings → Pages**
2. **Source:** `Deploy from a branch`
3. **Branch:** `main`, **Folder:** `/docs`
4. Save. Wait ~5 minutes for the first build.

Your site will be at `https://YOUR-USERNAME.github.io/pinshop/`.

### 4. Configure the frontend

Open your live site, click the **⚙** in the top right, and paste:
- **Worker URL** — the URL from step 2
- **Amazon Associates tag** — e.g. `yourtag-20` (leave blank for now if your account is still pending — every Amazon link will just be a plain search until you add it)

Settings save to your browser's localStorage. To bake them in as defaults for everyone who loads your site, edit `docs/config.js` and commit.

### 5. Use it

Paste a public Pinterest board URL (yours or anyone else's), click **Load board**, then **Identify all**. Each card gets a yellow **Shop on Amazon** button plus 2–3 fallback retailer buttons picked by item category (Nordstrom, ASOS, Revolve, Zappos, Etsy, Lululemon).

---

## How it works

1. **Frontend → Worker `/board?url=`**: Worker fetches Pinterest's RSS feed for the board (`<board-url>.rss`). If that fails or returns nothing, it falls back to scraping the board HTML for `i.pinimg.com` image URLs.
2. **Worker returns pins** with `image_url`, `title`, `description`, `link`.
3. **Frontend → Worker `/identify`** (one POST per pin, or all in parallel with concurrency=3 when you click "Identify all"): Worker pulls the image, base64s it, and sends it to Claude Sonnet 4.5 vision along with the pin's title/description. Image is the ~80% signal; text is the ~20% supporting context. Claude returns a JSON identification (item, color, category, search queries).
4. **Frontend builds shop links**: Amazon search URL with your Associates tag, plus 2–3 category-appropriate fallbacks.

## Costs

- **Cloudflare Worker** — free tier covers 100,000 requests/day.
- **GitHub Pages** — free.
- **Anthropic API (Claude Sonnet 4.5 vision)** — roughly $0.01–0.02 per pin identification. A 25-pin board ≈ $0.25–$0.50.
- **Amazon Associates** — free to apply; you earn commission on qualifying purchases through your links.

## Limits

- **Pinterest RSS returns at most ~25 latest pins per board.** For full board access you'd need the Pinterest official API (developer account + OAuth) — easy upgrade path: swap the `/board` handler in `worker/worker.js` to call `https://api.pinterest.com/v5/boards/{board_id}/pins` with a bearer token.
- **Private boards won't work** without the official API.
- **AI identification isn't perfect.** Pins with no clear focal item (mood boards, full-room shots) will return their best guess, sometimes wrong. The "general_query" fallback retailer links often catch what Amazon misses.

## Upgrade paths

- **Move to the Pinterest API** for full board access and private boards. Replace `handleBoard()` in `worker/worker.js`.
- **Add image-similarity reverse search** (Google Lens style) for better matches — would need a service like SerpAPI's Google Lens endpoint.
- **Add more retailers**: extend `RETAILER_URLS` + `CATEGORY_FALLBACKS` in `docs/app.js`.
- **Save boards / wishlist**: persist `pins` in localStorage or move to a small KV store on the Worker.

## File map

```
.
├── README.md            (this file)
├── docs/                (GitHub Pages root)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   └── config.js        (Worker URL + Amazon tag defaults)
└── worker/              (Cloudflare Worker)
    ├── worker.js        (ESM: /board + /identify endpoints)
    ├── wrangler.toml    (Worker config)
    ├── package.json     (wrangler devDep)
    └── .gitignore
```
