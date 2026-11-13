/* global browser, NexyBlock */
"use strict";

(() => {
  document.getElementById("version").textContent = "v" + browser.runtime.getManifest().version;
  const keys = Object.keys(NexyBlock.DEFAULT_SETTINGS);
  const controls = Object.fromEntries(keys.map(key => [key, document.getElementById(key)]));
  const feedback = document.getElementById("feedback");
  const reload = document.getElementById("reload");
  const compatibility = document.getElementById("compatibility");
  const compatibilityToggle = document.getElementById("compatibility-toggle");
  const diagnosticPanel = document.getElementById("diagnostics");
  const diagnosticToggle = document.getElementById("diagnostics-toggle");
  const diagnosticReset = document.getElementById("diagnostics-reset");
  const diagnosticRefresh = document.getElementById("diagnostics-refresh");
  const diagnosticKeys = ["streamsStarted", "streamsFinished", "timeouts", "sizeBypasses",
    "streamErrors", "attachErrors", "capacityBypasses", "manualBypasses", "pauseBypasses", "tabCloseBypasses"];
  let settings;
  let lastState;
  let busy = false;
  let activeTab;
  let refreshId = 0;
  let refreshPending = false;

  function render(state) {
    if (!lastState && state.diagnostics) diagnosticPanel.open = true;
    lastState = state;
    settings = state.settings;
    for (const key of keys) {
      controls[key].checked = settings[key];
      controls[key].disabled = busy || (key !== "enabled" && key !== "statistics" && !settings.enabled);
    }
    document.body.classList.toggle("paused", !settings.enabled);
    const mode = state.compatibility;
    const recovering = !!(mode?.active && settings.enabled && settings.metadata);
    document.body.classList.toggle("compatible", recovering);
    document.getElementById("status").textContent = !settings.enabled ? "Protection paused" :
      recovering ? "Compatibility mode" : "Protection on";
    document.getElementById("status-detail").textContent = !settings.enabled ? "YouTube loads without filtering" :
      recovering ? "Response filtering paused for this tab" : "Enabled for YouTube";
    compatibility.hidden = !mode;
    compatibilityToggle.disabled = busy || !mode || (!mode.active && (!settings.enabled || !settings.metadata));
    compatibilityToggle.textContent = mode?.active ?
      (recovering ? "Restore response filtering" : "Clear compatibility mode") : "Use compatibility mode";
    document.getElementById("compatibility-title").textContent = mode?.active ?
      "Compatibility mode · this tab" : "Playback trouble?";
    document.getElementById("compatibility-note").textContent = !settings.enabled ?
      (mode?.active ? "This tab's compatibility choice is retained. Protection is paused everywhere." :
        "Protection is paused. Enable it to use compatibility mode in this tab.") : !settings.metadata ?
      (mode?.active ? "This tab's compatibility choice is retained. Response filtering is currently off everywhere." :
        "Response filtering is already off everywhere. Enable it to use compatibility mode in this tab.") : mode?.active ?
      "Enabled manually. " +
      "Response filtering is bypassed in this tab. Other enabled layers still run; more ads may appear. Reload if needed." :
      "Manual only. Bypass response filtering in this tab if needed. More ads may appear.";
    reload.disabled = busy || !activeTab || state.tabId !== activeTab.id;
    const collecting = !!(settings.statistics && state.stats);
    document.getElementById("metrics").hidden = !collecting;
    document.getElementById("statistics-note").textContent = collecting ?
      "Session counts only. Switching statistics off clears them. Counts are not a count of video ads removed." :
      "Ad-count statistics are off.";
    for (const key of ["requestsBlocked", "responsesCleaned", "skipClicks"]) {
      document.getElementById(key).textContent = collecting ? state.stats[key].toLocaleString() : "—";
    }
    const diagnosing = !!state.diagnostics;
    document.getElementById("diagnostics-state").textContent = diagnosing ? "On · session" : "Off";
    document.getElementById("diagnostics-note").textContent = diagnosing ?
      "Local session only. Stop clears the counts; restarting the extension turns diagnostics off. No diagnostics are saved or uploaded." :
      "Off by default. Session counts stay in RAM; no URLs or player data are collected.";
    diagnosticToggle.textContent = diagnosing ? "Stop and clear diagnostics" : "Start diagnostics";
    diagnosticToggle.disabled = busy;
    diagnosticReset.disabled = diagnosticRefresh.disabled = busy || !diagnosing;
    document.getElementById("diagnostics-session").hidden = !diagnosing;
    for (const key of diagnosticKeys) {
      document.getElementById("diag-" + key).textContent = diagnosing ? state.diagnostics[key].toLocaleString() : "—";
    }
  }

  async function refresh() {
    if (busy) {refreshPending = true; return;}
    const generation = ++refreshId;
    const state = await browser.runtime.sendMessage({type: "getState", tabId: activeTab?.id});
    if (!busy && generation === refreshId) render(state);
  }

  function beginChange() {
    busy = true;
    refreshId++;
    if (lastState) render(lastState);
  }

  function finishChange(state) {
    busy = false;
    if (state) render(state);
    if (refreshPending) {
      refreshPending = false;
      refresh().catch(() => {});
    }
  }

  for (const [key, control] of Object.entries(controls)) {
    control.addEventListener("change", async () => {
      if (busy) return;
      const checked = control.checked;
      beginChange();
      try {
        const state = await browser.runtime.sendMessage({type: "updateSettings", patch: {[key]: checked}, tabId: activeTab?.id});
        finishChange(state);
        feedback.textContent = key === "statistics" ?
          (checked ? "Ad-count statistics enabled. Counts start from now." : "Ad-count statistics disabled. Its session counts cleared.") :
          "Saved. Reload YouTube to apply response changes.";
      } catch {
        finishChange(lastState);
        feedback.textContent = "Could not save. Close and reopen this panel.";
      }
    });
  }

  compatibilityToggle.addEventListener("click", async () => {
    if (busy || !activeTab || !lastState?.compatibility) return;
    const active = !lastState.compatibility.active;
    beginChange();
    try {
      const state = await browser.runtime.sendMessage({type: "setCompatibility", tabId: activeTab.id, active});
      finishChange(state);
      feedback.textContent = active ? "Compatibility mode enabled for this tab. Reload if needed." :
        state.settings.enabled && state.settings.metadata ? "Response filtering restored for this tab. Reload YouTube to retry." :
        "Compatibility mode cleared for this tab. Global settings still apply.";
    } catch {
      finishChange(lastState);
      feedback.textContent = "Could not update this tab. Reopen the panel on YouTube.";
    }
  });

  async function changeDiagnostics(action) {
    if (busy) return;
    beginChange();
    try {
      const state = await browser.runtime.sendMessage({type: "updateDiagnostics", action, tabId: activeTab?.id});
      finishChange(state);
      feedback.textContent = action === "stop" ? "Diagnostics stopped. Session counts cleared." :
        action === "reset" ? "Diagnostic counts reset. Only new responses will be counted." :
        "Diagnostics started. New response activity is counted locally.";
    } catch {
      finishChange(lastState);
      feedback.textContent = "Could not update diagnostics. Close and reopen this panel.";
    }
  }

  diagnosticToggle.addEventListener("click", () => changeDiagnostics(lastState?.diagnostics ? "stop" : "start"));
  diagnosticReset.addEventListener("click", () => changeDiagnostics("reset"));
  diagnosticRefresh.addEventListener("click", async () => {
    if (busy) return;
    try { await refresh(); }
    catch { feedback.textContent = "Could not refresh diagnostics. Reopen the panel."; }
  });

  reload.addEventListener("click", async () => {
    if (!activeTab) return;
    try {
      const tab = await browser.tabs.get(activeTab.id);
      if (!NexyBlock.isYouTubeUrl(tab.url)) throw new Error("YouTube tab required");
      await browser.tabs.reload(tab.id); window.close();
    }
    catch { feedback.textContent = "Could not reload this tab."; }
  });

  browser.tabs.query({active: true, currentWindow: true}).then(tabs => {
    if (tabs[0] && NexyBlock.isYouTubeUrl(tabs[0].url)) activeTab = {id: tabs[0].id};
    return refresh();
  }).catch(() => { feedback.textContent = "Could not load settings. Reload the extension and try again."; });

  setInterval(async () => {
    if (busy || !settings?.statistics) return;
    try {
      await refresh();
    } catch { /* The panel may be closing or the extension reloading. */ }
  }, 1200);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) refresh().catch(() => {});
  });
  browser.runtime.onMessage.addListener((message, sender) => {
    if (sender.id === browser.runtime.id && sender.url?.startsWith(browser.runtime.getURL("")) &&
        ((message?.type === "compatibilityChanged" && message.tabId === activeTab?.id) ||
          message?.type === "diagnosticsChanged")) {
      refresh().catch(() => {});
    }
  });
})();
