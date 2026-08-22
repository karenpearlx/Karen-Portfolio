import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://localhost:8082/';
const b = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });
let fails = 0, passes = 0;
const ok = (c, m) => { c ? passes++ : (fails++, console.log('FAIL:', m)); };

for (const [name, w, h, touch] of [['mobile', 390, 844, true], ['desktop', 1440, 900, false]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: touch, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(String(e)));
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
  await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });
  await page.waitForTimeout(500);

  // step through the page so lazy images load and IntersectionObservers actually fire
  const docH = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < docH; y += Math.round(h * 0.6)) {
    await page.evaluate(v => window.scrollTo(0, v), y);
    await page.waitForTimeout(160);
  }
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  // every lazy image must have decoded
  await page.evaluate(() => Promise.all([...document.images].map(i => i.complete ? null : i.decode().catch(() => {}))));
  // settle animations, but SKIP infinite ones: their .finished NEVER resolves
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

  // overflow
  const overflow = await page.evaluate(() => {
    const cw = document.documentElement.clientWidth;
    const bad = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      if (r.right > cw + 1 || r.left < -1) bad.push(el.tagName + '.' + (el.className || '').toString().slice(0, 40) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    });
    return { cw, scrollW: document.documentElement.scrollWidth, bad: bad.slice(0, 8) };
  });
  ok(overflow.scrollW <= overflow.cw + 1, `${name}: horizontal overflow ${overflow.scrollW} > ${overflow.cw} :: ${overflow.bad.join(' | ')}`);

  // builds
  const builds = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.build')];
    return cards.map(c => {
      const r = c.getBoundingClientRect();
      const img = c.querySelector('img');
      return { href: c.getAttribute('href'), title: c.querySelector('h3').textContent, w: Math.round(r.width), h: Math.round(r.height), imgOk: img.naturalWidth > 0, imgSrc: img.getAttribute('src') };
    });
  });
  ok(builds.length === 6, `${name}: expected 6 build cards, got ${builds.length}`);
  builds.forEach(c => {
    ok(c.imgOk, `${name}: image failed to load ${c.imgSrc}`);
    ok(c.w > 100 && c.h > 150, `${name}: build card "${c.title}" has bad box ${c.w}x${c.h}`);
    ok(/^https?:\/\//.test(c.href), `${name}: build "${c.title}" bad href ${c.href}`);
  });

  // hero + headshot
  const hero = await page.evaluate(() => {
    const img = document.querySelector('.hero-photo img');
    const h1 = document.querySelector('.hero h1').getBoundingClientRect();
    return { imgOk: img.naturalWidth > 0, h1w: Math.round(h1.width), h1h: Math.round(h1.height) };
  });
  ok(hero.imgOk, `${name}: headshot failed to load`);
  ok(hero.h1w > 200 && hero.h1h > 30, `${name}: h1 box ${hero.h1w}x${hero.h1h}`);

  // sections present and visible
  for (const id of ['builds', 'about', 'background', 'values', 'results', 'testimonials', 'contact']) {
    const r = await page.evaluate(i => { const e = document.getElementById(i); if (!e) return null; const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; }, id);
    ok(r && r.w > 200 && r.h > 100, `${name}: section #${id} missing or collapsed ${JSON.stringify(r)}`);
  }

  // counters ran
  const counted = await page.evaluate(() => [...document.querySelectorAll('[data-count]')].map(e => e.textContent.trim()));
  ok(counted.every(t => t !== '0' && t !== '0%'), `${name}: counters didn't animate: ${counted.join(',')}`);

  // teal accent actually applied
  const teal = await page.evaluate(() => getComputedStyle(document.querySelector('.btn-primary')).backgroundColor);
  ok(teal === 'rgb(15, 157, 122)', `${name}: primary btn not teal, got ${teal}`);

  // nav toggle behaviour
  if (name === 'mobile') {
    const tVis = await page.evaluate(() => document.getElementById('navToggle').offsetParent !== null);
    ok(tVis, 'mobile: nav toggle hidden');
    await page.click('#navToggle');
    await page.waitForTimeout(350);
    const menu = await page.evaluate(() => { const b = document.getElementById('navLinks').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), vis: getComputedStyle(document.getElementById('navLinks')).visibility }; });
    ok(menu.vis === 'visible' && menu.h > 200, `mobile: menu didn't open ${JSON.stringify(menu)}`);
    await page.click('#navToggle');
    await page.waitForTimeout(350);
  } else {
    const tVis = await page.evaluate(() => document.getElementById('navToggle').offsetParent !== null);
    ok(!tVis, 'desktop: nav toggle should be hidden');
  }

  // tap targets on mobile
  if (name === 'mobile') {
    const small = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('a.btn, form button, .nav-links a').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.height < 40) bad.push(el.textContent.trim().slice(0, 22) + ' h=' + Math.round(r.height));
      });
      return bad;
    });
    ok(small.length === 0, `mobile: tap targets under 40px: ${small.join(', ')}`);
  }

  ok(errs.length === 0, `${name}: console/page errors: ${errs.join(' | ')}`);

  await page.screenshot({ path: `/home/kit/shots/portfolio-${name}-full.png`, fullPage: true });
  await page.screenshot({ path: `/home/kit/shots/portfolio-${name}-top.png` });
  await ctx.close();
}

await b.close();
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
