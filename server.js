const http = require("http");
const https = require("https");
const puppeteer = require("puppeteer");

const PORT = process.env.PORT || 8888;
function getBaseUrl(req) {
  const host = req && req.headers && req.headers.host;
  if (host) return `https://${host}`;
  return process.env.RENDER_EXTERNAL_URL
    ? `https://${process.env.RENDER_EXTERNAL_URL}`
    : "https://roku-stream-proxy.onrender.com";
}

const SOURCES = [
  (id) => `https://vidlink.pro/movie/${id}`,
  (id) => `https://vidsrc.icu/embed/movie/${id}`,
  (id) => `https://moviesapi.club/movie/${id}`,
];

function fetchWithHeaders(url, referer, origin) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : require("http");
    const opts = {
      headers: {
        Referer: referer || u.origin + "/",
        Origin: origin || referer || u.origin + "/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0",
      },
    };
    lib.get(url, opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ body: Buffer.concat(chunks), contentType: res.headers["content-type"] }));
    }).on("error", reject);
  });
}

function encodeProxyPayload(url, referer) {
  const payload = referer ? `${url}|${referer}` : url;
  return Buffer.from(payload).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeProxyPayload(encoded) {
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = Buffer.from(padded, "base64").toString("utf8");
    const i = payload.indexOf("|");
    if (i >= 0) return { url: payload.substring(0, i), referer: payload.substring(i + 1) };
    return { url: payload, referer: "" };
  } catch (e) {
    return null;
  }
}

async function handleHlsProxy(req, res, pathname) {
  const match = pathname.match(/^\/hls\/([A-Za-z0-9_-]+)(\.(m3u8|ts))?$/);
  if (!match) {
    res.writeHead(404);
    return res.end();
  }
  const encoded = match[1];
  const ext = match[3] || "m3u8";
  const { url, referer } = decodeProxyPayload(encoded) || {};
  if (!url) {
    res.writeHead(400);
    return res.end("Invalid");
  }
  try {
    const { body, contentType } = await fetchWithHeaders(url, referer, referer);
    if (ext === "m3u8") {
      const baseUrl = url.includes("?") ? url.substring(0, url.indexOf("?")) : url;
      const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
      const proxyBase = getBaseUrl(req);
      let text = body.toString("utf8");
      const lines = text.split("\n");
      const out = [];
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (line.startsWith("#")) {
          out.push(line);
          continue;
        }
        line = line.trim();
        if (!line) {
          out.push(lines[i]);
          continue;
        }
        let segUrl = line;
        if (!segUrl.startsWith("http")) segUrl = new URL(segUrl, baseDir).href;
        const ref = referer || segUrl;
        const proxySeg = `${proxyBase}/hls/${encodeProxyPayload(segUrl, ref)}.${segUrl.includes(".m3u8") ? "m3u8" : "ts"}`;
        out.push(proxySeg);
      }
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.writeHead(200);
      return res.end(out.join("\n"));
    }
    res.setHeader("Content-Type", contentType || "video/mp2t");
    res.writeHead(200);
    return res.end(body);
  } catch (e) {
    console.log(`[hls] Error: ${e.message}`);
    res.writeHead(502);
    return res.end();
  }
}

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

  const results = [];

  for (const buildUrl of SOURCES) {
    const url = buildUrl(tmdbId);
    console.log(`[proxy] Trying: ${url}`);
    let page;
    try {
      page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const t = req.resourceType();
        if (["image", "stylesheet", "font", "media"].includes(t)) req.abort();
        else req.continue();
      });
      page.on("response", (res) => {
        const u = res.url();
        if (u.includes(".m3u8")) {
          console.log(`[proxy] Found HLS: ${u}`);
          let clean = u.split("?headers=")[0];
          let referer = "https://videostr.net/";
          try {
            const hdr = u.indexOf("?headers=") >= 0 && decodeURIComponent(u.substring(u.indexOf("?headers=") + 9));
            if (hdr) {
              const o = JSON.parse(hdr);
              if (o.referer) referer = o.referer;
              if (o.origin) referer = o.origin;
            }
          } catch (e) {}
          results.push({ url: clean, referer });
        }
      });

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await new Promise((r) => setTimeout(r, 8000));
      if (results.length > 0) {
        await page.close();
        break;
      }

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
            if (["image", "stylesheet", "font", "media"].includes(t)) req.abort();
            else req.continue();
          });
          p2.on("response", (res) => {
            if (res.url().includes(".m3u8")) {
              let u = res.url();
              let clean = u.split("?headers=")[0];
              let referer = "https://videostr.net/";
              try {
                const hdr = u.indexOf("?headers=") >= 0 && decodeURIComponent(u.substring(u.indexOf("?headers=") + 9));
                if (hdr) {
                  const o = JSON.parse(hdr);
                  if (o.referer) referer = o.referer;
                  if (o.origin) referer = o.origin;
                }
              } catch (e) {}
              results.push({ url: clean, referer });
            }
          });
          await p2.goto(src, { waitUntil: "domcontentloaded", timeout: 20000 });
          await new Promise((r) => setTimeout(r, 6000));
        } catch (e) {}
        await p2.close();
        if (results.length > 0) break;
      }
    } catch (e) {
      console.log(`[proxy] Error: ${e.message}`);
      if (page) try { await page.close(); } catch (e2) {}
    }
    if (results.length > 0) break;
  }

  await browser.close();

  const baseUrl = results.length ? (global.__hlsBaseUrl || "https://roku-stream-proxy.onrender.com") : "";
  return results.map(({ url, referer }) => ({
    url: `${baseUrl}/hls/${encodeProxyPayload(url, referer)}.m3u8`,
    headers: {},
  }));
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

  if (pathname.startsWith("/hls/")) {
    return handleHlsProxy(req, res, pathname);
  }

  res.setHeader("Content-Type", "application/json");

  if (pathname === "/health") {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "ok" }));
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const tmdbId = url.searchParams.get("id");

  if (!tmdbId) {
    res.writeHead(200);
    return res.end(JSON.stringify({ status: "running", usage: "/stream?id=TMDB_ID" }));
  }

  console.log(`\n[proxy] Resolving TMDB ID: ${tmdbId}`);
  try {
    global.__hlsBaseUrl = getBaseUrl(req);
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
