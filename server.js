const http = require("http");
const puppeteer = require("puppeteer");

const PORT = process.env.PORT || 8888;

const SOURCES = [
  (id) => `https://vidlink.pro/movie/${id}`,
  (id) => `https://vidsrc.icu/embed/movie/${id}`,
  (id) => `https://moviesapi.club/movie/${id}`,
];

async function resolveStream(tmdbId) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--no-zygote",
      "--disable-extensions",
      "--disable-background-networking",
      "--js-flags=--max-old-space-size=256",
    ],
  });

  const hlsUrls = new Set();

  for (const buildUrl of SOURCES) {
    const url = buildUrl(tmdbId);
    console.log(`[proxy] Trying: ${url}`);
    let page;
    try {
      page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const t = req.resourceType();
        if (["image", "stylesheet", "font", "media"].includes(t)) {
          req.abort();
        } else {
          req.continue();
        }
      });
      page.on("response", (res) => {
        const u = res.url();
        if (u.includes(".m3u8")) {
          console.log(`[proxy] Found HLS: ${u}`);
          hlsUrls.add(u);
        }
      });

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await new Promise((r) => setTimeout(r, 8000));
      if (hlsUrls.size > 0) { await page.close(); break; }

      const iframes = await page.$$eval("iframe", (els) =>
        els.map((el) => el.src).filter((s) => s && s.startsWith("http"))
      );
      await page.close();
      page = null;

      for (const src of iframes.slice(0, 2)) {
        console.log(`[proxy] Iframe: ${src}`);
        const p2 = await browser.newPage();
        try {
          await p2.setRequestInterception(true);
          p2.on("request", (req) => {
            const t = req.resourceType();
            if (["image", "stylesheet", "font", "media"].includes(t)) {
              req.abort();
            } else {
              req.continue();
            }
          });
          p2.on("response", (res) => {
            if (res.url().includes(".m3u8")) {
              console.log(`[proxy] HLS in iframe: ${res.url()}`);
              hlsUrls.add(res.url());
            }
          });
          await p2.goto(src, { waitUntil: "domcontentloaded", timeout: 20000 });
          await new Promise((r) => setTimeout(r, 6000));
        } catch (e) {}
        await p2.close();
        if (hlsUrls.size > 0) break;
      }
    } catch (e) {
      console.log(`[proxy] Error: ${e.message}`);
      if (page) try { await page.close(); } catch (e2) {}
    }
    if (hlsUrls.size > 0) break;
  }

  await browser.close();

  return [...hlsUrls].map((raw) => {
    const idx = raw.indexOf("?headers=");
    if (idx === -1) return { url: raw, headers: {} };
    const clean = raw.substring(0, idx);
    try {
      const hdr = JSON.parse(decodeURIComponent(raw.substring(idx + 9)));
      return { url: clean, headers: hdr };
    } catch (e) {
      return { url: clean, headers: {} };
    }
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "ok" }));
  }

  const tmdbId = url.searchParams.get("id");
  if (!tmdbId) {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "running", usage: "/stream?id=TMDB_ID" }));
  }

  console.log(`\n[proxy] Resolving TMDB ID: ${tmdbId}`);
  try {
    const streams = await resolveStream(tmdbId);
    console.log(`[proxy] Result: ${streams.length} streams`);
    res.writeHead(200);
    res.end(JSON.stringify({ streams }));
  } catch (e) {
    console.log(`[proxy] Fatal: ${e.message}`);
    res.writeHead(200);
    res.end(JSON.stringify({ streams: [] }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Roku Stream Proxy on port ${PORT}`);
});
