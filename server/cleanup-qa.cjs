'use strict';
// Stop the server before this script. It never opens a live WAL database.
const path=require('node:path');
const fs=require('node:fs');
const net=require('node:net');
const Database=require('better-sqlite3');
const root=path.resolve(__dirname,'..');
require('dotenv').config({path:path.join(root,'.env'),quiet:true});
const campaign=process.argv[2];
if(!/^qa-portfolio-[a-zA-Z0-9-]+$/.test(campaign||'')) throw Error('Pass the exact QA fixture campaign, never real traffic');
const port=Number(process.env.PORT||8082);
const probe=net.connect({port,host:'127.0.0.1'});
probe.once('connect',()=>{probe.destroy();console.error('Refusing: server is still listening. Stop runner and server first.');process.exitCode=1;});
probe.once('error',async error=>{
  if(error.code!=='ECONNREFUSED')throw error;
  const dir=path.resolve(process.env.ANALYTICS_DATA||'/home/kit/portfolio-data');
  const db=new Database(path.join(dir,'analytics.sqlite'));
  const backupDir=path.join(dir,'backups');fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
  const backup=path.join(backupDir,'before-qa-cleanup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
  await db.backup(backup);fs.chmodSync(backup,0o600);
  db.pragma('foreign_keys=ON');
  const before=db.prepare('SELECT COUNT(*) n FROM visits WHERE utm_campaign=?').get(campaign).n;
  const result=db.prepare('DELETE FROM visits WHERE utm_campaign=?').run(campaign);
  const after=db.prepare('SELECT COUNT(*) n FROM visits WHERE utm_campaign=?').get(campaign).n;
  const integrity=db.pragma('integrity_check',{simple:true});db.close();
  if(result.changes!==before || after!==0 || integrity!=='ok')throw Error('Cleanup verification failed; backup '+backup);
  console.log(JSON.stringify({campaign,removed:result.changes,remaining:after,integrity,backup}));
});
