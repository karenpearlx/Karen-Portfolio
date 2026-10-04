'use strict';
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
require('dotenv').config({path:path.join(root,'.env'),quiet:true});
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-integration-'));
const port=18827;const url='http://127.0.0.1:'+port;
let child;
const start=()=>{child=spawn(process.execPath,[path.join(__dirname,'index.cjs')],{env:{...process.env,PORT:String(port),ANALYTICS_DATA:dir},stdio:['ignore','pipe','pipe']});child.stderr.on('data',d=>process.stderr.write(d));};
const ready=async()=>{for(let n=0;n<60;n++){try{if((await fetch(url+'/healthz')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('Server not ready');};
const stop=()=>new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
let cookie='';
async function req(route,body,extra={}){
  const res=await fetch(url+route,{method:body?'POST':'GET',headers:{'Origin':process.env.PUBLIC_ORIGIN,'X-Forwarded-Proto':'https', 'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
  for(const c of res.headers.getSetCookie()){const name=c.split('=')[0];cookie=cookie.split('; ').filter(s=>s && !s.startsWith(name+'=')).concat(c.split(';')[0]).join('; ');}
  return res;
}
(async()=>{
 try{
  start();await ready();
  for(const route of ['/','/.env','/.git/config','/server/index.cjs','/package.json','/node_modules/express/package.json','/admin-ui/admin.html','/data/analytics.sqlite']) {
    const res=await req(route);assert.equal(res.status,route==='/'?200:404,route);
  }
  assert.equal((await req('/api/admin/stats')).status,401);
  assert.deepEqual(await (await req('/api/admin/session')).json(),{authenticated:false});
  assert.equal((await req('/api/admin/login',{password:'bad'},{Origin:'https://evil.example'})).status,403);
  const body={pageId:crypto.randomUUID(),path:'/',kind:'pageview',seconds:0,utm:{source:'integration',campaign:'integration-test'}};
  const ua={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'};
  assert.equal((await req('/api/track',body,ua)).status,204);
  assert.ok(cookie.includes('portfolio_visitor='));
  const login=await req('/api/admin/login',{password:process.env.TEST_PASSWORD});assert.equal(login.status,200);const auth=await login.json();
  assert.ok(auth.csrf);assert.ok(cookie.includes('portfolio_owner='));
  const cookies=login.headers.getSetCookie().join(';');assert.match(cookies,/HttpOnly/);assert.match(cookies,/Secure/);assert.match(cookies,/SameSite=Lax/);assert.match(cookies,/Max-Age=31536000/);
  assert.equal((await (await req('/api/admin/stats')).json()).totals.pageviews,0,'owner visit removed');
  await req('/api/track',{...body,pageId:crypto.randomUUID()},ua);
  assert.equal((await (await req('/api/admin/stats')).json()).totals.pageviews,0,'owner excluded');
  await stop();start();await ready();
  assert.equal((await (await req('/api/admin/session')).json()).authenticated,true,'session survives restart');
  assert.equal((await req('/api/admin/logout',{})).status,403);
  assert.equal((await req('/api/admin/logout',{}, {'X-CSRF-Token':auth.csrf})).status,200);
  assert.equal((await req('/api/admin/stats')).status,401);
  cookie='';
  for(let n=0;n<5;n++)assert.equal((await req('/api/admin/login',{password:'not-the-password'})).status,401);
  assert.equal((await req('/api/admin/login',{password:process.env.TEST_PASSWORD})).status,429,'persistent backoff');
  await stop();start();await ready();
  assert.equal((await req('/api/admin/login',{password:process.env.TEST_PASSWORD})).status,429,'backoff survives restart');
  console.log('PASS protected APIs, no public secrets, owner exclusion, secure year cookie, persistent session/revocation, CSRF, failed-login backoff across restart');
 }finally{if(child.exitCode===null)await stop();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
