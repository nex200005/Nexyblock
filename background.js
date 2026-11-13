/* global browser, NexyBlock, NexyStream */
"use strict";

(() => {
  let settings = NexyBlock.normalizeSettings({enabled: false});
  let stats = null;
  // Diagnostics are explicit, RAM-only sessions. Stream callbacks retain only
  // an opaque epoch, never the counter object; opt-out drops all its totals.
  let diagnostics = null;
  let diagnosticEpoch = null;
  const DIAGNOSTIC_REASONS = Object.freeze({timeout: "timeouts", "size-limit": "sizeBypasses",
    "stream-error": "streamErrors", compatibility: "manualBypasses", paused: "pauseBypasses",
    "tab-closed": "tabCloseBypasses"});
  const activeFilters = new Set();
  // Manual compatibility choices only. Normal requests create no tab state.
  // Retain numeric tab IDs in RAM, never URLs or response contents.
  const compatibleTabs = new Set();
  let loaded = false;
  let settingsWrites = Promise.resolve();

  function syncStatistics() {
    if (!settings.statistics) stats = null;
    else if (!stats) stats = {requestsBlocked: 0, responsesCleaned: 0,
      fieldsRemoved: 0, skipClicks: 0, responsesBypassed: 0};
  }

  function record(key, amount = 1) {
    if (settings.statistics && stats) stats[key] += amount;
  }

  function freshDiagnostics() {
    diagnosticEpoch = {};
    diagnostics = {streamsStarted: 0, streamsFinished: 0, timeouts: 0, sizeBypasses: 0,
      streamErrors: 0, attachErrors: 0, capacityBypasses: 0, manualBypasses: 0,
      pauseBypasses: 0, tabCloseBypasses: 0};
  }

  function diagnose(key, epoch = diagnosticEpoch) {
    // A collector failure must never affect filtering or its cleanup.
    try {
      if (diagnostics && epoch === diagnosticEpoch && Object.hasOwn(diagnostics, key)) {
        diagnostics[key] = Math.min(Number.MAX_SAFE_INTEGER, diagnostics[key] + 1);
      }
    } catch { /* Diagnostics are best-effort observation only. */ }
  }

  const validTabId = value => Number.isSafeInteger(value) && value >= 0;

  function state(tabId = null) {
    const active = compatibleTabs.has(tabId);
    return {settings: {...settings}, stats: stats ? {...stats} : null,
      diagnostics: diagnostics ? {...diagnostics} : null,
      tabId, compatibility: validTabId(tabId) ?
        {active, reason: active ? "manual" : null} : null};
  }

  async function stateForTab(tabId) {
    await ready;
    if (validTabId(tabId)) {
      try {
        const tab = await browser.tabs.get(tabId);
        if (NexyBlock.isYouTubeUrl(tab.url)) return state(tabId);
      } catch { /* The tab may have closed. */ }
    }
    return state();
  }

  function tabBadge(tabId) {
    const active = settings.enabled && settings.metadata && compatibleTabs.has(tabId);
    browser.browserAction.setBadgeText({tabId, text: active ? "COMP" : null}).catch(() => {});
    browser.browserAction.setBadgeBackgroundColor({tabId, color: active ? "#966214" : null}).catch(() => {});
  }

  function changed(tabId) {
    tabBadge(tabId);
    browser.runtime.sendMessage({type: "compatibilityChanged", tabId}).catch(() => {});
  }

  function flushTab(tabId, reason) {
    for (const entry of [...activeFilters]) {
      if (entry.tabId === tabId) entry.controller.passThrough(reason);
    }
  }

  function compatibility(tabId, active) {
    if (active) {
      compatibleTabs.add(tabId);
      flushTab(tabId, "compatibility");
    } else compatibleTabs.delete(tabId);
    changed(tabId);
  }

  function badge() {
    browser.browserAction.setBadgeText({text: settings.enabled ? "ON" : "OFF"}).catch(() => {});
    browser.browserAction.setBadgeBackgroundColor({color: settings.enabled ? "#136e62" : "#64748b"}).catch(() => {});
    for (const tabId of compatibleTabs) tabBadge(tabId);
  }

  const ready = browser.storage.local.get("settings").then(value => {
    settings = NexyBlock.normalizeSettings(value.settings);
    syncStatistics();
  }).catch(() => {
    settings = NexyBlock.normalizeSettings({enabled: false});
    syncStatistics();
  }).finally(() => { loaded = true; badge(); });

  function applySettings(next) {
    settings = NexyBlock.normalizeSettings(next);
    syncStatistics();
    // Pausing flushes in-flight responses without applying their transformation.
    if (!settings.enabled || !settings.metadata) {
      for (const entry of [...activeFilters]) entry.controller.passThrough("paused");
    }
    badge();
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) applySettings(changes.settings.newValue);
  });

  browser.tabs.onRemoved.addListener(tabId => {
    compatibleTabs.delete(tabId);
    flushTab(tabId, "tab-closed");
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!compatibleTabs.has(tabId)) return;
    if (typeof changeInfo.url === "string" && !NexyBlock.isYouTubeUrl(changeInfo.url)) {
      compatibleTabs.delete(tabId);
      changed(tabId);
      return;
    }
    // URL/status events can arrive during a valid player response, including
    // History API navigation. Refresh the badge only; never drain its stream.
    tabBadge(tabId);
  }, {properties: ["status", "url"]});

  function request(details) {
    if (NexyBlock.shouldBlockRequest(details, settings)) {
      record("requestsBlocked");
      return {cancel: true};
    }
    return {};
  }

  browser.webRequest.onBeforeRequest.addListener(
    details => loaded ? request(details) : ready.then(() => request(details)),
    {urls: [
      "https://*.doubleclick.net/*", "https://*.googlesyndication.com/*",
      "https://*.googleadservices.com/*", "https://youtube.com/pagead/*",
      "https://www.youtube.com/pagead/*", "https://www.youtube.com/api/stats/ads*",
      "https://www.youtube-nocookie.com/pagead/*"
    ]}, ["blocking"]
  );

  // Callbacks retain only request and numeric tab identifiers,
  // never the request-detail object containing URLs and response headers.
  function attachResponse(requestId, tabId) {
    const epoch = diagnosticEpoch;
    try {
      const filter = browser.webRequest.filterResponseData(requestId);
      const entry = {tabId};
      const remove = () => {
        activeFilters.delete(entry);
        diagnose("streamsFinished", epoch);
      };
      entry.controller = NexyStream.attachBufferedFilter(filter,
        NexyBlock.transformPlayerJson,
        {
          onResult(count) { record("responsesCleaned"); record("fieldsRemoved", count); },
          onBypass(reason) {
            record("responsesBypassed");
            if (Object.hasOwn(DIAGNOSTIC_REASONS, reason)) diagnose(DIAGNOSTIC_REASONS[reason], epoch);
          },
          onFinish: remove
        });
      activeFilters.add(entry);
      diagnose("streamsStarted", epoch);
      return true;
    } catch {
      record("responsesBypassed");
      diagnose("attachErrors", epoch);
      return false;
    }
  }

  function response(details) {
    if (!settings.enabled || !settings.metadata || NexyBlock.responseKind(details) !== "json") return {};
    if (compatibleTabs.has(details.tabId)) { diagnose("manualBypasses"); return {}; }
    if (activeFilters.size >= 4) { diagnose("capacityBypasses"); return {}; }
    if (!attachResponse(details.requestId, details.tabId)) return {};
    return {responseHeaders: details.responseHeaders.filter(header =>
      header.name.toLowerCase() !== "content-length")};
  }

  browser.webRequest.onHeadersReceived.addListener(
    details => loaded ? response(details) : ready.then(() => response(details)),
    {urls: ["https://youtube.com/youtubei/v1/player*", "https://youtube.com/youtubei/v1/get_watch*",
      "https://www.youtube.com/youtubei/v1/player*", "https://www.youtube.com/youtubei/v1/get_watch*",
      "https://www.youtube-nocookie.com/youtubei/v1/player*", "https://www.youtube-nocookie.com/youtubei/v1/get_watch*",
      "https://youtube.com/youtubei/v1/navigation/resolve_url*",
      "https://www.youtube.com/youtubei/v1/navigation/resolve_url*",
      "https://www.youtube-nocookie.com/youtubei/v1/navigation/resolve_url*"],
    types: ["xmlhttprequest"]},
    ["blocking", "responseHeaders"]
  );

  browser.runtime.onMessage.addListener((message, sender) => {
    if (!message || sender.id !== browser.runtime.id) return undefined;
    const ui = sender.url?.startsWith(browser.runtime.getURL(""));
    if (message.type === "getState" && ui) {
      return stateForTab(message.tabId);
    }
    if (message.type === "updateDiagnostics" && ui) {
      const write = settingsWrites.then(() => ready).then(() => {
        if (!["start", "stop", "reset"].includes(message.action)) throw new Error("Invalid diagnostics action");
        if (message.action === "stop") {
          diagnostics = null;
          diagnosticEpoch = null;
        } else if ((message.action === "start" && !diagnostics) ||
            (message.action === "reset" && diagnostics)) freshDiagnostics();
        browser.runtime.sendMessage({type: "diagnosticsChanged"}).catch(() => {});
        return stateForTab(message.tabId);
      });
      settingsWrites = write.catch(() => {});
      return write;
    }
    if (message.type === "updateSettings" && ui) {
      const write = settingsWrites.then(() => ready).then(async () => {
        const next = {...settings};
        for (const key of Object.keys(NexyBlock.DEFAULT_SETTINGS)) {
          if (typeof message.patch?.[key] === "boolean") next[key] = message.patch[key];
        }
        await browser.storage.local.set({settings: next});
        applySettings(next);
        return stateForTab(message.tabId);
      });
      settingsWrites = write.catch(() => {});
      return write;
    }
    if (message.type === "setCompatibility" && ui) {
      const write = settingsWrites.then(() => ready).then(async () => {
        if (!validTabId(message.tabId) || typeof message.active !== "boolean") throw new Error("Invalid tab control");
        const tab = await browser.tabs.get(message.tabId);
        if (!NexyBlock.isYouTubeUrl(tab.url)) throw new Error("YouTube tab required");
        compatibility(message.tabId, message.active);
        return state(message.tabId);
      });
      settingsWrites = write.catch(() => {});
      return write;
    }
    if (message.type === "recordSkip" && sender.tab &&
        NexyBlock.isYouTubeUrl(sender.url) && settings.enabled && settings.autoSkip) {
      record("skipClicks");
    }
    return undefined;
  });
})();
