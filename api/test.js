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
      tested_at: new Date().toISOString(),
    });
  }
}
