import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from './store5.js';
import {LABEL,norm} from './constants.js';
import {crawl,runCrawler,liveDiscover,syncClub} from './crawler5.js';
const DIR=path.dirname(fileURLToPath(import.meta.url)),HOST=process.env.HOST||'0.0.0.0',PORT=Number(process.env.PORT||3000),store=new Store();
await store.init();
if(store.mode==='postgres'){
  try{await store.pool.query(`UPDATE players SET rating=CASE WHEN NULLIF(raw_json::jsonb->>'ratingAve','')::double precision>10 THEN NULLIF(raw_json::jsonb->>'ratingAve','')::double precision/10 ELSE NULLIF(raw_json::jsonb->>'ratingAve','')::double precision END WHERE rating=0 AND raw_json IS NOT NULL AND raw_json<>'' AND raw_json::jsonb ? 'ratingAve'`)}catch(e){console.warn('Rating backfill skipped:',e.message)}
}
const files={
  '/':['index5.html','text/html; charset=utf-8'],
  '/style5.css':['style5.css','text/css; charset=utf-8'],
  '/app5.js':['app5.js','application/javascript; charset=utf-8'],
  '/fr/player':['player.html','text/html; charset=utf-8'],
  '/fr/player/':['player.html','text/html; charset=utf-8'],
  '/player-page.css':['player-page.css','text/css; charset=utf-8'],
  '/player-page.js':['player-page.js','application/javascript; charset=utf-8'],
  '/fr/club':['club.html','text/html; charset=utf-8'],
  '/fr/club/':['club.html','text/html; charset=utf-8'],
  '/club-page.css':['club-page.css','text/css; charset=utf-8'],
  '/club-page.js':['club-page.js','application/javascript; charset=utf-8']
};
const label=x=>({...x,platform_label:LABEL[x.platform]||x.platform});
const page=u=>{const p=Math.max(1,Number(u.searchParams.get('page')||1)),limit=Math.min(60,Math.max(12,Number(u.searchParams.get('limit')||30)));return{p,limit}};
function send(res,code,data){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://local');if(files[u.pathname]){const[f,t]=files[u.pathname];res.writeHead(200,{'content-type':t,'cache-control':u.pathname==='/'||u.pathname.startsWith('/fr/')?'no-cache':'public, max-age=60'});return res.end(fs.readFileSync(path.join(DIR,f)))}
if(u.pathname==='/api/health')return send(res,200,{ok:true,version:'v5',storage:store.mode});
if(u.pathname==='/api/crawl')return send(res,200,crawl);
if(u.pathname==='/api/dashboard')return send(res,200,await store.dashboard());
if(u.pathname==='/api/overview'){const o=await store.overview();return send(res,200,{recentClubs:o.recentClubs.map(label),topPlayers:o.topPlayers.map(label),matches:o.matches.map(label)})}
if(u.pathname==='/api/search'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',r=await store.search(q,p);return send(res,200,{clubs:r.clubs.map(label),players:r.players.map(label)})}
if(u.pathname==='/api/discover'&&req.method==='POST'){const q=(u.searchParams.get('q')||'').trim(),p=u.searchParams.get('platform')||'';if(q.length<2)return send(res,400,{error:'2 caractères minimum'});const found=await liveDiscover(store,q,p),r=await store.search(norm(q),p);return send(res,200,{found,clubs:r.clubs.map(label),players:r.players.map(label)})}
if(u.pathname==='/api/club/refresh'&&req.method==='POST'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',name=u.searchParams.get('name')||'';if(!p||!id)return send(res,400,{error:'Club invalide'});await syncClub(store,{club_id:id,name},p);const r=await store.clubAdvanced(p,id);return send(res,200,{...r,club:label(r.club),players:r.players.map(label)})}
if(u.pathname==='/api/clubs'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'skill',pg=page(u),r=await store.paged('clubs',q,p,sort,pg.p,pg.limit);return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label)})}
if(u.pathname==='/api/players'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'games',pg=page(u),r=await store.paged('players',q,p,sort,pg.p,pg.limit);return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label)})}
if(u.pathname==='/api/rankings'){const p=u.searchParams.get('platform')||'',m=u.searchParams.get('metric')||'goals';return send(res,200,{metric:m,items:(await store.rankings(p,m)).map(label)})}
if(u.pathname==='/api/matches'){const p=u.searchParams.get('platform')||'';return send(res,200,{items:(await store.recentMatches(p,80)).map(label)})}
if(u.pathname==='/api/club'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.clubAdvanced(p,id);if(!r)return send(res,404,{error:'Club introuvable'});return send(res,200,{...r,club:label(r.club),players:r.players.map(label)})}
if(u.pathname==='/api/player'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.player(p,id);if(!r)return send(res,404,{error:'Joueur introuvable'});return send(res,200,{player:label(r.player),recent:r.recent})}
return send(res,404,{error:'not found'});}catch(e){console.error(e);return send(res,500,{error:e.message})}});
server.listen(PORT,HOST,()=>{console.log(`FC Clubs Global V5 on ${HOST}:${PORT} [${store.mode}]`);if(process.env.AUTO_MAX_CRAWL!=='0')setTimeout(()=>runCrawler(store),1200)});
setInterval(()=>runCrawler(store),Math.max(1,Number(process.env.AUTO_CRAWL_LOOP_HOURS||2))*3600000).unref();
