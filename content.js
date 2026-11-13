/* global browser, NexyBlock */
"use strict";

(() => {
  let settings = NexyBlock.normalizeSettings({enabled: false});
  let style = null;
  let scheduled = null;
  let poll = null;
  let observedPlayer = null;
  let pageActive = true;
  let settingsRead = 0;
  const clickedAt = new WeakMap();
  const action = ":is(button, [role='button'])";
  const skipSlot = ":is(.ytp-ad-skip-ad-slot, .ytp-ad-skip-button-slot, .ytp-ad-skip-button-container, .ytp-skip-ad-button-container, .videoAdUiSkipContainer)";
  const slotControls = skipSlot + " " + action;
  const adControls = ":is(.video-ads, .ytp-ad-module, .ytp-ad-player-overlay) " + action;
  const skipControls = [NexyBlock.SKIP_SELECTORS, slotControls, adControls].join(",");
  const skipLabel = /^skip(?: (?:video )?(?:ads?|advertisements?))?$/i;
  const countdown = /\bskip(?:\s+(?:ads?|advertisements?))?\s+(?:in|after)\b|^\s*\d+(?::\d{2})?\s*(?:s|sec(?:onds?)?)?\s*$/i;

  function updateStyle() {
    if (!settings.enabled || !settings.cosmetic) { style?.remove(); return; }
    if (style?.isConnected || !document.documentElement) return;
    if (!style) {
      style = document.createElement("style");
      style.dataset.nexyblock = "cosmetic";
      style.textContent = NexyBlock.COSMETIC_CSS;
    }
    document.documentElement.appendChild(style);
  }

  function isAvailableSkip(button) {
    if (typeof button.click !== "function" || button.disabled ||
        button.closest("a[href], form, [hidden], [inert], [aria-hidden='true'], [aria-disabled='true'], .ytp-ad-preview-container, .ytp-preview-ad") ||
        !button.checkVisibility({opacityProperty: true, visibilityProperty: true}) ||
        !button.getClientRects().length || getComputedStyle(button).pointerEvents === "none") return false;
    const label = (button.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ");
    const text = (button.textContent || "").trim().replace(/\s+/g, " ");
    if (countdown.test(label) || countdown.test(text)) return false;
    return button.matches(NexyBlock.SKIP_SELECTORS) || skipLabel.test(label || text);
  }

  const playerObserver = new MutationObserver(scheduleScan);
  const documentObserver = new MutationObserver(() => {
    if ((settings.cosmetic && !style?.isConnected) ||
        (settings.autoSkip && !observedPlayer?.isConnected)) scheduleScan();
  });

  function watchPlayer(player) {
    if (player === observedPlayer) return;
    playerObserver.disconnect();
    observedPlayer = player;
    if (player) playerObserver.observe(player, {childList: true, subtree: true,
      attributes: true, attributeFilter: ["class", "hidden", "disabled", "inert", "aria-disabled", "aria-hidden", "aria-label"]});
  }

  function scan() {
    if (scheduled !== null) { clearTimeout(scheduled); scheduled = null; }
    if (!pageActive || !settings.enabled) return;
    updateStyle();
    if (!settings.autoSkip) return;
    const player = document.getElementById("movie_player");
    watchPlayer(player);
    if (!player) return;
    // A dedicated, visible Skip Ad slot can appear before the player's ad class.
    // Generic player or ad-module buttons still require the player ad marker.
    const marked = player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting");
    const now = performance.now();
    for (const button of player.querySelectorAll(marked ? skipControls : slotControls)) {
      const previous = clickedAt.get(button);
      if ((previous !== undefined && now - previous < 2000) || !isAvailableSkip(button)) continue;
      clickedAt.set(button, now);
      button.click();
      if (settings.statistics) browser.runtime.sendMessage({type: "recordSkip"}).catch(() => {});
      break;
    }
  }

  function scheduleScan() {
    if (pageActive && settings.enabled && (settings.cosmetic || settings.autoSkip) && scheduled === null) {
      scheduled = setTimeout(() => { scheduled = null; scan(); }, 250);
    }
  }

  function stopWork() {
    documentObserver.disconnect();
    playerObserver.disconnect();
    observedPlayer = null;
    if (poll !== null) clearInterval(poll);
    if (scheduled !== null) clearTimeout(scheduled);
    poll = null;
    scheduled = null;
  }

  function apply(next) {
    settings = NexyBlock.normalizeSettings(next);
    stopWork();
    if (!pageActive) return;
    updateStyle();
    if (!settings.enabled || (!settings.cosmetic && !settings.autoSkip)) return;
    // Page-wide observation is limited to discovering/replacing the player or
    // a removed stylesheet. Attribute observation stays inside the player.
    documentObserver.observe(document, {childList: true, subtree: true});
    if (settings.autoSkip) poll = setInterval(scan, 1000);
    scan();
  }

  function loadSettings() {
    const generation = ++settingsRead;
    browser.storage.local.get("settings").then(value => {
      if (generation === settingsRead) apply(value.settings);
    }).catch(() => {
      if (generation === settingsRead) apply({...NexyBlock.DEFAULT_SETTINGS, enabled: false});
    });
  }

  document.addEventListener("yt-navigate-finish", scheduleScan);
  document.addEventListener("yt-player-updated", scheduleScan);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) { settingsRead++; apply(changes.settings.newValue); }
  });
  window.addEventListener("pagehide", event => {
    if (event.isTrusted === false) return;
    pageActive = false;
    settingsRead++;
    stopWork();
  });
  window.addEventListener("pageshow", event => {
    if (event.isTrusted === false) return;
    pageActive = true;
    loadSettings();
  });
  loadSettings();
})();
