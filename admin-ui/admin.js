(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let csrf = '', days = 7;

  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const fmt = (n) => Number(n || 0).toLocaleString();
  const dur = (s) => { s = Math.round(s || 0); if (s < 60) return s + 's'; const m = Math.floor(s / 60); return m < 60 ? m + 'm ' + (s % 60) + 's' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
  const ago = (iso) => { const d = new Date(iso); if (isNaN(d)) return ''; const s = (Date.now() - d) / 1000;
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); };

  async function api(path, opts = {}) {
    const headers = { 'Accept': 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) };
    const r = await fetch(path, { credentials: 'same-origin', ...opts, headers });
    let data = null; try { data = await r.json(); } catch (_) {}
    return { ok: r.ok, status: r.status, data };
  }

  function show(authed) { $('login').hidden = authed; $('app').hidden = !authed; if (!authed) $('pw').focus(); }

  async function init() {
    const r = await api('/api/admin/session');
    if (r.ok && r.data && r.data.authenticated) { csrf = r.data.csrf || ''; show(true); load(); } else show(false);
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button'); const err = $('login-err');
    err.textContent = ''; btn.disabled = true;
    try {
      const r = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('pw').value }) });
      if (r.ok && r.data && r.data.authenticated) { csrf = r.data.csrf || ''; $('pw').value = ''; show(true); load(); }
      else err.textContent = r.status === 429 ? 'Too many attempts. Try again later.' : 'Wrong password.';
    } catch (_) { err.textContent = 'Network error. Try again.'; }
    btn.disabled = false;
  });

  $('logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    csrf = ''; show(false);
  });

  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
    days = Number(b.dataset.days);
    document.querySelectorAll('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    load();
  }));

  async function load() {
    $('status').textContent = 'Loading…';
    let r;
    try { r = await api('/api/admin/stats?days=' + days); } catch (_) { $('status').textContent = 'Could not load stats.'; return; }
    if (r.status === 401) { csrf = ''; show(false); return; }
    if (!r.ok || !r.data) { $('status').textContent = 'Could not load stats.'; return; }
    $('status').textContent = '';
    render(r.data);
  }

  function rows(target, items, key, val, valLabel) {
    const box = $(target); box.replaceChildren();
    if (!items || !items.length) { box.append(el('p', 'empty', 'Nothing yet.')); return; }
    const max = Math.max(...items.map((i) => i[val] || 0), 1);
    const ul = el('ul', 'rows');
    items.slice(0, 10).forEach((i) => {
      const li = el('li'); const bar = el('span', 'bar'); bar.style.width = ((i[val] || 0) / max * 100) + '%';
      const k = key(i); const ks = el('span', 'k', k); ks.title = k;
      li.append(bar, ks, el('span', 'n', valLabel(i)));
      ul.append(li);
    });
    box.append(ul);
  }

  function chart(series) {
    const box = $('chart'); box.replaceChildren();
    if (!series || !series.length || !series.some((d) => d.visitors || d.pageviews)) { box.append(el('p', 'empty', 'No visits in this period yet.')); return; }
    const NS = 'http://www.w3.org/2000/svg', W = 600, H = 180, pb = 20, pt = 8;
    const max = Math.max(...series.map((d) => Math.max(d.visitors || 0, d.pageviews || 0)), 1);
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Daily visitors and pageviews');
    const slot = W / series.length, bw = Math.max(2, Math.min(28, slot * 0.6));
    series.forEach((d, i) => {
      const x = i * slot + (slot - bw) / 2;
      [['pageviews', '#cfe9e1'], ['visitors', '#0f9d7a']].forEach(([k, c]) => {
        const h = (d[k] || 0) / max * (H - pb - pt);
        const rc = document.createElementNS(NS, 'rect');
        rc.setAttribute('x', x); rc.setAttribute('y', H - pb - h); rc.setAttribute('width', bw); rc.setAttribute('height', h); rc.setAttribute('rx', 2); rc.setAttribute('fill', c);
        const t = document.createElementNS(NS, 'title'); t.textContent = `${d.date}: ${d.visitors || 0} visitors, ${d.pageviews || 0} pageviews`; rc.append(t);
        svg.append(rc);
      });
      const every = Math.ceil(series.length / 7);
      if (i % every === 0 || i === series.length - 1) {
        const tx = document.createElementNS(NS, 'text'); tx.setAttribute('x', x + bw / 2); tx.setAttribute('y', H - 5); tx.setAttribute('text-anchor', 'middle');
        tx.textContent = String(d.date || '').slice(5); svg.append(tx);
      }
    });
    box.append(svg);
  }

  function render(d) {
    const sum = $('summary'); sum.replaceChildren();
    const names = { 1: 'Today', 7: 'Last 7 days', 30: 'Last 30 days' };
    (d.summary || []).forEach((s) => {
      const c = el('div', 'stat' + (s.days === days ? ' on' : ''));
      c.append(el('div', 'lbl', names[s.days] || s.days + ' days'), el('div', 'big', fmt(s.visitors)),
        el('div', 'sub', `visitors · ${fmt(s.pageviews)} views · ${dur(s.avgSeconds)} avg`));
      sum.append(c);
    });
    chart(d.series);
    rows('pages', d.pages, (i) => i.path, 'pageviews', (i) => `${fmt(i.pageviews)} · ${dur(i.avgSeconds)}`);
    rows('sources', d.sources, (i) => i.source || 'Direct', 'visits', (i) => fmt(i.visits));
    rows('locations', d.locations, (i) => [i.city, i.country].filter(Boolean).join(', ') || 'Unknown', 'visits', (i) => fmt(i.visits));
    rows('devices', d.devices, (i) => [i.device, i.browser].filter(Boolean).join(' · ') || 'Unknown', 'visits', (i) => fmt(i.visits));

    const ol = $('recent'); ol.replaceChildren();
    if (!d.recent || !d.recent.length) ol.append(el('li', 'empty', 'No visits yet. They’ll show up here as people browse the portfolio.'));
    (d.recent || []).forEach((v) => {
      const li = el('li'); const meta = el('div', 'meta');
      meta.append(el('span', 'when', ago(v.startedAt)), el('span', 'src', v.source || 'Direct'),
        el('span', null, [v.city, v.country].filter(Boolean).join(', ') || 'Unknown location'),
        el('span', null, [v.device, v.browser].filter(Boolean).join(' · ')), el('span', null, dur(v.seconds)));
      li.append(meta, el('div', 'path', (v.pages || []).join('  →  ') || '(no pages)'));
      ol.append(li);
    });
    $('bots').textContent = d.excludedBots ? `${fmt(d.excludedBots)} bot hits excluded` : '';
  }

  init().catch(() => show(false));
})();
