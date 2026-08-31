/*
 * Randsight — service worker.
 *
 * Sole job: fetch and cache the randbats set data. pkmn/randbats regenerates
 * every format hourly from 100,000 simulated teams, so we cache with a short
 * TTL and fall back to the GitHub raw mirror if the CDN is unreachable.
 */
'use strict';

importScripts('formats.js');

var CDN = 'https://data.pkmn.cc/randbats/stats/';
var MIRROR = 'https://raw.githubusercontent.com/pkmn/randbats/main/data/stats/';
var TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
var inflight = {};

function cacheKey(file) { return 'sets:' + file; }

function readCache(file) {
  return new Promise(function (resolve) {
    chrome.storage.local.get(cacheKey(file), function (got) {
      resolve(got[cacheKey(file)] || null);
    });
  });
}

function writeCache(file, data) {
  var rec = { data: data, fetchedAt: Date.now(), species: Object.keys(data).length };
  var payload = {};
  payload[cacheKey(file)] = rec;
  return new Promise(function (resolve) {
    chrome.storage.local.set(payload, function () {
      if (chrome.runtime.lastError) {
        // Out of quota, most likely. The data is fine and the panel works; it
        // just refetches next time instead of reading a cache that isn't there.
        console.warn('[randsight] cache write failed:', chrome.runtime.lastError.message);
      }
      resolve(rec);
    });
  });
}

function fetchJson(url) {
  // Without a deadline a stalled connection holds the in-flight promise open,
  // and every request that joins it inherits the eventual failure.
  var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
  var timer = ctl ? setTimeout(function () { ctl.abort(); }, 10000) : null;
  var clear = function (v) { if (timer) clearTimeout(timer); return v; };
  return fetchJsonInner(url, ctl).then(clear, function (e) { clear(); throw e; });
}

function fetchJsonInner(url, ctl) {
  var opts = { cache: 'no-cache' };
  if (ctl) opts.signal = ctl.signal;
  return fetch(url, opts).then(function (res) {
    if (!res.ok) throw new Error(url + ' -> HTTP ' + res.status);
    return res.json();
  });
}

function download(file) {
  return fetchJson(CDN + file + '.json').catch(function (e1) {
    console.warn('[randsight] CDN failed, trying mirror:', e1.message);
    return fetchJson(MIRROR + file + '.json');
  });
}

/** Cached-first, revalidate-when-stale. Never leaves the caller empty-handed
 *  if we have *any* copy on disk. */
function getSets(file, force) {
  if (inflight[file]) return inflight[file];

  var p = readCache(file).then(function (cached) {
    var fresh = cached && (Date.now() - cached.fetchedAt) < TTL_MS;
    if (fresh && !force) {
      return { data: cached.data, fetchedAt: cached.fetchedAt, stale: false, species: cached.species };
    }
    return download(file).then(function (data) {
      return writeCache(file, data).then(function (rec) {
        return { data: rec.data, fetchedAt: rec.fetchedAt, stale: false, species: rec.species };
      });
    }).catch(function (err) {
      if (cached) {
        console.warn('[randsight] refresh failed, serving stale cache:', err.message);
        return {
          data: cached.data, fetchedAt: cached.fetchedAt, stale: true,
          species: cached.species, error: err.message
        };
      }
      throw err;
    });
  });

  inflight[file] = p;
  p.catch(function () {}).then(function () { delete inflight[file]; });
  return p;
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.__rs !== true) return;

  if (msg.type === 'getSets') {
    var info = self.RSFormats.resolve(msg.format);
    if (!info.ok) { sendResponse({ ok: false, error: info.reason, info: info }); return true; }
    getSets(info.file, !!msg.force).then(function (r) {
      sendResponse({
        ok: true, info: info, sets: r.data, fetchedAt: r.fetchedAt,
        stale: r.stale, species: r.species, error: r.error || null
      });
    }).catch(function (e) {
      sendResponse({ ok: false, error: e.message, info: info });
    });
    return true;   // async
  }

  if (msg.type === 'cacheStatus') {
    chrome.storage.local.get(null, function (all) {
      var out = [];
      Object.keys(all).forEach(function (k) {
        if (k.indexOf('sets:') !== 0) return;
        out.push({ file: k.slice(5), fetchedAt: all[k].fetchedAt, species: all[k].species });
      });
      out.sort(function (a, b) { return b.fetchedAt - a.fetchedAt; });
      sendResponse({ ok: true, entries: out });
    });
    return true;
  }

  if (msg.type === 'clearCache') {
    chrome.storage.local.get(null, function (all) {
      var keys = Object.keys(all).filter(function (k) { return k.indexOf('sets:') === 0; });
      chrome.storage.local.remove(keys, function () { sendResponse({ ok: true, removed: keys.length }); });
    });
    return true;
  }
});

chrome.runtime.onInstalled.addListener(function (details) {
  // Warm the cache for the format almost everyone plays.
  getSets('gen9randombattle', false).catch(function (e) {
    console.warn('[randsight] prefetch failed:', e.message);
  });

  // Open the guide once, on a genuine first install. Not on every update —
  // nobody wants a tab thrown at them because Chrome reloaded the extension.
  // chrome.tabs.create needs no permission; only reading tab contents does.
  if (details && details.reason === 'install') {
    try { chrome.tabs.create({ url: chrome.runtime.getURL('guide/guide.html') }); }
    catch (e) { /* a tab we can't open is not worth failing the install over */ }
  }
});
