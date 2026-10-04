'use strict';
const path=require('node:path');
const fs=require('node:fs');
const crypto=require('node:crypto');
const net=require('node:net');
const express=require('express');
const session=require('express-session');
const bcrypt=require('bcrypt');
const helmet=require('helmet');
const {rateLimit}=require('express-rate-limit');
const cookies=require('cookie-parser');
const {openAnalytics}=require('./analytics.cjs');
const root=path.resolve(__dirname,'..');
require('dotenv').config({path:path.join(root,'.env'),quiet:true});
const origin=process.env.PUBLIC_ORIGIN || 'https://unwillingly-meekly-intense-nilgai.kitten.space';
const data=path.resolve(process.env.ANALYTICS_DATA || '/home/kit/portfolio-data');
for(const key of ['ADMIN_PASSWORD_HASH','SESSION_SECRET','IP_SALT']) if(!process.env[key]) throw Error(key+' is required');
if(data.startsWith(root+'/')) throw Error('Analytics data must be outside the web root');
fs.mkdirSync(data,{recursive:true,mode:0o700});
const analytics=openAnalytics(path.join(data,'analytics.sqlite'),process.env.IP_SALT);
const storeDb=new (require('better-sqlite3'))(path.join(data,'sessions.sqlite'));
storeDb.pragma('journal_mode = WAL');
const SessionStore=require('express-session-better-sqlite3')(session,storeDb);
const app=express();
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:false,crossOriginEmbedderPolicy:false}));
app.use(cookies(process.env.SESSION_SECRET));
app.use(express.json({limit:'8kb'}));
const visitorOptions={httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:365*86400000,signed:true};
const ownerOptions={httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:365*86400000,signed:true};
// Hako terminates HTTPS. Use only the proxy-selected address, never client JSON.
const ipOf=req => {
  const ip=String(req.ip||req.socket.remoteAddress||'').replace(/^::ffff:/,'');
  return net.isIP(ip) ? ip : '0.0.0.0';
};
const sameOrigin=(req,res,next)=>{if(req.get('origin')!==origin) return res.status(403).json({error:'Request not allowed.'});next();};
app.get('/healthz',(req,res)=>res.json({ok:true,service:'portfolio-analytics-v1'}));
app.get('/tracking.js',(req,res)=>res.set('Cache-Control','public,max-age=300').sendFile(path.join(root,'tracking.js')));
app.post('/api/track',sameOrigin,rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}), (req,res)=>{
  res.set('Cache-Control','no-store');
  if(req.signedCookies.portfolio_owner==='1') return res.sendStatus(204);
  const body=req.body;
  if(!body || typeof body!=='object') return res.sendStatus(400);
  let visitor=req.signedCookies.portfolio_visitor;
  if(typeof visitor!=='string' || !/^[a-f0-9-]{36}$/i.test(visitor)) {visitor=crypto.randomUUID();res.cookie('portfolio_visitor',visitor,visitorOptions);}
  if(!analytics.record(body,visitor,ipOf(req),String(req.get('user-agent')||'').slice(0,1000))) return res.sendStatus(400);
  res.sendStatus(204);
});
app.use(['/admin','/admin-assets','/api/admin'],(req,res,next)=>{
  res.set({'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow, noarchive','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});next();
});
app.use('/api/admin',session({name:'portfolio_admin',secret:process.env.SESSION_SECRET,store:new SessionStore(),resave:false,saveUninitialized:false,proxy:true,cookie:{httpOnly:true,secure:true,sameSite:'lax',maxAge:365*86400000,path:'/'}}));
const authenticated=(req,res,next)=>{
  if(!req.session?.admin || !req.session.expires || Date.now()>req.session.expires) return res.status(401).json({error:'Please sign in.'});next();
};
app.get('/api/admin/session',(req,res)=>{
  if(req.session?.admin && req.session.expires>Date.now()) return res.json({authenticated:true,csrf:req.session.csrf});
  res.json({authenticated:false});
});
app.post('/api/admin/login',sameOrigin,rateLimit({windowMs:15*60000,limit:10,standardHeaders:'draft-8',legacyHeaders:false,skipSuccessfulRequests:true,message:{error:'Unable to sign in. Please try again later.'}}),async(req,res,next)=>{
  try {
    const now=Date.now();const key=analytics.hash(ipOf(req));
    let attempt=analytics.db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
    if(attempt && attempt.blocked_until>now) return res.status(429).json({error:'Unable to sign in. Please try again later.'});
    const password=typeof req.body?.password==='string' && Buffer.byteLength(req.body.password)<=72 ? req.body.password : '';
    // bcrypt performs its hash verification without a password-dependent string comparison.
    const valid=await bcrypt.compare(password,process.env.ADMIN_PASSWORD_HASH);
    if(!valid) {
      const count=attempt && now-attempt.last<86400000 ? attempt.count+1 : 1;
      const block=count>=5 ? now+Math.min(3600000,30000*2**Math.min(count-5,7)) : 0;
      analytics.db.prepare('INSERT INTO login_attempts(key,count,last,blocked_until) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,last=excluded.last,blocked_until=excluded.blocked_until').run(key,count,now,block);
      console.warn(JSON.stringify({event:'failed-admin-login',at:new Date(now).toISOString(),client:key.slice(0,16),attempt:count}));
      return res.status(401).json({error:'Unable to sign in. Check your password or try again later.'});
    }
    analytics.db.prepare('DELETE FROM login_attempts WHERE key=?').run(key);
    req.session.regenerate(err=>{if(err)return next(err);req.session.admin=true;req.session.csrf=crypto.randomBytes(32).toString('hex');req.session.expires=now+365*86400000;req.session.save(err=>{
      if(err)return next(err);
      if(req.signedCookies.portfolio_visitor) analytics.excludeOwner(req.signedCookies.portfolio_visitor);
      res.cookie('portfolio_owner','1',ownerOptions);
      res.json({authenticated:true,csrf:req.session.csrf});
    });});
  } catch(err){next(err);}
});
app.post('/api/admin/logout',sameOrigin,authenticated,(req,res,next)=>{
  const actual=req.get('x-csrf-token')||''; const expected=req.session.csrf||'';
  if(actual.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(actual),Buffer.from(expected))) return res.status(403).json({error:'Request not allowed.'});
  req.session.destroy(err=>{if(err)return next(err);res.clearCookie('portfolio_admin',{httpOnly:true,secure:true,sameSite:'lax',path:'/'});res.json({ok:true});});
});
app.get('/api/admin/stats',authenticated,(req,res)=>{
  const days=[1,7,30].includes(Number(req.query.days))?Number(req.query.days):7;
  res.json(analytics.stats(days));
});
app.get(['/admin','/admin/'],(req,res)=>res.sendFile(path.join(root,'admin-ui/admin.html')));
app.get('/admin-assets/:file',(req,res)=>{
  if(!['admin.css','admin.js'].includes(req.params.file)) return res.sendStatus(404);
  res.sendFile(path.join(root,'admin-ui',req.params.file));
});
app.get('/robots.txt',(req,res)=>res.type('text/plain').send('User-agent: *\nDisallow: /admin\nDisallow: /api/\nDisallow: /admin-assets/\n'));
// Explicit allowlist, not express.static(root): source, secrets and git can never be served.
const publicFiles=new Set(['index.html','work.html','results.html','site.css','site.js','charts.js','lightbox.js']);
const staticFile=express.static(root,{dotfiles:'deny',index:false,redirect:false});
app.use((req,res,next)=>{
  if(req.path==='/') {res.set('Cache-Control','no-cache');return res.sendFile(path.join(root,'index.html'));}
  const name=req.path.slice(1);
  if(publicFiles.has(name)) {if(name.endsWith('.html'))res.set('Cache-Control','no-cache');return staticFile(req,res,next);}
  if(/^\/(?:images|shots|assets)\/[a-zA-Z0-9_./-]+\.(?:jpg|jpeg|png|webp|gif|svg|woff2)$/i.test(req.path) && !req.path.includes('..') && !/\/assets\/dr-chart-[12]\.(?!.*redacted)/.test(req.path)) return staticFile(req,res,next);
  res.sendStatus(404);
});
app.use((err,req,res,next)=>{console.error(err.message);if(!res.headersSent)res.status(err.status||500).json({error:'Request could not be completed.'});});
const cleanup=()=>{
  storeDb.prepare("DELETE FROM express_session WHERE json_extract(data,'$.expires') < ?").run(Date.now());
  analytics.db.prepare('DELETE FROM login_attempts WHERE last<?').run(Date.now()-7*86400000);
};
cleanup();setInterval(cleanup,3600000).unref();
if(process.env.TEST_MODE==='1') {
  // Local-only cleanup/backup for integration tests, never enabled in production.
  app.post('/__test/cleanup', (req,res)=>{
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return res.sendStatus(403);
    analytics.db.prepare('DELETE FROM visits WHERE utm_campaign=?').run(req.body.campaign);res.json({ok:true});
  });
}
const server=app.listen(Number(process.env.PORT||8082),'0.0.0.0',()=>console.log('portfolio analytics listening on '+server.address().port));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{analytics.db.close();storeDb.close();process.exit(0);}));
