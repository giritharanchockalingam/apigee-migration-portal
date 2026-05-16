// Live re-test of an Apigee X endpoint, called from the portal dashboard.
// POST { method, path }  →  { status, size, time_ms, controller, action, body }
//
// No auth on the eval Apigee X runtime — same shape as test-all-33.sh.
// Backend (Canvas via ngrok) may be down; that surfaces here as Apigee 502/504
// or a long timeout — which is the honest answer the user wants to see.

export const config = {
  runtime: "nodejs",
  maxDuration: 25,
};

const APIGEE = "https://34.36.245.122.nip.io";

export default async function handler(req, res) {
  // CORS — same-origin in production but keeps local dev open
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const method = (body?.method || "GET").toUpperCase();
  const path   = body?.path || "/";

  if (!path.startsWith("/")) return res.status(400).json({ error: "path must start with /" });

  const url = APIGEE + path;
  const t0  = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const upstream = await fetch(url, {
      method,
      headers: { "Accept": "*/*", "User-Agent": "sei-portal-live-test" },
      redirect: "manual",
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const time_ms = Date.now() - t0;

    const meta = upstream.headers.get("x-canvas-meta") || "";
    const mController = (meta.match(/o=([^;]+)/) || [])[1] || "";
    const mAction     = (meta.match(/n=([^;]+)/) || [])[1] || "";

    // Read at most 64 KB of the body — keep payload tight for the browser
    const reader = upstream.body?.getReader();
    let chunks = [];
    let total = 0;
    const CAP = 64 * 1024;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          if (total + value.length > CAP) {
            chunks.push(value.subarray(0, CAP - total));
            total = CAP;
            try { await reader.cancel(); } catch {}
            break;
          }
          chunks.push(value);
          total += value.length;
        }
      }
    }
    const truncated = total >= CAP;
    const bodyBuf = Buffer.concat(chunks.map(c => Buffer.from(c)));
    const text = bodyBuf.toString("utf8");

    const classification = classify({
      status: upstream.status,
      body: text,
      controller: mController,
      contentType: upstream.headers.get("content-type") || "",
    });

    return res.status(200).json({
      url,
      method,
      status: upstream.status,
      size: bodyBuf.length,
      truncated,
      time_ms,
      controller: mController,
      action: mAction,
      content_type: upstream.headers.get("content-type") || "",
      body: text,
      apigee_meta: meta || null,
      classification,           // { kind, label, color, explanation }
      tested_at: new Date().toISOString(),
    });
  } catch (err) {
    clearTimeout(timeout);
    const time_ms = Date.now() - t0;
    const aborted = err?.name === "AbortError";
    return res.status(200).json({
      url,
      method,
      status: 0,
      size: 0,
      truncated: false,
      time_ms,
      controller: "",
      action: "",
      content_type: "",
      body: "",
      error: aborted ? "timeout after 20s" : (err?.message || String(err)),
      classification: {
        kind: "infra-unreachable",
        label: "infra · Apigee unreachable",
        color: "red",
        explanation: aborted
          ? "The Apigee X eval runtime didn't respond within 20s. Check that the eval org is still running and your IP isn't blocked."
          : "Could not connect to Apigee at all. Either the eval runtime is down or there's a network issue between Vercel and Apigee.",
      },
      tested_at: new Date().toISOString(),
    });
  }
}

// ── Classifier ──────────────────────────────────────────────────────────────
// Goal: when a row goes red, tell the operator what kind of red.
//
//   ok                — 2xx, working as designed
//   stub-ok           — 2xx returned by Apigee itself (Wave 2 stub flow)
//   data-empty        — 2xx empty body or 404 with Canvas controller matched
//   ngrok-dead        — 404 page from ngrok (tunnel rotated / Canvas backend offline)
//   canvas-no-route   — 404 from Canvas Rails for a path that doesn't exist there
//   canvas-error      — 5xx from Canvas
//   apigee-fault      — 4xx/5xx from Apigee policy (raised fault, quota, spike arrest)
//   auth-blocked      — 401/403
//   infra-unreachable — connection failed (set in the catch block above)
function classify({ status, body = "", controller = "", contentType = "" }) {
  const b = (body || "").slice(0, 2000);
  const isHtml = /text\/html/i.test(contentType) || /^\s*<!DOCTYPE\s+html|^\s*<html/i.test(b);

  // 2xx — green family
  if (status >= 200 && status < 300) {
    if (!b || b.trim() === "" || b.trim() === "[]" || b.trim() === "{}") {
      return { kind: "data-empty", label: "data · empty result set", color: "amber",
        explanation: "Canvas returned 2xx but no rows. The proxy is working; there just isn't data for this id." };
    }
    return { kind: "ok", label: "live · ok", color: "green",
      explanation: "Proxy → Canvas → response, end to end. Real backend, real data, real path." };
  }

  // 401/403
  if (status === 401 || status === 403) {
    return { kind: "auth-blocked", label: "auth · blocked", color: "red",
      explanation: "Backend rejected the request. Apigee likely needs an updated token or the Authorization policy isn't injecting credentials." };
  }

  // 5xx
  if (status === 502 || status === 503 || status === 504) {
    return { kind: "ngrok-dead", label: "infra · backend unreachable", color: "red",
      explanation: "Apigee got to the target hostname but the backend wasn't there. Most likely your local Canvas + ngrok stack is offline or the ngrok URL rotated. Run retarget-ngrok.sh with the current URL." };
  }
  if (status >= 500) {
    return { kind: "canvas-error", label: "backend · " + status, color: "red",
      explanation: "Backend returned a 5xx. This is a Canvas-side problem, not Apigee." };
  }

  // 404 — most ambiguous, do the work
  if (status === 404) {
    // ngrok's "Tunnel <X> not found" page
    if (/ngrok|tunnel.*not.*found|err_ngrok/i.test(b) && isHtml) {
      return { kind: "ngrok-dead", label: "infra · ngrok tunnel dead", color: "red",
        explanation: "ngrok returned its own 404 page — the tunnel hostname Apigee is targeting no longer exists. Bring Canvas + ngrok back up, then run retarget.sh with the current ngrok URL. (Better long-term: move Canvas to a stable host so the URL never changes.)" };
    }
    // Canvas Rails action-controller error page (very distinctive)
    if (/Action Controller: Exception caught|ActionController::RoutingError/i.test(b)) {
      return { kind: "canvas-no-route", label: "design · path not in Canvas", color: "amber",
        explanation: "Canvas is up and Apigee reached it, but this URL doesn't exist in Canvas — the Mule API used a non-standard path that maps to a different Canvas endpoint or needs a custom transform. This is real design work, not an infra problem." };
    }
    // Apigee policy raise-fault (JSON with errorcode)
    if (/"errorcode"|"faultstring"/i.test(b)) {
      return { kind: "apigee-fault", label: "apigee · policy fault", color: "red",
        explanation: "An Apigee policy raised a fault (quota, spike-arrest, JS error). The proxy never got to the backend." };
    }
    // Canvas returned 404 but we matched a controller — that's "empty"
    if (controller) {
      return { kind: "data-empty", label: "data · no row for id", color: "amber",
        explanation: "Canvas matched the route, found the controller, but returned 404 because there's no record at this id. Proxy is working." };
    }
    // Default: unknown 404
    return { kind: "unknown-404", label: "404 · cause unclear", color: "amber",
      explanation: "404 with no signature we recognise. Inspect the body — it may be a third-party CDN, a redirect, or an Apigee route miss." };
  }

  // Other 4xx
  if (status >= 400) {
    return { kind: "client-error", label: "client · " + status, color: "amber",
      explanation: "Backend rejected the request as malformed. Check headers, body, or content-type." };
  }

  // Fall-through (e.g. 3xx)
  return { kind: "other", label: "status · " + status, color: "amber",
    explanation: "Non-2xx, non-4xx, non-5xx response." };
}
