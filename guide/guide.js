// The specimen fills its bars once on load, then confirms the second row — the
// whole premise of the extension in about two seconds. Anyone who prefers less
// motion just gets the finished state.
(function () {
  var rows = document.querySelectorAll('#specimen .prow');
  var quiet = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fill() {
    rows.forEach(function (r) { r.querySelector('i').style.width = r.dataset.w + '%'; });
  }

  if (quiet) {
    rows.forEach(function (r) { r.classList.remove('anim'); });
    fill();
    var s = document.getElementById('reveal');
    s.classList.add('seen');
    s.querySelector('i').style.width = '100%';
    s.querySelector('.pct').textContent = 'seen';
    return;
  }

  requestAnimationFrame(function () { requestAnimationFrame(fill); });

  setTimeout(function () {
    var s = document.getElementById('reveal');
    s.classList.add('seen');
    s.querySelector('i').style.width = '100%';
    s.querySelector('.pct').textContent = 'seen';
    // The other candidates share the slots that are left, so they rise.
    document.querySelectorAll('#specimen .prow:not(.seen)').forEach(function (r) {
      if (r.dataset.w === '100') return;
      r.querySelector('i').style.width = '34%';
      r.querySelector('.pct').textContent = '34%';
    });
  }, 1900);
})();
