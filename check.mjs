import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:8082/').replace(/\/$/, '') + '/';
const ALL_PAGES = ['index.html', 'work.html', 'results.html'];
const PAGES = process.env.ONLY ? process.env.ONLY.split(',') : ALL_PAGES;
const VIEWS = (process.env.VIEWS ? JSON.parse(process.env.VIEWS) : [['mobile', 390, 844, true], ['tablet', 768, 1024, true], ['laptop', 1280, 800, false], ['desktop', 1440, 900, false]]);
const SHOTS = '/home/kit/shots/portfolio';

fs.mkdirSync(SHOTS, { recursive: true });

let fails = 0, passes = 0;
const ok = (c, m) => { c ? passes++ : (fails++, console.log('FAIL:', m)); };

// glyphs that Geist does not carry and that render as tofu boxes
const PRICE = [/\$\s?\d+\s*\/\s*hr/i, /per hour/i, /hourly rate/i, /\/hour\b/i];

async function settle(page, h) {
  await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });
  await page.waitForTimeout(400);
  const docH = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < docH; y += Math.round(h * 0.6)) {
    await page.evaluate(v => window.scrollTo(0, v), y);
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.complete ? null : i.decode().catch(() => {}))));
  await page.evaluate(() => {
    const finite = document.getAnimations().filter(a => {
      const t = a.effect && a.effect.getComputedTiming();
      return t && t.iterations !== Infinity;
    });
    return Promise.race([
      Promise.all(finite.map(a => a.finished.catch(() => {}))),
      new Promise(r => setTimeout(r, 2000))
    ]);
  });
}

const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const externals = new Set();

for (const file of PAGES) {
  for (const [vName, w, h, touch] of VIEWS) {
    const tag = `${file.replace('.html', '')}/${vName}`;
    let ctx;
    try {
    ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: touch, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const errs = [];
    const badReq = [];
    page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    page.on('response', r => { if (r.status() >= 400 && new URL(r.url()).host === new URL(BASE).host) badReq.push(r.status() + ' ' + r.url()); });

    const resp = await page.goto(BASE + file, { waitUntil: 'load', timeout: 40000 });
    ok(resp && resp.status() === 200, `${tag}: page status ${resp && resp.status()}`);
    await settle(page, h);

    ok(badReq.length === 0, `${tag}: failed same-origin requests: ${badReq.join(', ')}`);

    // horizontal overflow
    const of = await page.evaluate(() => {
      const cw = document.documentElement.clientWidth;
      const bad = [];
      document.querySelectorAll('body *').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || getComputedStyle(el).position === 'fixed') return;
        if (r.right > cw + 1 || r.left < -1) bad.push(el.tagName + '.' + String(el.className || '').slice(0, 34) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
      });
      return { cw, scrollW: document.documentElement.scrollWidth, bad: bad.slice(0, 6) };
    });
    ok(of.scrollW <= of.cw + 1, `${tag}: horizontal overflow ${of.scrollW} > ${of.cw} :: ${of.bad.join(' | ')}`);

    // images
    const imgs = await page.evaluate(() => [...document.images]
      .filter(i => !i.closest('[hidden]'))
      .map(i => ({ src: i.getAttribute('src'), okd: i.naturalWidth > 0, w: Math.round(i.getBoundingClientRect().width) })));
    imgs.forEach(i => ok(i.okd, `${tag}: image failed ${i.src}`));
    imgs.forEach(i => ok(i.w > 20, `${tag}: image collapsed ${i.src} w=${i.w}`));

    // TOFU DETECTOR: render every non-ascii symbol in the page's own fonts and compare
    // its advance width to U+E000 (private use area, guaranteed to be a missing glyph).
    const tofu = await page.evaluate(() => {
      const text = document.body.innerText;
      const cands = [...new Set(text.split('').filter(ch => {
        const c = ch.codePointAt(0);
        return c > 0x2000 && c < 0x3000; // arrows, symbols, dingbats
      }))];
      if (!cands.length) return [];
      const font = getComputedStyle(document.body).font || '16px sans-serif';
      const draw = (ch) => {
        const c = document.createElement('canvas');
        c.width = 40; c.height = 40;
        const x = c.getContext('2d');
        x.font = font.replace(/^[\d.]+px/, '28px').replace(/\/[\d.]+px/, '');
        x.fillStyle = '#000';
        x.fillText(ch, 4, 30);
        return x.getImageData(0, 0, 40, 40).data.join(',');
      };
      const ref = draw('\uE000');
      return cands.filter(ch => draw(ch) === ref)
                  .map(ch => 'U+' + ch.codePointAt(0).toString(16).toUpperCase());
    });
    ok(tofu.length === 0, `${tag}: glyphs render as empty boxes: ${tofu.join(' ')}`);

    // no pricing anywhere
    const text = await page.evaluate(() => document.body.innerText);
    const priced = PRICE.filter(re => re.test(text)).map(String);
    ok(priced.length === 0, `${tag}: pricing text found: ${priced.join(', ')}`);

    // links
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href'), abs: a.href, text: a.textContent.trim().slice(0, 24), h: Math.round(a.getBoundingClientRect().height) })));
    ok(links.length > 4, `${tag}: barely any links (${links.length})`);
    for (const l of links) {
      if (l.href.startsWith('http')) { externals.add(l.abs); continue; }
      if (l.href.startsWith('mailto:')) continue;
      const [f, hash] = l.href.split('#');
      const target = f || file;
      ok(ALL_PAGES.includes(target) || target === '', `${tag}: link to unknown page "${l.href}" (${l.text})`);
      if (hash && (target === file || target === '')) {
        const exists = await page.evaluate(id => !!document.getElementById(id), hash);
        ok(exists, `${tag}: dead anchor #${hash} (${l.text})`);
      }
    }

    // counters
    const counted = await page.evaluate(() => [...document.querySelectorAll('[data-count]')].map(e => e.textContent.trim()));
    ok(counted.every(t => t !== '0' && t !== '0%'), `${tag}: counters stuck at zero: ${counted.join(',')}`);

    // teal accent live
    const teal = await page.evaluate(() => {
      const el = document.querySelector('.btn-primary') || document.querySelector('.eyebrow');
      return el ? getComputedStyle(el).getPropertyValue('--teal').trim() : '';
    });
    ok(teal === '#0f9d7a', `${tag}: teal token missing, got "${teal}"`);

    // nav behaviour
    const toggleVisible = await page.evaluate(() => { const t = document.getElementById('navToggle'); return t ? t.offsetParent !== null : null; });
    if (w <= 860) {
      ok(toggleVisible === true, `${tag}: hamburger should be visible`);
      await page.click('#navToggle');
      await page.waitForTimeout(320);
      const menu = await page.evaluate(() => { const n = document.getElementById('navLinks'); const r = n.getBoundingClientRect(); return { vis: getComputedStyle(n).visibility, h: Math.round(r.height), right: Math.round(r.right), cw: document.documentElement.clientWidth }; });
      ok(menu.vis === 'visible' && menu.h > 150, `${tag}: menu didn't open ${JSON.stringify(menu)}`);
      ok(menu.right <= menu.cw + 1, `${tag}: open menu overflows ${menu.right} > ${menu.cw}`);
      await page.click('#navToggle');
      await page.waitForTimeout(320);
    } else {
      ok(toggleVisible === false, `${tag}: hamburger should be hidden at ${w}px`);
      const navFits = await page.evaluate(() => { const r = document.querySelector('.nav-links').getBoundingClientRect(); return r.right <= document.documentElement.clientWidth + 1 && r.height < 70; });
      ok(navFits, `${tag}: desktop nav wrapped or overflowed`);
    }

    // tap targets
    if (w <= 680) {
      const small = await page.evaluate(() => {
        const bad = [];
        document.querySelectorAll('a.btn, form button, .nav-links a, .backlink').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.height > 0 && r.height < 36) bad.push(el.textContent.trim().slice(0, 20) + ' h=' + Math.round(r.height));
        });
        return bad;
      });
      ok(small.length === 0, `${tag}: tap targets under 36px: ${small.join(', ')}`);
    }

    // page specific
    if (file === 'index.html' || file === 'work.html') {
      const builds = await page.evaluate(() => [...document.querySelectorAll('.build')].map(c => {
        const r = c.getBoundingClientRect();
        return { t: c.querySelector('h3').textContent, href: c.getAttribute('href'), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) };
      }));
      ok(builds.length === 6, `${tag}: expected 6 build cards, got ${builds.length}`);
      const names = builds.map(x => x.t);
      ['Marvel Dossier', 'The Book Vault PH', 'Reno', 'Verse', 'Vibe Coding', 'Nook'].forEach(n =>
        ok(names.includes(n), `${tag}: build card "${n}" missing`));
      ok(!names.includes('Ledger'), `${tag}: Ledger should not be showcased`);
      ok(!/ledger-six-delta/.test(await page.content()), `${tag}: Ledger link still in the page`);
      builds.forEach(c => ok(c.w > 100 && c.h > 150, `${tag}: build "${c.t}" box ${c.w}x${c.h}`));
      // every card the same width, and the odd last one centred in the grid
      const widths = [...new Set(builds.map(c => c.w))];
      ok(widths.length === 1, `${tag}: build cards have mismatched widths ${widths.join('/')}`);
      // if the grid ever ends on an orphan row again, that card must sit centred
      const cols = await page.evaluate(() => document.querySelector('.build-grid') ? getComputedStyle(document.querySelector('.build-grid')).gridTemplateColumns.split(' ').length : 0);
      if (cols > 1 && builds.length % cols !== 0) {
        const grid = await page.evaluate(() => { const r = document.querySelector('.build-grid').getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right) }; });
        const last = builds[builds.length - 1];
        ok(Math.abs((last.left + last.right) / 2 - (grid.left + grid.right) / 2) <= 2, `${tag}: orphan build card not centred`);
      }
      ok(!/needed to exist\./.test(await page.evaluate(() => document.querySelector('.builds').innerText)), `${tag}: old boastful builds heading still present`);
    }

    if (file === 'index.html') {
      ok(!(await page.evaluate(() => !!document.getElementById('values'))), `${tag}: stubborn/values section still present`);
      const photo = await page.evaluate(() => { const i = document.querySelector('.hero-avatar'); if (!i) return null; const r = i.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), cw: document.documentElement.clientWidth }; });
      ok(photo, `${tag}: hero avatar missing`);
      ok(photo && photo.w <= 112, `${tag}: hero avatar too big (${photo && photo.w}px)`);
      ok(photo && photo.w === photo.h, `${tag}: hero avatar not square (${photo && photo.w}x${photo && photo.h})`);
      ok(photo && photo.w / photo.cw < 0.3, `${tag}: hero avatar takes ${photo && Math.round(photo.w / photo.cw * 100)}% of width`);
      for (const id of ['builds', 'about', 'background', 'results', 'testimonials', 'contact']) {
        const r = await page.evaluate(i => { const e = document.getElementById(i); if (!e) return null; const bb = e.getBoundingClientRect(); return { w: Math.round(bb.width), h: Math.round(bb.height) }; }, id);
        ok(r && r.w > 200 && r.h > 100, `${tag}: section #${id} missing/collapsed ${JSON.stringify(r)}`);
      }
    }

    if (file === 'work.html') {
      const shots = await page.evaluate(() => document.querySelectorAll('.shot').length);
      ok(shots === 10, `${tag}: expected 10 SEO screenshots, got ${shots}`);
      const tools = await page.evaluate(() => document.querySelectorAll('.tool').length);
      ok(tools === 4, `${tag}: expected 4 tool cards, got ${tools}`);
      // lightbox: scroll it into the middle, prove nothing is covering it, then click
      const clickable = await page.evaluate(() => {
        const el = document.querySelector('.shot');
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { covered: !(hit === el || el.contains(hit)), by: hit ? hit.tagName + '.' + String(hit.className).slice(0, 24) : 'null' };
      });
      ok(!clickable.covered, `${tag}: first screenshot card is covered by ${clickable.by}`);
      await page.$eval('.shot', el => el.click());
      await page.waitForTimeout(400);
      const lb = await page.evaluate(() => { const l = document.getElementById('lightbox'); const i = document.getElementById('lightboxImg'); return { hidden: l.hidden, open: l.classList.contains('open'), src: i.getAttribute('src'), nat: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width), cw: document.documentElement.clientWidth }; });
      ok(!lb.hidden && lb.open, `${tag}: lightbox didn't open`);
      ok(lb.nat > 0, `${tag}: lightbox image didn't load ${lb.src}`);
      ok(lb.w <= lb.cw, `${tag}: lightbox image wider than screen ${lb.w} > ${lb.cw}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(350);
      ok(await page.evaluate(() => document.getElementById('lightbox').hidden), `${tag}: lightbox didn't close on Escape`);
    }

    if (file === 'results.html') {
      const charts = await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => ({ id: c.id, w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) })));
      ok(charts.length === 3, `${tag}: expected 3 charts, got ${charts.length}`);
      charts.forEach(c => ok(c.w > 150 && c.h > 150, `${tag}: chart #${c.id} box ${c.w}x${c.h}`));
      const painted = await page.evaluate(() => {
        const c = document.getElementById('ttrChart');
        if (!c) return false;
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 40) if (d[i] > 0) return true;
        return false;
      });
      ok(painted, `${tag}: ttrChart canvas is blank`);
      const rows = await page.evaluate(() => document.querySelectorAll('.wins-table tbody tr').length);
      ok(rows === 10, `${tag}: expected 10 table rows, got ${rows}`);
      const sys = await page.evaluate(() => document.querySelectorAll('.sys').length);
      ok(sys === 6, `${tag}: expected 6 systems cards, got ${sys}`);
    }

    ok(errs.length === 0, `${tag}: console/page errors: ${errs.join(' | ')}`);

    await page.screenshot({ path: `${SHOTS}/${file.replace('.html', '')}-${vName}.png`, fullPage: true });
    if (vName === 'mobile' || vName === 'desktop') {
      await page.screenshot({ path: `${SHOTS}/${file.replace('.html', '')}-${vName}-top.png` });
    }
    } catch (e) {
      ok(false, `${tag}: THREW ${String(e).split('\n')[0]}`);
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  }
}

// external links resolve
const ctx = await b.newContext();
for (const url of externals) {
  // figma.com sits behind CloudFront and 403s datacenter IPs even in a real browser,
  // so it cannot be verified from here. Confirm sharing is set to 'anyone with the link'.
  if (url.includes('fonts.g') || url.includes('jsdelivr') || url.includes('figma.com')) continue;
  try {
    const r = await ctx.request.get(url, { timeout: 25000, maxRedirects: 5 });
    ok(r.status() < 400, `external link ${url} -> ${r.status()}`);
  } catch (e) {
    ok(false, `external link ${url} -> ${e.message.split('\n')[0]}`);
  }
}
await ctx.close();

await b.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
