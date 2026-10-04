'use strict';
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const geoip = require('geoip-lite');
const Bowser = require('bowser');
const { isBot } = require('isbot');
const paths = new Set(['/', '/index.html', '/work.html', '/results.html']);
const DAY = 86400000;
const uuid = /^[a-f0-9-]{36}$/i;
function openAnalytics(file, salt) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS visits (id TEXT PRIMARY KEY, visitor TEXT NOT NULL, started INTEGER NOT NULL, last INTEGER NOT NULL, country TEXT NOT NULL, city TEXT NOT NULL, source TEXT NOT NULL, referrer TEXT NOT NULL, utm_source TEXT NOT NULL, utm_medium TEXT NOT NULL, utm_campaign TEXT NOT NULL, utm_term TEXT NOT NULL, utm_content TEXT NOT NULL, device TEXT NOT NULL, browser TEXT NOT NULL, screen TEXT NOT NULL, ip_hash TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS visits_visitor_last ON visits(visitor,last);
    CREATE INDEX IF NOT EXISTS visits_started ON visits(started);
    CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, visit TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE, path TEXT NOT NULL, started INTEGER NOT NULL, seconds INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS pages_started ON pages(started);
    CREATE INDEX IF NOT EXISTS pages_visit ON pages(visit);
    CREATE TABLE IF NOT EXISTS bots (day TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, last INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0);
  `);
  const hash = value => crypto.createHmac('sha256',salt).update(value).digest('hex');
  const clean = (value, len=150) => typeof value === 'string' ? value.replace(/[\x00-\x1f]/g,'').slice(0,len) : '';
  const date = time => new Date(time + 8*3600000).toISOString().slice(0,10);
  const record = db.transaction((body, visitor, ip, ua, now=Date.now()) => {
    if (!uuid.test(body.pageId || '') || !paths.has(body.path)) return false;
    if (isBot(ua)) {
      if (body.kind === 'pageview') db.prepare('INSERT INTO bots(day,count) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET count=count+1').run(date(now));
      return true;
    }
    const key = hash(visitor);
    let page = db.prepare('SELECT pages.*,visits.visitor FROM pages JOIN visits ON visits.id=pages.visit WHERE pages.id=?').get(body.pageId);
    if (page && page.visitor !== key) return false;
    if (!page) {
      let visit = db.prepare('SELECT * FROM visits WHERE visitor=? AND last>? ORDER BY last DESC LIMIT 1').get(key, now-30*60000);
      if (!visit) {
        const geo = geoip.lookup(ip) || {};
        const parsed = Bowser.parse(ua);
        let referrer=''; let host='';
        try { const url=new URL(body.referrer); if (['https:','http:'].includes(url.protocol)) { host=url.hostname; referrer=url.origin+url.pathname; } } catch {}
        const utm = body.utm && typeof body.utm === 'object' ? body.utm : {};
        const source = clean(utm.source) || (host && host !== body.hostname ? host : 'Direct');
        const id=crypto.randomUUID();
        db.prepare('INSERT INTO visits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,key,now,now,clean(geo.country)||'Unknown',clean(geo.city)||'Unknown',source,clean(referrer,500),clean(utm.source),clean(utm.medium),clean(utm.campaign),clean(utm.term),clean(utm.content),clean(parsed.platform.type)||'Unknown',clean(parsed.browser.name)||'Unknown',clean(body.screen,30),hash(ip));
        visit={id};
      }
      db.prepare('INSERT INTO pages(id,visit,path,started,seconds) VALUES (?,?,?,?,0)').run(body.pageId,visit.id,body.path === '/index.html' ? '/' : body.path,now);
      page={visit:visit.id, started:now};
    }
    // Clamp client-reported active time to elapsed wall time to prevent bogus values.
    const elapsed=Math.max(0,Math.floor((now-page.started)/1000)+2);
    const seconds=Math.max(0,Math.min(Number(body.seconds)||0,elapsed,86400));
    db.prepare('UPDATE pages SET seconds=MAX(seconds,?) WHERE id=?').run(Math.floor(seconds),body.pageId);
    db.prepare('UPDATE visits SET last=? WHERE id=?').run(now,page.visit);
    return true;
  });
  function stats(days, now=Date.now()) {
    const today=date(now);
    const midnight=Date.parse(today+'T00:00:00+08:00');
    const start=midnight-(days-1)*DAY;
    const total = cutoff => ({...db.prepare('SELECT COUNT(DISTINCT v.visitor) visitors, COUNT(*) pageviews, COUNT(DISTINCT p.visit) visits, COALESCE(ROUND(AVG(p.seconds)),0) avgSeconds FROM pages p JOIN visits v ON v.id=p.visit WHERE p.started>=?').get(cutoff)});
    const rows=db.prepare("SELECT date(p.started/1000,'unixepoch','+8 hours') date,COUNT(*) pageviews,COUNT(DISTINCT v.visitor) visitors FROM pages p JOIN visits v ON v.id=p.visit WHERE p.started>=? GROUP BY date").all(start);
    const series=Array.from({length:days},(_,i)=>{const d=date(start+i*DAY);return rows.find(r=>r.date===d)||{date:d,pageviews:0,visitors:0};});
    const recent=db.prepare('SELECT id,started startedAt,last lastAt,country,city,source,device,browser,utm_source utmSource,utm_medium utmMedium,utm_campaign utmCampaign,utm_term utmTerm,utm_content utmContent,referrer,screen FROM visits WHERE id IN (SELECT visit FROM pages WHERE started>=?) ORDER BY last DESC LIMIT 50').all(start).map(v=>({...v,pages:db.prepare('SELECT path FROM pages WHERE visit=? ORDER BY started').all(v.id).map(p=>p.path),seconds:db.prepare('SELECT COALESCE(SUM(seconds),0) n FROM pages WHERE visit=?').get(v.id).n}));
    return {period:{days,start,end:now},totals:total(start),summary:[1,7,30].map(d=>({days:d,...total(midnight-(d-1)*DAY)})),series,
      pages:db.prepare('SELECT path,COUNT(*) pageviews,ROUND(AVG(seconds)) avgSeconds FROM pages WHERE started>=? GROUP BY path ORDER BY pageviews DESC').all(start),
      sources:db.prepare('SELECT source,COUNT(*) visits FROM visits WHERE id IN (SELECT visit FROM pages WHERE started>=?) GROUP BY source ORDER BY visits DESC LIMIT 15').all(start),
      locations:db.prepare('SELECT country,city,COUNT(*) visits FROM visits WHERE id IN (SELECT visit FROM pages WHERE started>=?) GROUP BY country,city ORDER BY visits DESC LIMIT 15').all(start),
      devices:db.prepare('SELECT device,browser,COUNT(*) visits FROM visits WHERE id IN (SELECT visit FROM pages WHERE started>=?) GROUP BY device,browser ORDER BY visits DESC LIMIT 15').all(start),recent,
      excludedBots:db.prepare('SELECT COALESCE(SUM(count),0) n FROM bots WHERE day>=?').get(date(start)).n};
  }
  return {db,hash,record,stats,excludeOwner(visitor){ db.prepare('DELETE FROM visits WHERE visitor=? AND last>?').run(hash(visitor),Date.now()-30*60000); }};
}
module.exports={openAnalytics};
