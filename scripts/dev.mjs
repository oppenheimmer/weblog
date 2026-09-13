// One local command for the site and the editor (CLAUDE.md Step 2).
//
//   npm run dev                                     # reads .env when there is one
//   node --env-file-if-exists=.env scripts/dev.mjs [--port 3000] [--memory] [--allow-prod]
//
// Serves dist/ the way vercel.json asks the platform to — rewrites, header
// rules, trailing slashes and clean URLs, read through lib/routing.mjs — and
// answers the editor, login and /api/ with the real function handlers. Where
// production would fire the deploy hook (publish, unpublish, rollback, Rebuild
// site), this rebuilds in-process instead, into a temporary directory swapped
// in when it succeeds, so the site and "On the site" follow along locally.
//
// Storage is R2 when the environment configures it, under R2_PREFIX ("dev"
// unless set, and "prod" refused without --allow-prod), or an in-memory bucket
// that forgets everything on exit: with --memory, or when no credentials are
// set. In memory, uploads and previews go to this server rather than storage.
// ADMIN_PASSWORD_HASH is used when set; otherwise a password is made up and
// printed. The deploy hook is never called.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildAndReport } from "../build.mjs";
import { hasR2Config, readR2Config } from "../lib/server/config.mjs";
import { createStore } from "../lib/server/r2.mjs";
import { createSessionStore } from "../lib/server/sessions.mjs";
import { createRateLimiter } from "../lib/server/rate-limit.mjs";
import { hashPassword } from "../lib/server/passwords.mjs";
import { setContext } from "../lib/server/http.mjs";
import { readRouting, headersFor, fileFor } from "../lib/routing.mjs";
import { createFakeS3, FAKE_CONFIG } from "../test/helpers/fake-r2.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".ico": "image/x-icon",
};

/** A vercel.json rewrite as a function from a path to its destination, or null. */
function compileRewrite({ source, destination }) {
  const names = [];
  const pattern = source.split("/").map((segment) => {
    const param = /^:([A-Za-z]\w*)(\*)?$/.exec(segment);
    if (!param) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    names.push(param[1]);
    return param[2] ? "(.*)" : "([^/]+)";
  }).join("/");
  const regex = new RegExp(`^${pattern}$`);
  return (pathname) => {
    const match = regex.exec(pathname);
    if (!match) return null;
    const values = Object.fromEntries(names.map((name, i) => [name, match[i + 1]]));
    const target = new URL(destination.replace(/:([A-Za-z]\w*)\*?/g, (_, name) => values[name] ?? ""), "http://local");
    return { pathname: target.pathname, query: Object.fromEntries(target.searchParams) };
  };
}

/**
 * The api/ file answering a path, as Vercel maps them: `name.js`, then
 * `name/index.js`, then a `[param]` file or directory, whose value lands in
 * the query as it does on the platform.
 */
function findFunction(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "api" || segments.some((segment) => segment.startsWith("."))) return null;
  let dir = ROOT;
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const entries = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
    const dynamic = entries.find((entry) => /^\[[A-Za-z]\w*\](\.js)?$/.test(entry.name));
    const paramName = dynamic?.name.replace(/^\[|\](\.js)?$/g, "");
    if (i === segments.length - 1) {
      for (const file of [`${segment}.js`, path.join(segment, "index.js")]) {
        if (fs.existsSync(path.join(dir, file))) return { file: path.join(dir, file), params };
      }
      if (!dynamic) return null;
      const file = dynamic.isDirectory() ? path.join(dynamic.name, "index.js") : dynamic.name;
      if (!fs.existsSync(path.join(dir, file))) return null;
      return { file: path.join(dir, file), params: { ...params, [paramName]: segment } };
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name === segment)) {
      dir = path.join(dir, segment);
    } else if (dynamic?.isDirectory()) {
      params[paramName] = segment;
      dir = path.join(dir, dynamic.name);
    } else {
      return null;
    }
  }
  return null;
}

const toKey = (text) => Buffer.from(text).toString("base64url");
const fromKey = (text) => Buffer.from(text, "base64url").toString("utf8");

export async function startDevServer({
  port = 3000,
  memory = !hasR2Config(),
  allowProd = false,
  password = process.env.WEBLOG_DEV_PASSWORD,
  distDir = path.join(ROOT, "dist"),
  log = (line) => console.log(line),
} = {}) {
  if (!memory && readR2Config().prefix === "prod" && !allowProd) {
    throw new Error('R2_PREFIX is "prod": this would edit and publish the live site\'s data. ' +
      "Use another prefix, --memory, or --allow-prod if that is what you mean.");
  }

  const store = memory
    ? createStore({ config: { ...FAKE_CONFIG, prefix: "dev" }, client: createFakeS3() })
    : createStore();

  // A password only when there is none to use: a made-up one is printed once.
  let madeUpPassword = null;
  if (password || !process.env.ADMIN_PASSWORD_HASH) {
    madeUpPassword = password ? null : crypto.randomBytes(12).toString("base64url");
    process.env.ADMIN_PASSWORD_HASH = await hashPassword(password ?? madeUpPassword, { N: 2 ** 14 });
  }
  const secret = process.env.RATE_LIMIT_HASH_SECRET || crypto.randomBytes(24).toString("hex");
  process.env.RATE_LIMIT_HASH_SECRET = secret;

  // ---- builds, one at a time, each swapped in whole ------------------------------
  let running = null;
  let again = false;
  let lastBuild = null;
  const rebuild = () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        const next = `${distDir}.building`;
        const result = await buildAndReport({ store, distDir: next });
        if (result.ok) {
          fs.rmSync(distDir, { recursive: true, force: true });
          fs.renameSync(next, distDir);
        } else {
          fs.rmSync(next, { recursive: true, force: true });
          log(`build failed (${result.kind}): ${result.reason}`);
        }
        lastBuild = result;
      } while (again);
    })().finally(() => { running = null; });
    return running;
  };

  let site = null;
  setContext({
    store,
    sessions: createSessionStore(store, { authVersion: Number(process.env.AUTH_VERSION ?? 1) }),
    limiter: createRateLimiter(store, { secret }),
    runSecret: secret,
    fireDeployHook: async () => {
      rebuild();
      return { job: "local-build" };
    },
    log: (line) => {
      try {
        const record = JSON.parse(line);
        log(`${record.method} ${record.path} ${record.status} ${record.ms} ms${record.code ? ` ${record.code}` : ""}`);
      } catch {
        log(line);
      }
    },
    // Root-relative, so they belong to whichever address the editor was opened
    // at. Absolute 127.0.0.1 links in a preview opened at localhost were refused
    // by the editor's img-src 'self', so no image showed (measured in Chromium).
    ...(memory ? {
      signPut: async (key) => `/local-upload/${toKey(key)}`,
      signGet: async (key) => `/local-download/${toKey(key)}`,
    } : {}),
  });

  // ---- the server ---------------------------------------------------------------
  const routing = readRouting(JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")));
  const rewrites = routing.rewrites.map(compileRewrite);
  const handlers = new Map();

  async function serveFunction(req, res, url, found, extraQuery = {}) {
    if (!handlers.has(found.file)) handlers.set(found.file, (await import(pathToFileURL(found.file).href)).default);
    req.query = { ...Object.fromEntries(url.searchParams), ...extraQuery, ...found.params };
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    return handlers.get(found.file)(req, res);
  }

  function serveStatic(req, res, url) {
    const send = (status, file, pathname) => {
      // What Vercel sends with every static file (measured on production,
      // 2026-09-13). Without it the preview frame, which has no origin of its
      // own, was refused KaTeX's fonts, so maths lost its glyphs locally only.
      res.setHeader("access-control-allow-origin", "*");
      for (const [key, value] of headersFor(routing, pathname)) res.setHeader(key, value);
      res.writeHead(status, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : fs.readFileSync(file));
    };
    const rel = fileFor(routing, url.pathname);
    const file = rel && path.resolve(distDir, rel);
    if (file && file.startsWith(distDir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(200, file, url.pathname);
    }
    const notFound = path.join(distDir, "404.html");
    if (fs.existsSync(notFound)) return send(404, notFound, url.pathname);
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return res.end("Not found (the site is still building)");
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://local");
      decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    try {
      if (memory && url.pathname.startsWith("/local-upload/") && req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        await store.put(fromKey(url.pathname.slice("/local-upload/".length)), Buffer.concat(chunks),
          { contentType: req.headers["content-type"] });
        res.writeHead(200);
        return res.end();
      }
      if (memory && url.pathname.startsWith("/local-download/") && req.method === "GET") {
        const object = await store.get(fromKey(url.pathname.slice("/local-download/".length)));
        if (!object) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { "content-type": object.contentType ?? "application/octet-stream", "cache-control": "no-store" });
        return res.end(object.body);
      }

      // trailingSlash, then cleanUrls, as the platform redirects them.
      const last = url.pathname.split("/").pop();
      if (routing.trailingSlash && !url.pathname.endsWith("/") && !last.includes(".")) {
        res.writeHead(308, { location: `${url.pathname}/${url.search}` });
        return res.end();
      }
      if (routing.cleanUrls && url.pathname.endsWith(".html") && !url.pathname.startsWith("/api/")) {
        res.writeHead(308, { location: `${url.pathname.replace(/(?:index)?\.html$/, "").replace(/\/?$/, "/")}${url.search}` });
        return res.end();
      }

      for (const rewrite of rewrites) {
        const target = rewrite(url.pathname) ?? rewrite(url.pathname.replace(/\/$/, ""));
        if (!target) continue;
        const found = findFunction(target.pathname);
        if (found) return await serveFunction(req, res, url, found, target.query);
      }
      if (url.pathname.startsWith("/api/")) {
        const found = findFunction(url.pathname);
        if (found) return await serveFunction(req, res, url, found);
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ code: "not_found", message: "No such function." }));
      }
      return serveStatic(req, res, url);
    } catch (err) {
      log(`${req.method} ${url.pathname} failed: ${err.stack ?? err.message}`);
      if (!res.headersSent) res.writeHead(500);
      return res.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  // The address the server actually listens on. `localhost` is not guaranteed
  // to resolve: in a headless Chromium it failed with ERR_NAME_NOT_RESOLVED
  // while this server was up, so it is only accepted as a second origin for a
  // browser where it does resolve.
  site = `http://127.0.0.1:${server.address().port}`;
  // The origin allowlist, canonical URLs and the "On the site" check all read it.
  process.env.SITE_URL = site;
  process.env.EDITOR_ORIGIN = `http://localhost:${server.address().port}`;
  await rebuild();

  return {
    url: site,
    memory,
    password: madeUpPassword,
    store,
    rebuild,
    lastBuild: () => lastBuild,
    idle: async () => { while (running) await running; },
    async close() {
      while (running) await running;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  const portAt = args.indexOf("--port");
  let dev;
  try {
    dev = await startDevServer({
      port: portAt >= 0 ? Number(args[portAt + 1]) : Number(process.env.PORT) || 3000,
      memory: args.includes("--memory") || !hasR2Config(),
      allowProd: args.includes("--allow-prod"),
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const where = dev.memory
    ? "an in-memory bucket (nothing persists)"
    : `R2 bucket ${readR2Config().bucket}, prefix "${readR2Config().prefix}"`;
  console.log(`\nweblog dev — ${dev.url}/  ·  editor ${dev.url}/editor/`);
  console.log(`storage: ${where}`);
  if (dev.password) console.log(`password: ${dev.password}`);
  if (!dev.memory) {
    console.log(`uploads go straight to R2, so its CORS rule must allow ${dev.url}`);
  }
  console.log("Ctrl-C to stop. Restart after changing engine code.\n");
  process.on("SIGINT", async () => {
    await dev.close();
    process.exit(0);
  });
}
