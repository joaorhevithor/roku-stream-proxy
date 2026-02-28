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

const sessionCache = new Map();
const SESSION_TTL = 15 * 60 * 1000;

function createSession(data) {
  const id = crypto.randomBytes(8).toString("hex");
  sessionCache.set(id, { ...data, createdAt: Date.now() });
  for (const [k, v] of sessionCache) {
    if (Date.now() - v.createdAt > SESSION_TTL) {
      if (v.browser) v.browser.close().catch(() => {});
      sessionCache.delete(k);
    }
  }
  return id;
}

function parseM3u8Params(fullUrl) {
  let clean = fullUrl.split("?")[0];
  let referer = "https://videostr.net/";
  try {
    const qs = fullUrl.indexOf("?") >= 0 ? fullUrl.substring(fullUrl.indexOf("?") + 1) : "";
    const params = new URLSearchParams(qs);
    const hdr = params.get("headers");
    if (hdr) {
      const o = JSON.parse(decodeURIComponent(hdr));
      if (o.referer) referer = o.referer;
      if (o.origin) referer = o.origin;
    }
  } catch (e) {}
  return { clean, referer };
}

function getVariantM3u8Urls(m3u8Body, baseUrl) {
  if (!m3u8Body || !baseUrl) return [];
  const baseDir = baseUrl.replace(/\?.*$/, "").replace(/\/[^/]*$/, "/");
  const urls = [];
  const lines = m3u8Body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      let path = uriMatch ? uriMatch[1] : (lines[i + 1] && lines[i + 1].trim());
      if (path && path.endsWith(".m3u8") && !path.startsWith("#")) {
        const full = path.startsWith("http") ? path : new URL(path, baseDir).href;
        urls.push(full);
      }
    }
  }
  return urls;
}

async function fetchUrlInPage(page, url) {
  return page.evaluate(async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  }, url);
}

async function getAllCookies(page) {
  try {
    const client = await page.target().createCDPSession();
    const { cookies } = await client.send("Network.getAllCookies");
    await client.detach();
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (e) {
    console.log(`[proxy] CDP cookie error: ${e.message}`);
    try {
      const cookies = await page.cookies();
      return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch (e2) {
      return "";
    }
  }
}

function fetchWithCookies(url, referer, cookies) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : require("http");
    const pathDecoded = decodeURIComponent(u.pathname) + (u.search || "");
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: pathDecoded,
      method: "GET",
      headers: {
        Referer: referer || u.origin + "/",
        Origin: (referer || u.origin + "/").replace(/\/$/, ""),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Ch-Ua": '"Chromium";v="120", "Not_A Brand";v="8"',
        "Sec-Ch-Ua-Mobile": "?0",
        "Sec-Ch-Ua-Platform": '"Windows"',
      },
    };
    if (cookies) options.headers.Cookie = cookies;
    const req = lib.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).href;
        return fetchWithCookies(next, referer, cookies).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
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

async function fetchViaBrowser(browser, url, referer) {
  const page = await browser.newPage();
  try {
    const ref = (referer || new URL(url).origin + "/").replace(/\/?$/, "/");
    await page.setExtraHTTPHeaders({
      Referer: ref,
      Origin: ref.replace(/\/$/, ""),
    });
    const res = await page.goto(url, { waitUntil: "load", timeout: 20000 });
    if (!res || res.status() !== 200) {
      throw new Error(res ? `HTTP ${res.status()}` : "No response");
    }
    const body = await res.buffer();
    const contentType = res.headers()["content-type"] || "";
    return { body, contentType };
  } finally {
    await page.close().catch(() => {});
  }
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
    return { sessionId: payload.substring(0, idx), url: payload.substring(idx + 1) };
  } catch (e) {
    return null;
  }
}

function rewriteM3u8(text, baseUrl, proxyBase, sessionId) {
  const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf("/") + 1);
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
  return out.join("\n");
}

async function handleHlsProxy(req, res, pathname) {
  const match = pathname.match(/^\/hls\/([A-Za-z0-9_-]+)(\.(m3u8|ts))?$/);
  if (!match) { res.writeHead(404); return res.end(); }

  const encoded = match[1];
  const ext = match[3] || "m3u8";
  const decoded = decodeProxyPayload(encoded);
  if (!decoded) { res.writeHead(400); return res.end("Invalid"); }

  const { sessionId, url } = decoded;
  const session = sessionCache.get(sessionId);
  if (!session) {
    console.log(`[hls] Session ${sessionId} expired`);
    res.writeHead(410);
    return res.end("Session expired");
  }

  const proxyBase = getBaseUrl(req);

  try {
    // m3u8 from cache (try exact url and normalized path)
    const cachedBody = session.m3u8Bodies && (session.m3u8Bodies[url] || session.m3u8Bodies[url.replace(/%2F/g, "/")]);
    if (ext === "m3u8" && cachedBody) {
      console.log(`[hls] Serving m3u8 from cache for ${url.substring(0, 50)}...`);
      const baseUrl = url.includes("?") ? url.substring(0, url.indexOf("?")) : url;
      const rewritten = rewriteM3u8(cachedBody, baseUrl, proxyBase, sessionId);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.writeHead(200);
      return res.end(rewritten);
    }

    // Try Node.js HTTP with cookies first
    console.log(`[hls] Fetching ${ext}: ${url.substring(0, 60)}...`);
    let body, contentType;
    try {
      const r = await fetchWithCookies(url, session.referer, session.cookies);
      body = r.body;
      contentType = r.contentType;
      console.log(`[hls] OK via HTTP, ${body.length} bytes`);
    } catch (httpErr) {
      console.log(`[hls] HTTP failed (${httpErr.message}), trying browser...`);
      if (session.browser && session.browser.connected) {
        const r = await fetchViaBrowser(session.browser, url, session.referer);
        body = r.body;
        contentType = r.contentType;
        console.log(`[hls] OK via browser, ${body.length} bytes`);
      } else {
        throw httpErr;
      }
    }

    if (ext === "m3u8") {
      const text = body.toString("utf8");
      if (!session.m3u8Bodies) session.m3u8Bodies = {};
      session.m3u8Bodies[url] = text;
      const baseUrl = url.includes("?") ? url.substring(0, url.indexOf("?")) : url;
      const rewritten = rewriteM3u8(text, baseUrl, proxyBase, sessionId);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.writeHead(200);
      return res.end(rewritten);
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
  const browser = await puppeteer.launch(PUPPETEER_LAUNCH_OPTIONS);
  const m3u8Found = [];
  const bodyPromises = [];
  let foundResolve;
  const foundPromise = new Promise((r) => { foundResolve = r; });

  function onM3u8(res) {
    const u = res.url();
    if (!u.includes(".m3u8")) return;
    console.log(`[proxy] Found HLS: ${u}`);
    const { clean, referer } = parseM3u8Params(u);
    const idx = m3u8Found.length;
    m3u8Found.push({ url: clean, referer, body: null });
    bodyPromises.push(
      res.buffer().then((b) => { m3u8Found[idx].body = b.toString("utf8"); }).catch((e) => { console.log(`[proxy] Body read failed: ${e.message}`); })
    );
    foundResolve();
  }

  for (const buildUrl of SOURCES) {
    const url = buildUrl(tmdbId);
    console.log(`[proxy] Trying: ${url}`);
    let page;
    try {
      page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (req) => {
        const t = req.resourceType();
        if (["image", "stylesheet", "font"].includes(t)) req.abort();
        else req.continue();
      });
      page.on("response", onM3u8);

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 });

      // Wait up to 20s for first m3u8, checking every 500ms
      await Promise.race([foundPromise, new Promise((r) => setTimeout(r, 20000))]);

      if (m3u8Found.length > 0) {
        // Wait 4s more for additional m3u8 responses (different resolutions)
        await new Promise((r) => setTimeout(r, 4000));
        console.log(`[proxy] Found ${m3u8Found.length} m3u8 streams`);

        // Get ALL cookies via CDP
        const cookieStr = await getAllCookies(page);
        console.log(`[proxy] Cookies: ${cookieStr.length} chars`);

        for (const m of m3u8Found) {
          console.log(`[proxy] Stream: ${m.url.substring(0, 50)}... body=${m.body ? m.body.length : "null"}`);
        }

        // Pre-fetch variant m3u8 (e.g. 1080p) in same page context so we have it in cache
        for (const m of m3u8Found) {
          if (!m.body) continue;
          const baseUrl = m.url.replace(/\?.*$/, "");
          const variants = getVariantM3u8Urls(m.body, baseUrl);
          for (const variantUrl of variants) {
            try {
              console.log(`[proxy] Pre-fetching variant: ${variantUrl.substring(0, 60)}...`);
              const body = await fetchUrlInPage(page, variantUrl);
              m.variantBodies = m.variantBodies || {};
              m.variantBodies[variantUrl] = body;
              m.variantBodies[variantUrl.replace(/%2F/g, "/")] = body;
              console.log(`[proxy] Cached variant, ${body.length} chars`);
            } catch (e) {
              console.log(`[proxy] Variant fetch failed: ${e.message}`);
            }
          }
        }

        // Don't close page - keep browser alive for .ts fetching
        break;
      }

      // No m3u8 found on main page, try iframes
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
            if (["image", "stylesheet", "font"].includes(t)) req.abort();
            else req.continue();
          });
          p2.on("response", onM3u8);
          await p2.goto(src, { waitUntil: "domcontentloaded", timeout: 20000 });
          await Promise.race([foundPromise, new Promise((r) => setTimeout(r, 15000))]);
          if (m3u8Found.length > 0) {
            await new Promise((r) => setTimeout(r, 4000));
            break;
          }
        } catch (e) {}
        await p2.close();
      }

      if (m3u8Found.length > 0) break;
    } catch (e) {
      console.log(`[proxy] Error: ${e.message}`);
      if (page) try { await page.close(); } catch (e2) {}
    }
  }

  if (m3u8Found.length === 0) {
    await browser.close();
    return [];
  }

  // Wait for ALL m3u8 body reads (main page + iframe)
  await Promise.allSettled(bodyPromises);
  await new Promise((r) => setTimeout(r, 500));

  // Get cookies from last active page
  const pages = await browser.pages();
  const lastPage = pages[pages.length - 1];
  const cookieStr = await getAllCookies(lastPage);
  console.log(`[proxy] Final cookies: ${cookieStr.length} chars`);

  const baseUrl = global.__hlsBaseUrl || "https://roku-stream-proxy.onrender.com";
  const streams = [];
  for (const r of m3u8Found) {
    const m3u8Bodies = {};
    if (r.body) m3u8Bodies[r.url] = r.body;
    if (r.variantBodies) Object.assign(m3u8Bodies, r.variantBodies);
    const sessionId = createSession({
      referer: r.referer,
      cookies: cookieStr,
      browser: browser,
      m3u8Bodies,
    });
    console.log(`[proxy] Session ${sessionId} created`);
    streams.push({
      url: `${baseUrl}/hls/${encodeProxyPayload(sessionId, r.url)}.m3u8`,
      headers: {},
    });
  }

  // Close browser after 10 minutes
  setTimeout(() => {
    if (browser.connected) {
      console.log(`[proxy] Closing idle browser`);
      browser.close().catch(() => {});
    }
  }, 10 * 60 * 1000);

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
