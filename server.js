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

function fetchWithHeaders(url, referer, origin, hostHeader, redirectCount) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : require("http");
    const headers = {
      Referer: referer || u.origin + "/",
      Origin: origin || referer || u.origin + "/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "*/*",
    };
    const req = lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        return fetchWithHeaders(next, referer, origin, hostHeader, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        console.log(`[hls] Fetch status ${res.statusCode} for ${url.substring(0, 60)}...`);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ body: Buffer.concat(chunks), contentType: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function encodeProxyPayload(url, referer, hostHeader) {
  let payload = url;
  if (referer) payload += "|" + referer;
  if (hostHeader) payload += "|" + hostHeader;
  return Buffer.from(payload).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeProxyPayload(encoded) {
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = Buffer.from(padded, "base64").toString("utf8");
    const parts = payload.split("|");
    return {
      url: parts[0] || "",
      referer: parts[1] || "",
      hostHeader: parts[2] || "",
    };
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
  const decoded = decodeProxyPayload(encoded);
  const { url, referer, hostHeader } = decoded || {};
  if (!url) {
    res.writeHead(400);
    return res.end("Invalid");
  }
  try {
    console.log(`[hls] Fetching ${ext}: ${url.substring(0, 80)}...`);
    const { body, contentType } = await fetchWithHeaders(url, referer, referer, hostHeader);
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
        const proxySeg = `${proxyBase}/hls/${encodeProxyPayload(segUrl, ref, hostHeader)}.${segUrl.includes(".m3u8") ? "m3u8" : "ts"}`;
        out.push(proxySeg);
      }
      console.log(`[hls] OK m3u8, ${out.length} lines`);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.writeHead(200);
      return res.end(out.join("\n"));
    }
    console.log(`[hls] OK ${ext}, ${body.length} bytes`);
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
          let clean = u.split("?")[0];
          let referer = "https://videostr.net/";
          let hostHeader = "";
          try {
            const qs = u.indexOf("?") >= 0 ? u.substring(u.indexOf("?") + 1) : "";
            const params = new URLSearchParams(qs);
            const hdr = params.get("headers");
            if (hdr) {
              const o = JSON.parse(decodeURIComponent(hdr));
              if (o.referer) referer = o.referer;
              if (o.origin) referer = o.origin;
            }
            const hostParam = params.get("host");
            if (hostParam) hostHeader = hostParam.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
          } catch (e) {}
          results.push({ url: clean, referer, hostHeader });
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
              let clean = u.split("?")[0];
              let referer = "https://videostr.net/";
              let hostHeader = "";
              try {
                const qs = u.indexOf("?") >= 0 ? u.substring(u.indexOf("?") + 1) : "";
                const params = new URLSearchParams(qs);
                const hdr = params.get("headers");
                if (hdr) {
                  const o = JSON.parse(decodeURIComponent(hdr));
                  if (o.referer) referer = o.referer;
                  if (o.origin) referer = o.origin;
                }
                const hostParam = params.get("host");
                if (hostParam) hostHeader = hostParam.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
              } catch (e) {}
              results.push({ url: clean, referer, hostHeader });
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
  return results.map(({ url, referer, hostHeader }) => ({
    url: `${baseUrl}/hls/${encodeProxyPayload(url, referer, hostHeader)}.m3u8`,
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
