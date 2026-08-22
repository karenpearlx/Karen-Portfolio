(function () {
  var box = document.getElementById('lightbox');
  if (!box) return;
  var img = document.getElementById('lightboxImg');
  var closeBtn = document.getElementById('lightboxClose');
  var last = null;

  function open(src, alt) {
    img.src = src;
    img.alt = alt || '';
    box.hidden = false;
    // next frame so the transition runs
    requestAnimationFrame(function () { box.classList.add('open'); });
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }

  function close() {
    box.classList.remove('open');
    document.body.style.overflow = '';
    if (last) last.focus();
    setTimeout(function () { if (!box.classList.contains('open')) { box.hidden = true; img.removeAttribute('src'); } }, 200);
  }

  document.querySelectorAll('[data-full]').forEach(function (el) {
    el.addEventListener('click', function () {
      last = el;
      var inner = el.querySelector('img');
      open(el.getAttribute('data-full'), inner ? inner.alt : '');
    });
  });

  closeBtn.addEventListener('click', close);
  box.addEventListener('click', function (e) { if (e.target === box) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !box.hidden) close();
  });
})();
