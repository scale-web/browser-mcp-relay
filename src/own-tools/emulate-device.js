// emulate_device — applies CDP Emulation overrides to the active page.
// User-agent, viewport, device scale factor, mobile/touch flags, network throttle.
//
// V0-3: CDP `Emulation.*` overrides are session-scoped — they revert when
// the CDP session detaches. The previous implementation called `cdp.detach()`
// in a finally block immediately after `setUserAgentOverride` etc., so the
// overrides reverted ~milliseconds after the tool returned (silently doing
// nothing). Fix: keep the CDP session alive for the lifetime of the page,
// keyed in a per-page WeakMap so callers don't accidentally double-attach.
// Auto-cleanup on page close.

const { getOrCreatePageCdp } = require("./_page-cdp-session.js");
const { withActivePage } = require("./_active-page.js");

/**
 * T2-A (v0.3.5): synthesize a CDP userAgentMetadata struct from a UA string.
 *
 * CDP's `Network.setUserAgentOverride` accepts a `userAgentMetadata` arg
 * that chromium uses to set HTTP-side `Sec-CH-UA-*` headers. If we override
 * the UA but don't pass userAgentMetadata, chromium falls back to its
 * INTERNAL UA config — producing Sec-CH-UA-* headers that disagree with
 * the override UA we just set. Anti-bot vendors use that mismatch as a
 * detection signal.
 *
 * This paired with stealth_apply's T1-A patch, which synthesized the JS-side
 * `navigator.userAgentData` from the SAME string. stealth_apply was deleted
 * 2026-10-30 (spec v8 §5.3, D3); only this HTTP-header half remains.
 *
 * Pure helper — exported as a test seam.
 *
 * @param {string} ua — the UA string the caller is overriding to
 * @returns {object} userAgentMetadata in CDP's expected shape
 */
function synthesizeUserAgentMetadata(ua) {
  const cm = ua.match(/Chrome\/(\d+)/);
  const version = cm ? cm[1] : "127";
  // CDP's userAgentMetadata.platform names: see the chromium source — they're
  // human-readable strings matching what real Chrome/Brave reports.
  // Order matters: Android UAs contain "Linux; Android..." so Android
  // must be checked BEFORE Linux. iPhone/iPad before macOS for the same
  // reason (the iOS UA contains "Mac OS X" in the version string).
  const platform = /Windows/.test(ua) ? "Windows"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Macintosh/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Windows";
  const mobile = /Mobi|Android|iPhone/.test(ua);
  const platformVersion = /Windows NT 10/.test(ua) ? "15.0.0"
    : /Mac OS X (\d+)[._](\d+)/.test(ua) ? RegExp.$1 + "." + RegExp.$2 + ".0"
    : "15.0.0";
  const architecture = /Win64|x86_64|x64/.test(ua) ? "x86" : "arm";
  const bitness = /Win64|x86_64|x64|arm64/.test(ua) ? "64" : "32";
  // The "Not?A_Brand" is the canonical Greasy-spec randomization slot real
  // Chrome ships — including it makes the brands list look genuine.
  const brands = [
    { brand: "Chromium", version },
    { brand: "Not?A_Brand", version: "24" },
  ];
  const fullVersionList = brands.map((b) => ({
    brand: b.brand,
    version: `${b.version}.0.0.0`,
  }));
  return {
    brands,
    fullVersionList,
    platform,
    platformVersion,
    architecture,
    model: "",
    mobile,
    bitness,
    wow64: false,
  };
}

module.exports = {
  name: "emulate_device",
  description:
    "Apply device emulation to the active page via CDP Emulation. " +
    "Useful for testing mobile layouts, slow networks, or specific user-agent behavior. " +
    "Persists until the page navigates or the page is closed.",
  inputSchema: {
    type: "object",
    properties: {
      userAgent: { type: "string", description: "User-Agent header override" },
      viewport: {
        type: "object",
        properties: {
          width: { type: "integer", minimum: 100, maximum: 4096 },
          height: { type: "integer", minimum: 100, maximum: 4096 },
          deviceScaleFactor: { type: "number", default: 1 },
          mobile: { type: "boolean", default: false },
          hasTouch: { type: "boolean", default: false },
        },
        required: ["width", "height"],
      },
      network: {
        type: "object",
        description: "Network conditions (offline / throttled). All fields optional.",
        properties: {
          offline: { type: "boolean", default: false },
          downloadKbps: { type: "integer", description: "Download throughput in kbps; -1 = no throttle" },
          uploadKbps: { type: "integer", description: "Upload throughput in kbps; -1 = no throttle" },
          latencyMs: { type: "integer", description: "Round-trip latency in ms" },
        },
      },
    },
  },
  handler: async ({ userAgent, viewport, network }) => withActivePage(async ({ bridge, page }) => {
    // T1-9: validate viewport.{width, height} when a viewport block is provided.
    // The schema declares them required, but JSON-RPC + the MCP SDK don't
    // enforce nested-required. CDP throws an opaque ParameterError on
    // missing dimensions; this guard surfaces the issue at handler entry.
    if (viewport && (typeof viewport !== "object" || viewport.width == null || viewport.height == null)) {
      return {
        content: [{ type: "text", text: "emulate_device: viewport requires both width and height (got " + JSON.stringify(viewport) + ")" }],
        isError: true,
      };
    }

    // V0-3: do NOT detach after applying — Emulation overrides revert on
    // detach. The session stays alive for the page's lifetime.
    const cdp = await getOrCreatePageCdp(page, bridge.context);
    const applied = {};

    // T1-2: build the list of CDP commands and dispatch in parallel.
    // Each Emulation.* / Network.* override is independent, so parallel
    // dispatch saves ~30-80ms vs the previous sequential round-trips.
    //
    // Reviewer V1 (2026-05-09): use Promise.allSettled so a partial failure
    // (e.g. CDP rejects setDeviceMetricsOverride mid-flight) returns a
    // structured per-command result instead of short-circuiting and leaving
    // the page in a half-applied state with no diagnostics.
    const sends = [];
    if (userAgent) {
      // T2-A (v0.3.5): also pass userAgentMetadata so the HTTP-side
      // Sec-CH-UA-* headers align with the JS-side navigator.userAgentData
      // (which stealth_apply T1-A synthesized until its deletion on
      // 2026-10-30 — spec v8 D3). Without this, sites that read
      // the headers see Brave's defaults while JS-side reports the override
      // — instant mismatch flag. CDP's setUserAgentOverride accepts a
      // userAgentMetadata arg with the full UA decomposition; we synthesize
      // it from the override UA the same way T1-A does at the JS layer.
      const uaMetadata = synthesizeUserAgentMetadata(userAgent);
      sends.push({
        name: "userAgent",
        p: cdp.send("Network.setUserAgentOverride", {
          userAgent,
          userAgentMetadata: uaMetadata,
        }),
      });
      applied.userAgent = userAgent;
      applied.userAgentMetadata = uaMetadata;
    }
    if (viewport) {
      sends.push({
        name: "viewport",
        p: cdp.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
          mobile: !!viewport.mobile,
        }),
      });
      // T1-8: always send setTouchEmulationEnabled with the requested state.
      // Previously it was only sent when hasTouch was truthy — calling
      // emulate_device twice (once with hasTouch:true, once with false)
      // would leave touch enabled because the second call never sent the
      // "disable" command. Always sending makes the touch state idempotent.
      sends.push({
        name: "touch",
        p: cdp.send("Emulation.setTouchEmulationEnabled", { enabled: !!viewport.hasTouch }),
      });
      applied.viewport = viewport;
    }
    if (network) {
      // F0-9 (2026-05-10): coerce numeric fields with Number.isFinite guard.
      // Pre-fix, NaN/Infinity from the wire would silently propagate to CDP
      // which rejects with an opaque error.
      const finiteOrSentinel = (v) => Number.isFinite(v) ? v : -1;
      sends.push({
        name: "network",
        p: cdp.send("Network.emulateNetworkConditions", {
          offline: !!network.offline,
          downloadThroughput: network.downloadKbps != null ? (finiteOrSentinel(Number(network.downloadKbps)) * 1024 / 8) : -1,
          uploadThroughput: network.uploadKbps != null ? (finiteOrSentinel(Number(network.uploadKbps)) * 1024 / 8) : -1,
          latency: Number.isFinite(network.latencyMs) ? network.latencyMs : 0,
        }),
      });
      applied.network = network;
    }
    const results = await Promise.allSettled(sends.map((s) => s.p));
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        failed.push({ name: sends[i].name, error: r.reason && (r.reason.message || String(r.reason)) });
      }
    });
    const result = {
      content: [{
        type: "text",
        text: JSON.stringify({ applied, failed: failed.length ? failed : undefined }, null, 2),
      }],
    };
    if (failed.length) result.isError = true;
    return result;
  }),
  // T2-A: exported as a test seam.
  synthesizeUserAgentMetadata,
};
