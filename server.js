const http = require("http");
const https = require("https");
const puppeteer = require("puppeteer");
const crypto = require("crypto");

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

const PUPPETEER_LAUNCH_OPTIONS = {
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
};

// Session cache: stores m3u8 bodies, cookies, and referer per session
const sessionCache = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 min

function createSession(data) {
  const id = crypto.randomBytes(8).toString("hex");
  sessionCache.set(id, { ...data, createdAt: Date.now() });
  // Cleanup old sessions
  for (const [k, v] of sessionCache) {
    if (Date.now() - v.createdAt > SESSION_TTL) sessionCache.delete(k);
  }
  return id;
}

function fetchWithCookies(url, referer, cookies) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : require("http");
    const pathRaw = decodeURIComponent(u.pathname) + (u.search || "");
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: pathRaw,
      method: "GET",
      headers: {
        Referer: referer || u.origin + "/",
        Origin: (referer || u.origin + "/").replace(/\/$/, ""),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      },
    };
    if (cookies) options.headers.Cookie = cookies;
    console.log(`[hls] GET ${u.hostname}${pathRaw.substring(0, 50)}... ${cookies ? "(with cookies)" : ""}`);
    const req = lib.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        console.log(`[hls] Redirect -> ${next.substring(0, 60)}...`);
        return fetchWithCookies(next, referer, cookies).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        console.log(`[hls] Status ${res.statusCode}`);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ body: Buffer.concat(chunks), contentType: res.headers["content-type"] }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

function encodeProxyPayload(sessionId, url) {
  const payload = sessionId + "|" + url;
  return Buffer.from(payload).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeProxyPayload(encoded) {
  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const payload = Buffer.from(padded, "base64").toString("utf8");
    const idx = payload.indexOf("|");
    if (idx < 0) return null;
    return {
      sessionId: payload.substring(0, idx),
      url: payload.substring(idx + 1),
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
  if (!decoded) {
    res.writeHead(400);
    return res.end("Invalid");
  }
  const { sessionId, url } = decoded;
  const session = sessionCache.get(sessionId);
  if (!session) {
    console.log(`[hls] Session ${sessionId} not found`);
    res.writeHead(410);
    return res.end("Session expired");
  }

  try {
    if (ext === "m3u8" && session.m3u8Bodies && session.m3u8Bodies[url]) {
      console.log(`[hls] Serving m3u8 from cache`);
      const text = session.m3u8Bodies[url];
      const baseUrl = url.includes("?") ? url.substring(0, url.indexOf("?")) : url;
      const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
      const proxyBase = getBaseUrl(req);
      const lines = text.split("\n");
      const out = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
          out.push(rawLine);
          continue;
        }
        let segUrl = line;
        if (!segUrl.startsWith("http")) segUrl = new URL(segUrl, baseDir).href;
        const segExt = segUrl.includes(".m3u8") ? "m3u8" : "ts";
        out.push(`${proxyBase}/hls/${encodeProxyPayload(sessionId, segUrl)}.${segExt}`);
      }
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.writeHead(200);
      return res.end(out.join("\n"));
    }

    console.log(`[hls] Fetching ${ext}: ${url.substring(0, 60)}...`);
    const { body, contentType } = await fetchWithCookies(url, session.referer, session.cookies);

    if (ext === "m3u8") {
      const text = body.toString("utf8");
      if (!session.m3u8Bodies) session.m3u8Bodies = {};
      session.m3u8Bodies[url] = text;
      const baseUrl = url.includes("?") ? url.substring(0, url.indexOf("?")) : url;
      const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
      const proxyBase = getBaseUrl(req);
      const lines = text.split("\n");
      const out = [];
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
          out.push(rawLine);
          continue;
        }
        let segUrl = line;
        if (!segUrl.startsWith("http")) segUrl = new URL(segUrl, baseDir).href;
        const segExt = segUrl.includes(".m3u8") ? "m3u8" : "ts";
        out.push(`${proxyBase}/hls/${encodeProxyPayload(sessionId, segUrl)}.${segExt}`);
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
  const browser = await puppeteer.launch(PUPPETEER_LAUNCH_OPTIONS);
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

      const m3u8Responses = [];
      page.on("response", async (res) => {
        const u = res.url();
        if (u.includes(".m3u8")) {
          console.log(`[proxy] Found HLS: ${u}`);
          let clean = u.split("?")[0];
          let referer = "https://videostr.net/";
          try {
            const qs = u.indexOf("?") >= 0 ? u.substring(u.indexOf("?") + 1) : "";
            const params = new URLSearchParams(qs);
            const hdr = params.get("headers");
            if (hdr) {
              const o = JSON.parse(decodeURIComponent(hdr));
              if (o.referer) referer = o.referer;
              if (o.origin) referer = o.origin;
            }
          } catch (e) {}
          let body = null;
          try {
            body = await res.text();
          } catch (e) {
            console.log(`[proxy] Could not read m3u8 body: ${e.message}`);
          }
          m3u8Responses.push({ url: clean, referer, body });
        }
      });

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });
      await new Promise((r) => setTimeout(r, 8000));

      if (m3u8Responses.length > 0) {
        const allCookies = await browser.cookies();
        const cookieStr = allCookies.map((c) => `${c.name}=${c.value}`).join("; ");
        for (const m of m3u8Responses) {
          results.push({ ...m, cookies: cookieStr });
        }
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
          const iframeM3u8 = [];
          p2.on("response", async (res) => {
            if (res.url().includes(".m3u8")) {
              let u = res.url();
              let clean = u.split("?")[0];
              let referer = "https://videostr.net/";
              try {
                const qs = u.indexOf("?") >= 0 ? u.substring(u.indexOf("?") + 1) : "";
                const params = new URLSearchParams(qs);
                const hdr = params.get("headers");
                if (hdr) {
                  const o = JSON.parse(decodeURIComponent(hdr));
                  if (o.referer) referer = o.referer;
                  if (o.origin) referer = o.origin;
                }
              } catch (e) {}
              let body = null;
              try {
                body = await res.text();
              } catch (e) {}
              iframeM3u8.push({ url: clean, referer, body });
            }
          });
          await p2.goto(src, { waitUntil: "domcontentloaded", timeout: 20000 });
          await new Promise((r) => setTimeout(r, 6000));
          if (iframeM3u8.length > 0) {
            const allCookies = await browser.cookies();
            const cookieStr = allCookies.map((c) => `${c.name}=${c.value}`).join("; ");
            for (const m of iframeM3u8) {
              results.push({ ...m, cookies: cookieStr });
            }
          }
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
  const streams = [];
  for (const r of results) {
    const sessionId = createSession({
      referer: r.referer,
      cookies: r.cookies,
      m3u8Bodies: r.body ? { [r.url]: r.body } : {},
    });
    console.log(`[proxy] Session ${sessionId} for ${r.url.substring(0, 50)}...`);
    streams.push({
      url: `${baseUrl}/hls/${encodeProxyPayload(sessionId, r.url)}.m3u8`,
      headers: {},
    });
  }
  streams.reverse();
  return streams;
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
