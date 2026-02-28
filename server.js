const http = require("http");
const puppeteer = require("puppeteer");

const PORT = process.env.PORT || 8888;

const SOURCES = [
  (id) => `https://vidsrc.cc/v2/embed/movie/${id}`,
  (id) => `https://vidsrc.icu/embed/movie/${id}`,
  (id) => `https://moviesapi.club/movie/${id}`,
  (id) => `https://vidlink.pro/movie/${id}`,
];

async function resolveStream(tmdbId) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });

  const hlsUrls = new Set();

  for (const buildUrl of SOURCES) {
    const url = buildUrl(tmdbId);
    console.log(`[proxy] Trying: ${url}`);
    const page = await browser.newPage();
    try {
      page.on("response", (res) => {
        const u = res.url();
        if (u.includes(".m3u8")) {
          console.log(`[proxy] Found HLS: ${u}`);
          hlsUrls.add(u);
        }
      });

      await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
      await new Promise((r) => setTimeout(r, 5000));

      if (hlsUrls.size > 0) {
        await page.close();
        break;
      }

      const iframes = await page.$$eval("iframe", (els) =>
        els.map((el) => el.src).filter((s) => s && s.startsWith("http"))
      );
      for (const iframeSrc of iframes.slice(0, 3)) {
        console.log(`[proxy] Following iframe: ${iframeSrc}`);
        const ipage = await browser.newPage();
        try {
          ipage.on("response", (res) => {
            const u = res.url();
            if (u.includes(".m3u8")) {
              console.log(`[proxy] Found HLS in iframe: ${u}`);
              hlsUrls.add(u);
            }
          });
          await ipage.goto(iframeSrc, {
            waitUntil: "networkidle2",
            timeout: 15000,
          });
          await new Promise((r) => setTimeout(r, 3000));
        } catch (e) {
          /* ignore */
        }
        await ipage.close();
        if (hlsUrls.size > 0) break;
      }
    } catch (e) {
      console.log(`[proxy] Error: ${e.message}`);
    }
    await page.close();
    if (hlsUrls.size > 0) break;
  }

  await browser.close();
  return [...hlsUrls];
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  const tmdbId = url.searchParams.get("id");
  if (!tmdbId) {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "proxy running",
        usage: "/stream?id=TMDB_ID",
      })
    );
    return;
  }

  console.log(`\n[proxy] Resolving TMDB ID: ${tmdbId}`);
  try {
    const streams = await resolveStream(tmdbId);
    console.log(`[proxy] Found ${streams.length} streams`);
    res.writeHead(200);
    res.end(JSON.stringify({ streams }));
  } catch (e) {
    console.log(`[proxy] Error: ${e.message}`);
    res.writeHead(200);
    res.end(JSON.stringify({ error: e.message, streams: [] }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Roku Stream Proxy running on port ${PORT}`);
});
