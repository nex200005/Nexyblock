(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NexyStream = api;
})(globalThis, function () {
  "use strict";

  function attachBufferedFilter(filter, transform, options = {}) {
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 1000;
    const schedule = options.setTimeout || setTimeout;
    const cancel = options.clearTimeout || clearTimeout;
    let chunks = [];
    let byteLength = 0;
    let finished = false;
    let started = false;
    let pendingBypass = null;
    let timer;
    const notify = (name, value) => { try { options[name]?.(value); } catch { /* Isolate callbacks. */ } };
    const stop = () => { finished = true; cancel(timer); };
    const detach = () => {
      for (const name of ["onstart", "ondata", "onstop", "onerror"]) {
        try { filter[name] = null; } catch { /* A finished channel may reject assignments. */ }
      }
    };
    const release = () => {
      chunks = [];
      byteLength = 0;
      pendingBypass = null;
      detach();
      notify("onFinish");
    };
    const flushOriginal = () => {
      const pending = chunks;
      chunks = [];
      try { for (const chunk of pending) filter.write(chunk); }
      finally { pending.length = 0; }
    };

    function passThrough(reason) {
      if (finished) return;
      if (!started) {
        // Firefox cannot disconnect an unstarted filter. Keep its start/error
        // handlers until the channel can bypass safely; no body is buffered yet.
        pendingBypass ??= reason;
        cancel(timer);
        return;
      }
      stop();
      let result = reason;
      try { flushOriginal(); }
      catch { result = "stream-error"; }
      finally {
        try { filter.disconnect(); } catch { /* The channel may already be closed. */ }
        release();
        notify("onBypass", result);
      }
    }

    timer = schedule(() => passThrough("timeout"), timeoutMs);
    filter.onstart = () => {
      if (finished) return;
      started = true;
      if (pendingBypass !== null) passThrough(pendingBypass);
    };
    filter.ondata = event => {
      if (finished) return;
      chunks.push(new Uint8Array(event.data));
      byteLength += event.data.byteLength;
      if (byteLength > maxBytes) passThrough("size-limit");
    };
    filter.onstop = () => {
      if (finished) return;
      stop();
      let scratch = null;
      let text = null;
      let transformed = null;
      let output = null;
      let removed = 0;
      try {
        scratch = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) { scratch.set(chunk, offset); offset += chunk.byteLength; }
        try {
          text = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(scratch);
        } finally {
          // Only this private decode copy is overwritten. Browser-owned chunks
          // and output passed back to Firefox are never modified.
          scratch.fill(0);
          scratch = null;
        }
        transformed = transform(text);
        text = null;
        if (transformed && typeof transformed.text === "string" && transformed.removed > 0) {
          output = new TextEncoder().encode(transformed.text);
          removed = transformed.removed;
        }
      } catch { /* Decode/parse/rewrite errors retain original response bytes for Firefox. */ }
      finally {
        text = null;
        transformed = null;
        if (scratch) scratch.fill(0);
        scratch = null;
      }
      let failed = false;
      try {
        if (output) filter.write(output);
        else flushOriginal();
      } catch {
        failed = true;
      } finally {
        output = null;
        try {
          if (failed) filter.disconnect();
          else filter.close();
        } catch {
          failed = true;
          try { filter.disconnect(); } catch { /* Already closed. */ }
        }
        release();
      }
      if (failed) notify("onBypass", "stream-error");
      else if (removed) notify("onResult", removed);
    };
    filter.onerror = () => {
      if (finished) return;
      if (started) { passThrough("stream-error"); return; }
      // A failed channel may never emit onstart. It needs only local cleanup,
      // not a disconnect call that is invalid before onstart.
      stop();
      release();
      notify("onBypass", "stream-error");
    };
    return {passThrough};
  }

  return Object.freeze({attachBufferedFilter});
});
