/* Original implementation. No uBlock Origin code or filter lists are bundled. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NexyBlock = api;
})(globalThis, function () {
  "use strict";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    network: true,
    metadata: true,
    cosmetic: true,
    autoSkip: true,
    statistics: false
  });
  const AD_KEYS = Object.freeze(["adPlacements", "adSlots", "playerAds"]);
  const AD_DOMAINS = Object.freeze([
    "doubleclick.net", "googlesyndication.com", "googleadservices.com"
  ]);
  const COSMETIC_CSS = `
    ytd-display-ad-renderer,
    ytd-ad-slot-renderer,
    ytd-promoted-video-renderer,
    ytd-promoted-sparkles-web-renderer,
    ytd-in-feed-ad-layout-renderer,
    ytd-action-companion-ad-renderer,
    ytd-companion-slot-renderer,
    ytd-player-legacy-desktop-watch-ads-renderer,
    ytd-rich-item-renderer:has(ytd-ad-slot-renderer),
    ytd-rich-item-renderer:has(ytd-in-feed-ad-layout-renderer) {
      display: none !important;
    }
  `;
  const SKIP_SELECTORS = [
    ".ytp-skip-ad-button", ".ytp-ad-skip-button-modern", ".ytp-ad-skip-button",
    ".ytp-skip-ad-button-modern", ".videoAdUiSkipButton"
  ].join(",");

  function normalizeSettings(input) {
    const result = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(result)) {
      if (input && typeof input[key] === "boolean") result[key] = input[key];
    }
    return result;
  }

  function parseUrl(value) {
    try { return new URL(value); } catch { return null; }
  }

  function isYouTubeUrl(value) {
    const u = parseUrl(value);
    return !!u && u.protocol === "https:" && !u.port && !u.username && !u.password &&
      ["youtube.com", "www.youtube.com", "www.youtube-nocookie.com"].includes(u.hostname);
  }

  function domainMatches(hostname, domain) {
    return hostname === domain || hostname.endsWith("." + domain);
  }

  function hasYouTubeInitiator(details) {
    return [details.documentUrl, details.originUrl,
      ...(details.frameAncestors || []).map(frame => frame.url)].some(isYouTubeUrl);
  }

  function shouldBlockRequest(details, settings) {
    if (!settings.enabled || !settings.network || details.type === "main_frame" ||
        !hasYouTubeInitiator(details)) return false;
    const u = parseUrl(details.url);
    if (!u || u.protocol !== "https:") return false;
    if (AD_DOMAINS.some(domain => domainMatches(u.hostname, domain))) return true;
    return isYouTubeUrl(u.href) &&
      (u.pathname.startsWith("/pagead/") || u.pathname === "/api/stats/ads");
  }

  function responseKind(details) {
    if (details.statusCode !== 200 || !isYouTubeUrl(details.url) || !hasYouTubeInitiator(details)) return null;
    const u = new URL(details.url);
    const mime = (details.responseHeaders || []).find(h =>
      h.name.toLowerCase() === "content-type")?.value?.split(";")[0].trim().toLowerCase();
    if (details.type === "xmlhttprequest" &&
        /^\/youtubei\/v1\/(player|get_watch|navigation\/resolve_url)$/.test(u.pathname) &&
        ["application/json", "text/json", "text/plain"].includes(mime)) return "json";
    return null;
  }

  // Only the player envelope and known envelope wrappers are touched. In particular,
  // streamingData, captions, tracking parameters and playabilityStatus stay intact.
  function pruneEnvelope(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 4) return 0;
    if (Array.isArray(value)) {
      return value.reduce((sum, item) => sum + pruneEnvelope(item, depth + 1), 0);
    }
    let removed = 0;
    for (const key of AD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        delete value[key];
        removed++;
      }
    }
    if (Object.prototype.hasOwnProperty.call(value, "playerResponse")) {
      removed += pruneEnvelope(value.playerResponse, depth + 1);
    }
    const prefetched = value.endpoint?.watchEndpoint?.unserializedPrefetchData?.playerResponse;
    if (prefetched) removed += pruneEnvelope(prefetched, depth + 1);
    return removed;
  }

  // Plain integers of at most 15 digits (except -0) survive ordinary serialization.
  const MAY_NEED_NUMBER_SOURCE = /\d{16}|\.\d|[eE][+-]?\d|-0/;

  function preserveNumber(_key, value, context) {
    if (typeof value !== "number") return value;
    // Only use numeric source returned by the JSON parser. Page strings must
    // never become raw JSON. A missing source fails open in transformPlayerJson.
    const literal = context.source;
    return String(value) === literal ? value : JSON.rawJSON(literal);
  }

  // Developer runtimes without rawJSON keep the original bytes whenever
  // they cannot spell a numeric token exactly.
  function numbersSurviveRewrite(body) {
    const tokens = /"(?:\\.|[^"\\])*"|-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
    for (const [literal] of body.matchAll(tokens)) {
      if (literal[0] !== '"' && JSON.stringify(Number(literal)) !== literal) return false;
    }
    return true;
  }

  function transformPlayerJson(text) {
    if (!AD_KEYS.some(key => text.includes('"' + key + '"'))) return {text, removed: 0};
    let prefix = "";
    let body = text;
    if (body.charCodeAt(0) === 0xFEFF) { prefix = body[0]; body = body.slice(1); }
    if (body.startsWith(")]}'")) {
      const newline = body.indexOf("\n");
      if (newline < 0) return { text, removed: 0 };
      prefix += body.slice(0, newline + 1);
      body = body.slice(newline + 1);
    }
    try {
      const needsSource = MAY_NEED_NUMBER_SOURCE.test(body);
      const useSource = needsSource && typeof JSON.rawJSON === "function";
      const value = JSON.parse(body, useSource ? preserveNumber : undefined);
      const removed = pruneEnvelope(value);
      if (!removed || (needsSource && !useSource && !numbersSurviveRewrite(body))) {
        return {text, removed: 0};
      }
      return {text: prefix + JSON.stringify(value), removed};
    } catch { return { text, removed: 0 }; }
  }

  return Object.freeze({ DEFAULT_SETTINGS, AD_DOMAINS, COSMETIC_CSS, SKIP_SELECTORS,
    normalizeSettings, isYouTubeUrl, domainMatches, hasYouTubeInitiator,
    shouldBlockRequest, responseKind, transformPlayerJson });
});
