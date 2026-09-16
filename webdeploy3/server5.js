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
  '/':['home-v8.html','text/html; charset=utf-8'],
  '/legacy':['index5.html','text/html; charset=utf-8'],
  '/style5.css':['style5.css','text/css; charset=utf-8'],
  '/app5.js':['app5.js','application/javascript; charset=utf-8'],
  '/v8.css':['v8.css','text/css; charset=utf-8'],
  '/v8-common.js':['v8-common.js','application/javascript; charset=utf-8'],
  '/home-v8.js':['home-v8.js','application/javascript; charset=utf-8'],
  '/fr/player':['player.html','text/html; charset=utf-8'],
  '/fr/player/':['player.html','text/html; charset=utf-8'],
  '/player-page.css':['player-page.css','text/css; charset=utf-8'],
  '/player-page.js':['player-page.js','application/javascript; charset=utf-8'],
  '/fr/club':['club.html','text/html; charset=utf-8'],
  '/fr/club/':['club.html','text/html; charset=utf-8'],
  '/club-page.css':['club-page.css','text/css; charset=utf-8'],
  '/club-page.js':['club-page.js','application/javascript; charset=utf-8'],
  '/fr/rankings':['rankings.html','text/html; charset=utf-8'],
  '/fr/rankings/':['rankings.html','text/html; charset=utf-8'],
  '/rankings.js':['rankings.js','application/javascript; charset=utf-8'],
  '/fr/compare':['compare.html','text/html; charset=utf-8'],
  '/fr/compare/':['compare.html','text/html; charset=utf-8'],
  '/compare.js':['compare.js','application/javascript; charset=utf-8'],
  '/player-detail.js':['player-detail.js','application/javascript; charset=utf-8'],
  '/club-detail.js':['club-detail.js','application/javascript; charset=utf-8']
};
const label=x=>({...x,platform_label:LABEL[x.platform]||x.platform});
const page=u=>{const p=Math.max(1,Number(u.searchParams.get('page')||1)),limit=Math.min(100,Math.max(10,Number(u.searchParams.get('limit')||30)));return{p,limit}};
const apiCache=new Map();
async function cached(key,ttlMs,fn){const hit=apiCache.get(key),now=Date.now();if(hit&&now-hit.at<ttlMs)return hit.value;const value=await fn();apiCache.set(key,{at:now,value});if(apiCache.size>250){for(const[k,v]of apiCache)if(now-v.at>60000)apiCache.delete(k)}return value}
function send(res,code,data){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
function serve(res,file,type='text/html; charset=utf-8',cache='no-cache'){res.writeHead(200,{'content-type':type,'cache-control':cache});res.end(fs.readFileSync(path.join(DIR,file)))}
function xmlEsc(s){return String(s).replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]))}
const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://local'),pathname=u.pathname;
  if(/^\/fr\/player\/[^/]+\/[^/]+(?:\/.*)?$/.test(pathname))return serve(res,'player-detail.html');
  if(/^\/fr\/club\/[^/]+\/[^/]+(?:\/.*)?$/.test(pathname))return serve(res,'club-detail.html');
  if(files[pathname]){const[f,t]=files[pathname];return serve(res,f,t,pathname==='/'||pathname.startsWith('/fr/')||pathname==='/legacy'?'no-cache':'public, max-age=120')}
  if(pathname==='/robots.txt'){res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});return res.end('User-agent: *\nAllow: /\nSitemap: https://fc-clubs-global-v3.onrender.com/sitemap.xml\n')}
  if(pathname==='/sitemap.xml'){
    const base=`${req.headers['x-forwarded-proto']||'https'}://${req.headers['x-forwarded-host']||req.headers.host||'fc-clubs-global-v3.onrender.com'}`;
    let players=[],clubs=[];if(store.mode==='postgres'){players=await store.q('SELECT platform,player_id,name FROM players ORDER BY updated_at DESC LIMIT 3000');clubs=await store.q('SELECT platform,club_id,name FROM clubs ORDER BY updated_at DESC LIMIT 2000')}
    const slug=s=>String(s||'profil').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70)||'profil';
    const urls=[`${base}/`,`${base}/fr/player`,`${base}/fr/club`,`${base}/fr/rankings`,`${base}/fr/compare`,...players.map(x=>`${base}/fr/player/${encodeURIComponent(x.platform)}/${encodeURIComponent(x.player_id)}/${slug(x.name)}`),...clubs.map(x=>`${base}/fr/club/${encodeURIComponent(x.platform)}/${encodeURIComponent(x.club_id)}/${slug(x.name)}`)];
    res.writeHead(200,{'content-type':'application/xml; charset=utf-8','cache-control':'public, max-age=3600'});return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(x=>`<url><loc>${xmlEsc(x)}</loc></url>`).join('')}</urlset>`)
  }
  if(pathname==='/api/health')return send(res,200,{ok:true,version:'v8',storage:store.mode});
  if(pathname==='/api/crawl')return send(res,200,crawl);
  if(pathname==='/api/dashboard')return send(res,200,await store.dashboard());
  if(pathname==='/api/v8/stats')return send(res,200,await cached('v8:stats',15000,()=>store.v8Stats()));
  if(pathname==='/api/v8/search'){const q=(u.searchParams.get('q')||'').trim(),p=u.searchParams.get('platform')||'',limit=Number(u.searchParams.get('limit')||8);if(q.length<1)return send(res,200,{players:[],clubs:[]});const r=await store.v8Search(q,p,limit);return send(res,200,{players:r.players.map(label),clubs:r.clubs.map(label)})}
  if(pathname==='/api/v8/rankings'){const type=u.searchParams.get('type')||'player',metric=u.searchParams.get('metric')||(type==='club'?'skill':'goals'),p=u.searchParams.get('platform')||'',min=Number(u.searchParams.get('minGames')||3),pg=page(u),key=`rank:${type}:${metric}:${p}:${min}:${pg.p}:${pg.limit}`,r=await cached(key,30000,()=>store.v8Rankings(type,metric,p,min,pg.p,pg.limit));return send(res,200,{...r,items:r.items.map(label)})}
  if(pathname==='/api/v8/popular'){const type=u.searchParams.get('type')==='club'?'club':'player',limit=Number(u.searchParams.get('limit')||8),items=await cached(`popular:${type}:${limit}`,15000,()=>store.v8Popular(type,limit));return send(res,200,{type,items:items.map(label)})}
  if(pathname==='/api/overview'){const o=await store.overview();return send(res,200,{recentClubs:o.recentClubs.map(label),topPlayers:o.topPlayers.map(label),matches:o.matches.map(label)})}
  if(pathname==='/api/search'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',r=await store.search(q,p);return send(res,200,{clubs:r.clubs.map(label),players:r.players.map(label)})}
  if(pathname==='/api/discover'&&req.method==='POST'){const q=(u.searchParams.get('q')||'').trim(),p=u.searchParams.get('platform')||'';if(q.length<2)return send(res,400,{error:'2 caractères minimum'});const found=await liveDiscover(store,q,p),r=await store.search(norm(q),p);return send(res,200,{found,clubs:r.clubs.map(label),players:r.players.map(label)})}
  if(pathname==='/api/club/refresh'&&req.method==='POST'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',name=u.searchParams.get('name')||'';if(!p||!id)return send(res,400,{error:'Club invalide'});await syncClub(store,{club_id:id,name},p);const r=await store.clubAdvanced(p,id);return send(res,200,{...r,club:label(r.club),players:r.players.map(label)})}
  if(pathname==='/api/clubs'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'skill',pg=page(u),r=await store.paged('clubs',q,p,sort,pg.p,pg.limit);return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label)})}
  if(pathname==='/api/players'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'games',pg=page(u),r=await store.paged('players',q,p,sort,pg.p,pg.limit);return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label)})}
  if(pathname==='/api/rankings'){const p=u.searchParams.get('platform')||'',m=u.searchParams.get('metric')||'goals';return send(res,200,{metric:m,items:(await store.rankings(p,m)).map(label)})}
  if(pathname==='/api/matches'){const p=u.searchParams.get('platform')||'';return send(res,200,{items:(await store.recentMatches(p,80)).map(label)})}
  if(pathname==='/api/club'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.clubAdvanced(p,id);if(!r)return send(res,404,{error:'Club introuvable'});store.v8TouchView?.('club',p,id).catch(()=>{});return send(res,200,{...r,club:label(r.club),players:r.players.map(label)})}
  if(pathname==='/api/player'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.player(p,id);if(!r)return send(res,404,{error:'Joueur introuvable'});store.v8TouchView?.('player',p,id).catch(()=>{});return send(res,200,{player:label(r.player),recent:r.recent,advanced:r.advanced})}
  return send(res,404,{error:'not found'});
}catch(e){console.error(e);return send(res,500,{error:e.message})}});
server.listen(PORT,HOST,()=>{console.log(`FC Clubs Global V8 on ${HOST}:${PORT} [${store.mode}]`);if(process.env.AUTO_MAX_CRAWL!=='0')setTimeout(()=>runCrawler(store),1200)});
setInterval(()=>runCrawler(store),Math.max(1,Number(process.env.AUTO_CRAWL_LOOP_HOURS||2))*3600000).unref();
