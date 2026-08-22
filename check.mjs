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
      const navInfo = await page.evaluate(() => {
        const items = [...document.querySelectorAll('#navLinks > li > a')];
        return { labels: items.map(a => a.textContent.trim()), hrefs: items.map(a => a.getAttribute('href')) };
      });
      const EXPECTED_NAV = ['Builds', 'About', 'Background', 'Work', 'Case studies', 'Get in touch'];
      ok(JSON.stringify(navInfo.labels) === JSON.stringify(EXPECTED_NAV),
        `${tag}: nav labels differ -> ${JSON.stringify(navInfo.labels)}`);
      ok(!navInfo.labels.includes('Vision'), `${tag}: nav still contains "Vision"`);

      // Internal Tools section must be gone
      ok(!(await page.evaluate(() => !!document.getElementById('tools'))), `${tag}: #tools section still present`);
      ok((await page.evaluate(() => document.querySelectorAll('.tool').length)) === 0,
        `${tag}: stray .tool cards remain`);
      const bodyTxt = await page.evaluate(() => document.body.innerText);
      for (const gone of ['Internal tools', 'Software I built to replace the spreadsheet mess',
                          'Steps and playbooks', 'AI tools for the team']) {
        ok(!bodyTxt.includes(gone), `${tag}: removed copy still on page -> "${gone}"`);
      }

      // Two clean groups + the standalone client case study, in order
      const groups = await page.evaluate(() => [...document.querySelectorAll('.grouphead')].map(g => ({
        id: g.id,
        num: g.querySelector('.grouphead-num')?.textContent.trim(),
        title: g.querySelector('.grouphead-t')?.textContent.replace(/\s+/g, ' ').trim(),
        desc: (g.querySelector('.grouphead-d')?.textContent || '').trim().length,
        top: Math.round(g.getBoundingClientRect().top + window.scrollY),
        w: Math.round(g.getBoundingClientRect().width)
      })));
      ok(groups.length === 3, `${tag}: expected 3 group dividers, got ${groups.length}`);
      const wantGroups = [
        { id: 'client', num: '00', title: 'Product & platform' },
        { id: 'search', num: '01', title: 'SEO, GEO & AEO' },
        { id: 'personal', num: '02', title: 'Personal builds' }
      ];
      wantGroups.forEach((w, i) => {
        const g = groups[i] || {};
        ok(g.id === w.id && g.num === w.num && g.title === w.title,
          `${tag}: group ${i} -> ${JSON.stringify(g)} expected ${JSON.stringify(w)}`);
        ok(g.desc > 40, `${tag}: group ${w.id} description too short (${g.desc})`);
        ok(g.w > 200, `${tag}: group ${w.id} collapsed (w=${g.w})`);
      });
      ok(groups[0].top < groups[1].top && groups[1].top < groups[2].top,
        `${tag}: group dividers out of order ${JSON.stringify(groups.map(g => g.top))}`);

      // section order: vision -> ogtool -> deliverables -> seo-results -> builds
      const order = await page.evaluate(() => ['vision','ogtool','deliverables','seo-results','builds']
        .map(id => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().top + window.scrollY) : -1; }));
      ok(order.every(v => v > 0), `${tag}: a reordered section is missing ${JSON.stringify(order)}`);
      ok(order.every((v, i) => i === 0 || v > order[i - 1]),
        `${tag}: sections out of order ${JSON.stringify(order)}`);

      // personal builds sit inside group 02, client SEO work above it
      ok(order[4] > groups[2].top, `${tag}: #builds is not under the Personal builds divider`);
      ok(order[1] > groups[1].top && order[3] > groups[1].top,
        `${tag}: OGTool/SEO results not under the SEO group divider`);
      ok(order[0] > groups[0].top && order[0] < groups[1].top,
        `${tag}: Vision is not under its own divider`);

      // jump cards must all resolve to real targets
      const jumps = await page.evaluate(() => [...document.querySelectorAll('.jump')].map(a => {
        const h = a.getAttribute('href');
        return { h, okTarget: !h.startsWith('#') || !!document.getElementById(h.slice(1)) };
      }));
      ok(jumps.length === 6, `${tag}: expected 6 jump cards, got ${jumps.length}`);
      jumps.forEach(j => ok(j.okTarget, `${tag}: jump card points at missing target ${j.h}`));
      ok(!jumps.some(j => j.h === '#tools'), `${tag}: jump card still links to #tools`);

      // Vision case study
      const vision = await page.evaluate(() => {
        const sec = document.getElementById('vision');
        if (!sec) return null;
        const num = (sel) => [...sec.querySelectorAll(sel)].map(e => e.textContent.replace(/\s+/g, ' ').trim());
        const bars = [...sec.querySelectorAll('.bar-fill')].map(b => Math.round(b.getBoundingClientRect().width));
        const drs = [...sec.querySelectorAll('.dr img')].map(i => ({ src: i.getAttribute('src'), okd: i.naturalWidth > 0, w: Math.round(i.getBoundingClientRect().width) }));
        return {
          h: Math.round(sec.getBoundingClientRect().height),
          metrics: num('.vmetric b'),
          bas: sec.querySelectorAll('.ba').length,
          bars, drs,
          ships: sec.querySelectorAll('.ship li').length,
          chips: sec.querySelectorAll('.stack-block .chip').length,
          text: sec.innerText
        };
      });
      ok(vision, `${tag}: #vision section missing`);
      if (vision) {
        ok(vision.h > 1200, `${tag}: #vision collapsed (${vision.h}px tall)`);
        ok(vision.metrics.length === 4, `${tag}: expected 4 headline metrics, got ${vision.metrics.length}`);
        ok(vision.bas === 4, `${tag}: expected 4 before/after cards, got ${vision.bas}`);
        ok(vision.bars.length === 6, `${tag}: expected 6 bars, got ${vision.bars.length}`);
        vision.bars.forEach((w, i) => ok(w >= 4, `${tag}: bar ${i} invisible (${w}px)`));
        // each pair: the "after" bar must not be wider than its "before" reference
        ok(vision.bars[0] < vision.bars[1], `${tag}: LinkedIn bars inverted`);
        ok(vision.bars[3] < vision.bars[2], `${tag}: payload bars inverted`);
        ok(vision.bars[5] < vision.bars[4], `${tag}: load-time bars inverted`);
        ok(vision.drs.length === 1 && vision.drs[0].src.includes('dr-chart-1'),
          `${tag}: Vision should show only the first DR chart, got ${JSON.stringify(vision.drs.map(d => d.src))}`);
        vision.drs.forEach(d => ok(d.okd, `${tag}: DR chart failed to load ${d.src}`));
        vision.drs.forEach(d => ok(d.w > 200, `${tag}: DR chart too small (${d.w}px)`));
        ok(vision.ships === 6, `${tag}: expected 6 shipped/system bullets, got ${vision.ships}`);
        ok(vision.chips >= 14, `${tag}: stack chips missing (${vision.chips})`);
        ['145 KB', '100% full', '$26', '451', 'Calendly', 'Drizzle', 'BullMQ'].forEach(t =>
          ok(vision.text.includes(t), `${tag}: Vision content missing "${t}"`));
        ok(!/claimkit|vson/i.test(vision.text), `${tag}: client domain leaked into Vision copy`);
      }

      // integration logos
      const logos = await page.evaluate(() => [...document.querySelectorAll('.logo-row img')].map(i => ({
        alt: i.alt, src: i.getAttribute('src'), loaded: i.naturalWidth > 0,
        w: Math.round(i.getBoundingClientRect().width)
      })));
      ok(logos.length === 4, `${tag}: expected 4 integration logos, got ${logos.length}`);
      ['Calendly', 'Fireflies', 'Fathom', 'LinkedIn'].forEach(n =>
        ok(logos.some(l => l.alt === n), `${tag}: missing logo for ${n}`));
      logos.forEach(l => ok(l.loaded, `${tag}: logo failed to load ${l.src}`));
      logos.forEach(l => ok(l.w >= 18, `${tag}: logo ${l.alt} too small (${l.w}px)`));

      // OGTool case study
      const og = await page.evaluate(() => {
        const sec = document.getElementById('ogtool');
        if (!sec) return null;
        const seg = [...sec.querySelectorAll('.stackbar span')].map(s => Math.round(s.getBoundingClientRect().width));
        const ring = sec.querySelector('.ring-fg');
        return {
          h: Math.round(sec.getBoundingClientRect().height),
          metrics: sec.querySelectorAll('.vmetric').length,
          seg,
          barW: Math.round(sec.querySelector('.stackbar').getBoundingClientRect().width),
          spots: sec.querySelectorAll('.spot').length,
          dots: sec.querySelectorAll('.dotgrid span').length,
          dotsOn: sec.querySelectorAll('.dotgrid span.on').length,
          ringDash: ring && ring.getAttribute('stroke-dasharray'),
          ringW: ring ? Math.round(ring.getBoundingClientRect().width) : 0,
          ogtools: sec.querySelectorAll('.ogtool').length,
          drs: [...sec.querySelectorAll('.dr img')].map(i => ({ src: i.getAttribute('src'), okd: i.naturalWidth > 0 })),
          text: sec.innerText
        };
      });
      ok(og, `${tag}: #ogtool section missing`);
      if (og) {
        ok(og.h > 1200, `${tag}: #ogtool collapsed (${og.h}px)`);
        ok(og.metrics === 3, `${tag}: expected 3 OGTool scale metrics, got ${og.metrics}`);
        ok(og.spots === 4, `${tag}: expected 4 client spotlights, got ${og.spots}`);
        ok(og.ogtools === 8, `${tag}: expected 8 tool cards, got ${og.ogtools}`);
        ok(og.dots === 75, `${tag}: dot grid should be 75 dots, got ${og.dots}`);
        ok(og.dotsOn === 13, `${tag}: dot grid should have 13 filled, got ${og.dotsOn}`);
        ok(og.ringDash === '79.1 326.7', `${tag}: ring dash wrong (${og.ringDash})`);
        ok(og.ringW > 60, `${tag}: ring not rendered (${og.ringW}px)`);
        ok(og.seg.length === 4, `${tag}: stack bar should have 4 segments, got ${og.seg.length}`);
        og.seg.forEach((w, i) => ok(w >= 3, `${tag}: stack segment ${i} invisible (${w}px)`));
        // segments must be ordered largest to smallest and sum to the bar
        ok(og.seg[0] > og.seg[1] && og.seg[1] > og.seg[2] && og.seg[2] > og.seg[3],
          `${tag}: stack segments out of order ${JSON.stringify(og.seg)}`);
        const sum = og.seg.reduce((a, b) => a + b, 0);
        ok(Math.abs(sum - og.barW) <= 4, `${tag}: stack segments sum ${sum} vs bar ${og.barW}`);
        ok(og.drs.length === 1 && og.drs[0].src.includes('dr-chart-2'),
          `${tag}: OGTool should show the second DR chart`);
        og.drs.forEach(d => ok(d.okd, `${tag}: OGTool chart failed to load ${d.src}`));
        ['14', '801', '134', '812', '111', '1,082', '93', '515', '135', '71', '24.2', '105', '304%',
         'Playwright', 'DataForSEO', 'Outrank'].forEach(t =>
          ok(og.text.includes(t), `${tag}: OGTool content missing "${t}"`));
        ok(!/community placement/i.test(og.text), `${tag}: the removed placements metric is back`);
      }
      // no client names anywhere on the page
      const NAMES = ['ClaimKit', 'claimkit.co', 'Kea AI', 'Termina', 'Agent 37', 'vson.ai', 'app.vson.ai'];
      const pageAll = await page.evaluate(() => ({
        text: document.body.innerText,
        attrs: [...document.querySelectorAll('[alt],[title],[aria-label]')]
          .map(e => `${e.getAttribute('alt') || ''} ${e.getAttribute('title') || ''} ${e.getAttribute('aria-label') || ''}`).join(' ')
      }));
      NAMES.forEach(n => {
        ok(!pageAll.text.includes(n), `${tag}: client name "${n}" visible on page`);
        ok(!pageAll.attrs.includes(n), `${tag}: client name "${n}" in an alt/title/aria attribute`);
      });
      ok(/Top performer/.test(pageAll.text), `${tag}: anonymised spotlight labels missing`);

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

    if (file === 'index.html') {
      const cta = await page.evaluate(() => {
        const a = [...document.querySelectorAll('.hero-actions a')]
          .find(e => /see what i've built/i.test(e.textContent));
        if (!a) return null;
        const r = a.getBoundingClientRect();
        return { href: a.getAttribute('href'), w: Math.round(r.width), h: Math.round(r.height) };
      });
      ok(cta, `${tag}: "See what I've built" button is missing`);
      const itxt = await page.evaluate(() => document.body.innerText);
      ['OGTool', 'Vision', '14 clients', '801'].forEach(t =>
        ok(itxt.includes(t), `${tag}: index hero missing "${t}"`));
      ['15 clients', 'Most recently Operations Lead at an AI search startup'].forEach(t =>
        ok(!itxt.includes(t), `${tag}: stale index copy "${t}" is back`));
      // the 250/119 campaign figures may only appear inside the cohort-scoped section
      ok(/250 of those publishes/.test(itxt), `${tag}: the 250 cohort is not scoped as a subset`);
      // the site must not claim a current role anywhere
      [/\bI run\b/, /\bI own\b/, /\bNow operations\b/, /works out of/, /opens every morning/]
        .forEach(re => ok(!re.test(itxt), `${tag}: present-tense employment copy "${re}" is back`));
      ok(/\bI ran\b/.test(itxt), `${tag}: hero should read in past tense`);
      ok(/Ran operations at OGTool/.test(itxt), `${tag}: role line should be past tense`);
      // counters must render thousands separators, matching the prose elsewhere
      const stats = await page.evaluate(() => [...document.querySelectorAll('.stat-num')]
        .map(e => e.textContent.trim()));
      ok(stats.some(v => v === '801'), `${tag}: hero stat 801 missing, got ${stats.join(', ')}`);
      ok(stats.some(v => v === '1,082'), `${tag}: hero stat should read 1,082, got ${stats.join(', ')}`);
      ok(!stats.some(v => v === '1082'), `${tag}: hero stat 1082 is missing its comma`);
      if (cta) {
        ok(cta.href === 'work.html', `${tag}: "See what I've built" points at ${cta.href}, expected work.html`);
        ok(cta.w > 100 && cta.h > 30, `${tag}: "See what I've built" button box ${cta.w}x${cta.h}`);
        const st = await page.evaluate(async (u) => {
          try { return (await fetch(u, { method: 'GET' })).status; } catch { return 0; }
        }, cta.href);
        ok(st === 200, `${tag}: "See what I've built" target ${cta.href} returned HTTP ${st}`);
      }
    }

    if (file === 'results.html') {
      const charts = await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => ({ id: c.id, w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) })));
      const WANT_CHARTS = ['ttrChart', 'clientChart', 'rankChart', 'citeChart', 'winrateChart'];
      ok(charts.length === WANT_CHARTS.length, `${tag}: expected ${WANT_CHARTS.length} charts, got ${charts.length}`);
      WANT_CHARTS.forEach(id => ok(charts.some(c => c.id === id), `${tag}: missing chart #${id}`));
      charts.forEach(c => ok(c.w > 150 && c.h > 150, `${tag}: chart #${c.id} box ${c.w}x${c.h}`));
      // every canvas must have actually painted pixels, not just ttrChart
      const blank = await page.evaluate((ids) => ids.filter(id => {
        const c = document.getElementById(id);
        if (!c) return true;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 40) if (d[i] > 0) return false;
        return true;
      }), WANT_CHARTS);
      ok(blank.length === 0, `${tag}: blank canvases -> ${blank.join(', ')}`);

      // programme numbers must match the source document
      const rtxt = await page.evaluate(() => document.body.innerText);
      ['801', '134', '812', '1,082', '93', '111', '14 accounts'].forEach(t =>
        ok(rtxt.includes(t), `${tag}: results.html missing programme figure "${t}"`));
      // the 250 cohort must be labelled as a subset, never as the whole programme
      ok(!/250 blogs posted/i.test(rtxt), `${tag}: stale "250 blogs posted" headline`);
      ok(/250 of the 801/.test(rtxt), `${tag}: 250 cohort is not labelled as a subset of 801`);
      const heroMetrics = await page.evaluate(() =>
        [...document.querySelectorAll('.metrics .metric')].map(m => m.innerText.replace(/\s+/g, ' ').trim()));
      ok(heroMetrics.length === 4, `${tag}: expected 4 hero metrics, got ${heroMetrics.length}`);
      const cases = await page.evaluate(() =>
        [...document.querySelectorAll('.eyebrow')].map(e => e.textContent.trim()).filter(t => /^Case study/.test(t)));
      ok(JSON.stringify(cases) === JSON.stringify(['Case study 01','Case study 02','Case study 03','Case study 04','Case study 05']),
        `${tag}: case study numbering broken -> ${JSON.stringify(cases)}`);
      const rows = await page.evaluate(() => document.querySelectorAll('.wins-table tbody tr').length);
      ok(rows === 10, `${tag}: expected 10 table rows, got ${rows}`);
      const sys = await page.evaluate(() => document.querySelectorAll('.sys').length);
      ok(sys === 6, `${tag}: expected 6 systems cards, got ${sys}`);
    }

    // nothing may imply a current role: past tense across the whole site
    {
      const tt = await page.evaluate(() => document.body.innerText);
      [[/\bI run\b/, 'I run'], [/\bI own\b/, 'I own'], [/\bI manage\b/, 'I manage'],
       [/\bI lead\b/, 'I lead'], [/\bI oversee\b/, 'I oversee'],
       [/\bcurrently\b/i, 'currently'], [/\bNow operations\b/, 'Now operations'],
       [/\bOperations Lead at\b/, 'Operations Lead at']].forEach(([re, label]) =>
        ok(!re.test(tt), `${tag}: present-tense role copy "${label}" is on the page`));
    }

    const noReddit = await page.evaluate(() => {
      const t = document.body.innerText;
      const a = [...document.querySelectorAll('[alt],[title],[aria-label],[href]')]
        .map(e => `${e.getAttribute('alt') || ''} ${e.getAttribute('title') || ''} ${e.getAttribute('aria-label') || ''} ${e.getAttribute('href') || ''}`).join(' ');
      return { inText: /reddit/i.test(t), inAttrs: /reddit/i.test(a) };
    });
    ok(!noReddit.inText, `${tag}: "Reddit" still appears in page text`);
    ok(!noReddit.inAttrs, `${tag}: "Reddit" still appears in an attribute or link`);

    ok(errs.length === 0, `${tag}: console/page errors: ${errs.join(' | ')}`);

    // un-redacted client charts must not be reachable from the web root
    if (file === 'work.html') {
      const leaky = ['dr-chart-1.jpg', 'dr-chart-1.png', 'dr-chart-1-blurred.png',
                     'dr-chart-2.jpg', 'dr-chart-2.png', 'dr-chart-2-blurred.png'];
      for (const f of leaky) {
        const st = await page.evaluate(async (u) => {
          try { const r = await fetch(u, { method: 'GET' }); return r.status; } catch { return 0; }
        }, `assets/${f}`);
        ok(st === 404 || st === 403 || st === 0, `${tag}: un-redacted chart still served -> assets/${f} (HTTP ${st})`);
      }
    }


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
