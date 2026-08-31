'use strict';

var enabledEl = document.getElementById('enabled');
var sideEl = document.getElementById('side');
var cacheEl = document.querySelector('#cache tbody');
var refreshEl = document.getElementById('refresh');
var resetEl = document.getElementById('reset');

function ago(ts) {
  if (!ts) return '';
  var m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  var hr = Math.round(m / 60);
  return hr < 24 ? hr + 'h ago' : Math.round(hr / 24) + 'd ago';
}

var refreshedAt = 0;

function save() {
  chrome.storage.local.set({
    rsSettings: { enabled: enabledEl.checked, side: sideEl.value, refreshedAt: refreshedAt }
  });
}

function renderCache(entries) {
  cacheEl.textContent = '';
  if (!entries || !entries.length) {
    var tr = document.createElement('tr');
    var td = document.createElement('td');
    td.className = 'empty';
    td.textContent = 'nothing cached yet';
    tr.appendChild(td);
    cacheEl.appendChild(tr);
    return;
  }
  entries.slice(0, 6).forEach(function (e) {
    var row = document.createElement('tr');
    var a = document.createElement('td'); a.className = 'f'; a.textContent = e.file;
    var b = document.createElement('td'); b.className = 'r'; b.textContent = e.species + ' mons · ' + ago(e.fetchedAt);
    row.appendChild(a); row.appendChild(b);
    cacheEl.appendChild(row);
  });
}

function loadCache() {
  chrome.runtime.sendMessage({ __rs: true, type: 'cacheStatus' }, function (res) {
    if (chrome.runtime.lastError || !res || !res.ok) return;
    renderCache(res.entries);
  });
}

chrome.storage.local.get('rsSettings', function (got) {
  var s = got.rsSettings || {};
  enabledEl.checked = s.enabled !== false;
  sideEl.value = s.side === 'near' ? 'near' : 'far';
  refreshedAt = s.refreshedAt || 0;
});

enabledEl.addEventListener('change', save);
sideEl.addEventListener('change', save);

// Open tabs pick this up through chrome.storage.onChanged, so the popup needs
// no "tabs" permission and no host permission for pokemonshowdown.com.
refreshEl.addEventListener('click', function () {
  refreshEl.disabled = true;
  refreshEl.textContent = 'Refreshing…';
  chrome.runtime.sendMessage({ __rs: true, type: 'clearCache' }, function () {
    refreshedAt = Date.now();
    save();
    refreshEl.disabled = false;
    refreshEl.textContent = 'Refresh now';
    loadCache();
  });
});

loadCache();

// The panel remembers where you left it. Dragged to the edge of a big monitor
// and then opened on a laptop, it can end up somewhere you cannot grab it —
// and the drag handle goes with it. This is the way back.
resetEl.addEventListener('click', function () {
  chrome.storage.local.get('rsUi', function (got) {
    var ui = got.rsUi || {};
    ui.pos = null; ui.size = null; ui.collapsed = false;
    chrome.storage.local.set({ rsUi: ui }, function () {
      resetEl.textContent = 'Panel reset';
      setTimeout(function () { resetEl.textContent = 'Reset panel position'; }, 1400);
    });
  });
});
