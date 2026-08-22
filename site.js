// nav
var nav = document.getElementById('nav');
var navLinks = document.getElementById('navLinks');
var navToggle = document.getElementById('navToggle');
if (nav) window.addEventListener('scroll', function () {
  nav.classList.toggle('scrolled', window.scrollY > 12);
}, { passive: true });
if (navToggle && navLinks) {
navToggle.addEventListener('click', function () {
  var open = navLinks.classList.toggle('open');
  navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
});
navLinks.querySelectorAll('a').forEach(function (a) {
  a.addEventListener('click', function () {
    navLinks.classList.remove('open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});
}

// reveal
if ('IntersectionObserver' in window) {
  document.documentElement.classList.add('js-reveal');
  var obs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('visible'); obs.unobserve(e.target); } });
  }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
  document.querySelectorAll('.reveal').forEach(function (el) { obs.observe(el); });
}

// counters
var easeOutQuart = function (t) { return 1 - Math.pow(1 - t, 4); };
function animateCount(el) {
  var target = parseFloat(el.dataset.count);
  var suffix = el.dataset.suffix || '';
  var start = performance.now();
  function step(now) {
    var p = Math.min((now - start) / 1500, 1);
    el.textContent = Math.round(target * easeOutQuart(p)) + suffix;
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}
if ('IntersectionObserver' in window) {
  var cObs = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting && !e.target.dataset.counted) { e.target.dataset.counted = '1'; animateCount(e.target); }
    });
  }, { threshold: 0.5 });
  document.querySelectorAll('[data-count]').forEach(function (el) { cObs.observe(el); });
} else {
  document.querySelectorAll('[data-count]').forEach(function (el) { el.textContent = el.dataset.count + (el.dataset.suffix || ''); });
}

// ?sent=true toast
(function initSentToast() {
  function run() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('sent') !== 'true') return;
    var toast = document.getElementById('sentToast');
    if (!toast) return;
    var timer;
    function hide() { clearTimeout(timer); toast.classList.remove('show'); }
    toast.querySelector('button').addEventListener('click', hide);
    setTimeout(function () {
      toast.classList.add('show');
      var c = document.getElementById('contact');
      if (c) c.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    }, 400);
    timer = setTimeout(hide, 9000);
    params.delete('sent');
    var q = params.toString();
    history.replaceState(null, '', window.location.pathname + (q ? '?' + q : ''));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
