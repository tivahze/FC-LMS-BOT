import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Store} from './store5.js';
import {LABEL,norm} from './constants.js';
import {crawl,runCrawler,liveDiscover,syncClub} from './crawler5.js';
const DIR=path.dirname(fileURLToPath(import.meta.url)),HOST=process.env.HOST||'0.0.0.0',PORT=Number(process.env.PORT||3000),store=new Store();
let storeReady=false,storeInitError='';
store.init().then(async()=>{storeReady=true;console.log('[BOOT] store initialization complete');if(store.mode==='postgres'){try{await store.pool.query(`UPDATE players SET rating=CASE WHEN NULLIF(raw_json::jsonb->>'ratingAve','')::double precision>10 THEN NULLIF(raw_json::jsonb->>'ratingAve','')::double precision/10 ELSE NULLIF(raw_json::jsonb->>'ratingAve','')::double precision END WHERE rating=0 AND raw_json IS NOT NULL AND raw_json<>'' AND raw_json::jsonb ? 'ratingAve'`)}catch(e){console.warn('Rating backfill skipped:',e.message)}}}).catch(e=>{storeInitError=e?.message||String(e);console.error('[BOOT] store initialization failed:',storeInitError)});
const files={
  '/':['home-v8.html','text/html; charset=utf-8'],'/legacy':['index5.html','text/html; charset=utf-8'],'/style5.css':['style5.css','text/css; charset=utf-8'],'/app5.js':['app5.js','application/javascript; charset=utf-8'],'/v8.css':['v8.css','text/css; charset=utf-8'],'/v8-common.js':['v8-common.js','application/javascript; charset=utf-8'],'/home-v8.js':['home-v8.js','application/javascript; charset=utf-8'],
  '/fr/player':['player.html','text/html; charset=utf-8'],'/fr/player/':['player.html','text/html; charset=utf-8'],'/player-page.css':['player-page.css','text/css; charset=utf-8'],'/player-page.js':['player-page.js','application/javascript; charset=utf-8'],'/player-directory-v9.js':['player-directory-v9.js','application/javascript; charset=utf-8'],
  '/fr/club':['club.html','text/html; charset=utf-8'],'/fr/club/':['club.html','text/html; charset=utf-8'],'/club-page.css':['club-page.css','text/css; charset=utf-8'],'/club-page.js':['club-page.js','application/javascript; charset=utf-8'],
  '/fr/rankings':['rankings.html','text/html; charset=utf-8'],'/fr/rankings/':['rankings.html','text/html; charset=utf-8'],'/rankings.js':['rankings.js','application/javascript; charset=utf-8'],
  '/fr/compare':['compare.html','text/html; charset=utf-8'],'/fr/compare/':['compare.html','text/html; charset=utf-8'],'/compare.js':['compare.js','application/javascript; charset=utf-8'],
  '/fr/records':['records.html','text/html; charset=utf-8'],'/fr/records/':['records.html','text/html; charset=utf-8'],'/records.js':['records.js','application/javascript; charset=utf-8'],
  '/fr/h2h':['h2h.html','text/html; charset=utf-8'],'/fr/h2h/':['h2h.html','text/html; charset=utf-8'],'/h2h.js':['h2h.js','application/javascript; charset=utf-8'],
  '/fr/favorites':['favorites.html','text/html; charset=utf-8'],'/fr/favorites/':['favorites.html','text/html; charset=utf-8'],'/favorites.js':['favorites.js','application/javascript; charset=utf-8'],
  '/fr/live':['live.html','text/html; charset=utf-8'],'/fr/live/':['live.html','text/html; charset=utf-8'],'/live.js':['live.js','application/javascript; charset=utf-8'],
  '/fr/archive/fc26':['archive-fc26.html','text/html; charset=utf-8'],'/fr/archive/fc26/':['archive-fc26.html','text/html; charset=utf-8'],'/archive-fc26.js':['archive-fc26.js','application/javascript; charset=utf-8'],
  '/player-detail.js':['player-detail.js','application/javascript; charset=utf-8'],'/club-detail.js':['club-detail.js','application/javascript; charset=utf-8'],'/match-detail.js':['match-detail.js','application/javascript; charset=utf-8'],'/admin-v9.js':['admin-v9.js','application/javascript; charset=utf-8']
};
const label=x=>({...x,platform_label:LABEL[x.platform]||x.platform});
const page=u=>{const p=Math.max(1,Number(u.searchParams.get('page')||1)),limit=Math.min(100,Math.max(10,Number(u.searchParams.get('limit')||30)));return{p,limit}};
const slug=s=>String(s||'profil').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70)||'profil';
const apiCache=new Map();
async function cached(key,ttlMs,fn){const hit=apiCache.get(key),now=Date.now();if(hit&&now-hit.at<ttlMs)return hit.value;const value=await fn();apiCache.set(key,{at:now,value});if(apiCache.size>250){for(const[k,v]of apiCache)if(now-v.at>60000)apiCache.delete(k)}return value}
function send(res,code,data){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
function serve(res,file,type='text/html; charset=utf-8',cache='no-cache'){res.writeHead(200,{'content-type':type,'cache-control':cache});res.end(fs.readFileSync(path.join(DIR,file)))}
function xmlEsc(s){return String(s).replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]))}
function htmlEsc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function baseUrl(req){return`${req.headers['x-forwarded-proto']||'https'}://${req.headers['x-forwarded-host']||req.headers.host||'fc-clubs-global-v3.onrender.com'}`}
function redirect(res,location){res.writeHead(302,{location,'cache-control':'no-cache'});res.end()}
async function serveProfile(type,platform,id,req,res){
  const isPlayer=type==='player',row=await store.one(`SELECT ${isPlayer?'player_id':'club_id'} id,name${isPlayer?',club_name':''} FROM ${isPlayer?'players':'clubs'} WHERE platform=$1 AND ${isPlayer?'player_id':'club_id'}=$2`,[platform,String(id)]);
  if(!row)return send(res,404,{error:isPlayer?'Joueur introuvable':'Club introuvable'});
  const file=isPlayer?'player-detail.html':'club-detail.html',canonical=`${baseUrl(req)}/fr/${type}/${encodeURIComponent(platform)}/${encodeURIComponent(id)}/${slug(row.name)}`;
  const title=`${row.name} — Stats FC 27 Clubs | FC Clubs Global`,desc=isPlayer?`Statistiques FC 27 Clubs de ${row.name}${row.club_name?` avec ${row.club_name}`:''} : matchs, buts, passes, note, poste et performances récentes.`:`Statistiques FC 27 Clubs de ${row.name} : bilan, Skill, effectif, forme, derniers matchs et adversaires.`;
  let html=fs.readFileSync(path.join(DIR,file),'utf8');html=html.replace(/<title>.*?<\/title>/,`<title>${htmlEsc(title)}</title>`).replace('</head>',`<meta name="description" content="${htmlEsc(desc)}"><link rel="canonical" href="${htmlEsc(canonical)}"><meta property="og:title" content="${htmlEsc(title)}"><meta property="og:description" content="${htmlEsc(desc)}"><meta property="og:url" content="${htmlEsc(canonical)}"><meta property="og:type" content="website"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${htmlEsc(title)}"><meta name="twitter:description" content="${htmlEsc(desc)}"></head>`);
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});res.end(html)
}
async function serveMatch(platform,id,req,res){
  const row=await store.one(`SELECT platform,match_id,ts,home_name,home_goals,away_name,away_goals FROM matches WHERE platform=$1 AND match_id=$2 LIMIT 1`,[platform,String(id)]);if(!row)return send(res,404,{error:'Match introuvable'});
  const canonical=`${baseUrl(req)}/fr/match/${encodeURIComponent(platform)}/${encodeURIComponent(id)}`,title=`${row.home_name} ${row.home_goals}-${row.away_goals} ${row.away_name} — FC Clubs Global`,desc=`Match FC 27 Clubs archivé : ${row.home_name} ${row.home_goals}-${row.away_goals} ${row.away_name}. Statistiques et performances joueurs.`;
  let html=fs.readFileSync(path.join(DIR,'match-detail.html'),'utf8');html=html.replace(/<title>.*?<\/title>/,`<title>${htmlEsc(title)}</title>`).replace('</head>',`<link rel="canonical" href="${htmlEsc(canonical)}"><meta property="og:title" content="${htmlEsc(title)}"><meta property="og:description" content="${htmlEsc(desc)}"><meta property="og:url" content="${htmlEsc(canonical)}"><meta property="og:type" content="website"></head>`);res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});res.end(html)
}
const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://local'),pathname=u.pathname;
  if(pathname==='/api/health')return send(res,200,{ok:true,version:'v9',season:'fc27',storage:store.mode,ready:storeReady,initError:storeInitError||undefined});
  if(pathname==='/api/boot-stats'){
    try{
      if(store.mode==='postgres'){
        const r=(await store.pool.query(`SELECT
          (SELECT COUNT(*) FROM players) players,
          (SELECT COUNT(*) FROM clubs) clubs,
          (SELECT COUNT(*) FROM matches) matches,
          (SELECT COUNT(*) FROM match_players) appearances`)).rows[0]||{};
        return send(res,200,{players:Number(r.players||0),clubs:Number(r.clubs||0),matches:Number(r.matches||0),appearances:Number(r.appearances||0),storage:'postgres',ready:storeReady});
      }
      const d=await store.dashboard();
      return send(res,200,{...d,ready:storeReady});
    }catch(e){return send(res,503,{error:'Compteurs indisponibles',ready:false})}
  }
  if(pathname==='/api/v9/live'){
    const limit=Number(u.searchParams.get('limit')||60);
    try{
      const items=await cached(`live:${limit}`,5000,()=>store.v9Live(limit));
      return send(res,200,{items,ready:storeReady});
    }catch(e){
      console.warn('[LIVE API]',e.message);
      return send(res,503,{items:[],ready:false,error:'Flux temporairement indisponible'});
    }
  }
  if(pathname==='/api/v9/records'){
    const p=u.searchParams.get('platform')||'';
    try{
      const r=await cached(`records:${p}`,60000,()=>store.v9Records(p));
      return send(res,200,{...r,ready:storeReady});
    }catch(e){
      console.warn('[RECORDS API]',e.message);
      return send(res,503,{ready:false,error:'Records temporairement indisponibles'});
    }
  }
  if(pathname==='/api/v8/rankings'){
    const type=u.searchParams.get('type')||'player',metric=u.searchParams.get('metric')||(type==='club'?'skill':'goals'),p=u.searchParams.get('platform')||'',min=Number(u.searchParams.get('minGames')||3),pg=page(u);
    const key=`rank:${type}:${metric}:${p}:${min}:${pg.p}:${pg.limit}`;
    try{
      const r=await cached(key,15000,()=>store.v8Rankings(type,metric,p,min,pg.p,pg.limit));
      return send(res,200,{...r,items:r.items.map(label),ready:storeReady});
    }catch(e){
      console.warn('[RANKINGS API]',e.message);
      return send(res,503,{items:[],total:0,pages:1,ready:false,error:'Classement temporairement indisponible'});
    }
  }
  if(pathname==='/api/players'){
    const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'games',pg=page(u);
    const key=`players:${q}:${p}:${sort}:${pg.p}:${pg.limit}`;
    try{
      const r=await cached(key,8000,()=>store.paged('players',q,p,sort,pg.p,pg.limit));
      return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label),ready:storeReady});
    }catch(e){
      console.warn('[PLAYERS API]',e.message);
      return send(res,503,{page:pg.p,total:0,pages:1,items:[],ready:false,error:'Liste des joueurs temporairement indisponible'});
    }
  }
  if(pathname==='/api/clubs'){
    const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'skill',pg=page(u);
    const key=`clubs:${q}:${p}:${sort}:${pg.p}:${pg.limit}`;
    try{
      const r=await cached(key,8000,()=>store.paged('clubs',q,p,sort,pg.p,pg.limit));
      return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label),ready:storeReady});
    }catch(e){
      console.warn('[CLUBS API]',e.message);
      return send(res,503,{page:pg.p,total:0,pages:1,items:[],ready:false,error:'Liste des clubs temporairement indisponible'});
    }
  }
  if(!storeReady&&(pathname.startsWith('/api/')||pathname.startsWith('/fr/player/')||pathname.startsWith('/fr/club/')||pathname.startsWith('/fr/match/')))return send(res,503,{error:'Initialisation en cours',ready:false});
  let m=pathname.match(/^\/fr\/player\/([^/]+)\/([^/]+)(?:\/.*)?$/);if(m)return serveProfile('player',decodeURIComponent(m[1]),decodeURIComponent(m[2]),req,res);
  m=pathname.match(/^\/fr\/club\/([^/]+)\/([^/]+)(?:\/.*)?$/);if(m)return serveProfile('club',decodeURIComponent(m[1]),decodeURIComponent(m[2]),req,res);
  m=pathname.match(/^\/fr\/match\/([^/]+)\/([^/]+)\/?$/);if(m)return serveMatch(decodeURIComponent(m[1]),decodeURIComponent(m[2]),req,res);
  m=pathname.match(/^\/admin\/([^/]+)\/?$/);if(m){const token=decodeURIComponent(m[1]),expected=process.env.ADMIN_TOKEN||'';if(!expected||token!==expected)return send(res,404,{error:'not found'});return serve(res,'admin-v9.html','text/html; charset=utf-8','no-store')}
  if(files[pathname]){const[f,t]=files[pathname];return serve(res,f,t,pathname==='/'||pathname.startsWith('/fr/')||pathname==='/legacy'?'no-cache':'public, max-age=120')}
  m=pathname.match(/^\/fr\/player\/([^/]+)\/?$/);if(m){const q=norm(decodeURIComponent(m[1])),row=await store.one(`SELECT platform,player_id,name FROM players WHERE name_norm=$1 ORDER BY CASE WHEN platform='common-gen5' THEN 0 WHEN platform='common-gen4' THEN 1 ELSE 2 END,games DESC LIMIT 1`,[q]);return row?redirect(res,`/fr/player/${encodeURIComponent(row.platform)}/${encodeURIComponent(row.player_id)}/${slug(row.name)}`):redirect(res,`/fr/player?q=${encodeURIComponent(decodeURIComponent(m[1]))}`)}
  m=pathname.match(/^\/fr\/club\/([^/]+)\/?$/);if(m){const q=norm(decodeURIComponent(m[1])),row=await store.one(`SELECT platform,club_id,name FROM clubs WHERE name_norm=$1 ORDER BY CASE WHEN platform='common-gen5' THEN 0 WHEN platform='common-gen4' THEN 1 ELSE 2 END,games DESC LIMIT 1`,[q]);return row?redirect(res,`/fr/club/${encodeURIComponent(row.platform)}/${encodeURIComponent(row.club_id)}/${slug(row.name)}`):redirect(res,`/fr/club?q=${encodeURIComponent(decodeURIComponent(m[1]))}`)}
  if(pathname==='/robots.txt'){res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});return res.end('User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: https://fc-clubs-global-v3.onrender.com/sitemap.xml\n')}
  if(pathname==='/sitemap.xml'){
    const base=baseUrl(req);let players=[],clubs=[];if(store.mode==='postgres'){players=await store.q('SELECT platform,player_id,name FROM players ORDER BY updated_at DESC LIMIT 3000');clubs=await store.q('SELECT platform,club_id,name FROM clubs ORDER BY updated_at DESC LIMIT 2000')}
    const urls=[`${base}/`,`${base}/fr/player`,`${base}/fr/club`,`${base}/fr/rankings`,`${base}/fr/compare`,`${base}/fr/records`,`${base}/fr/live`,`${base}/fr/archive/fc26`,...players.map(x=>`${base}/fr/player/${encodeURIComponent(x.platform)}/${encodeURIComponent(x.player_id)}/${slug(x.name)}`),...clubs.map(x=>`${base}/fr/club/${encodeURIComponent(x.platform)}/${encodeURIComponent(x.club_id)}/${slug(x.name)}`)];res.writeHead(200,{'content-type':'application/xml; charset=utf-8','cache-control':'public, max-age=3600'});return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(x=>`<url><loc>${xmlEsc(x)}</loc></url>`).join('')}</urlset>`)
  }
if(pathname==='/api/crawl')return send(res,200,crawl);if(pathname==='/api/dashboard')return send(res,200,await store.dashboard());
  if(pathname==='/api/v8/stats')return send(res,200,await cached('v8:stats',15000,()=>store.v8Stats()));
  if(pathname==='/api/v8/search'){const q=(u.searchParams.get('q')||'').trim(),p=u.searchParams.get('platform')||'',limit=Number(u.searchParams.get('limit')||8);if(q.length<1)return send(res,200,{players:[],clubs:[]});const r=await store.v8Search(q,p,limit);return send(res,200,{players:r.players.map(label),clubs:r.clubs.map(label)})}
  if(pathname==='/api/v8/popular'){const type=u.searchParams.get('type')==='club'?'club':'player',limit=Number(u.searchParams.get('limit')||8),items=await cached(`popular:${type}:${limit}`,15000,()=>store.v8Popular(type,limit));return send(res,200,{type,items:items.map(label)})}
  if(pathname==='/api/archive/fc26/summary')return send(res,200,await store.fc26ArchiveSummary());
  if(pathname==='/api/archive/fc26/players'){const q=u.searchParams.get('q')||'',p=u.searchParams.get('platform')||'',pg=page(u),r=await store.fc26ArchivePlayers(q,p,pg.p,pg.limit);return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label)})}
  if(pathname==='/api/archive/fc26/clubs'){const q=u.searchParams.get('q')||'',p=u.searchParams.get('platform')||'',pg=page(u),r=await store.fc26ArchiveClubs(q,p,pg.p,pg.limit);return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label)})}
  if(pathname==='/api/archive/fc26/matches'){const p=u.searchParams.get('platform')||'',limit=Number(u.searchParams.get('limit')||50),items=await store.fc26ArchiveMatches(p,limit);return send(res,200,{items:items.map(label)})}
  if(pathname==='/api/v9/seasons')return send(res,200,await store.v9Seasons());
  if(pathname==='/api/v9/match'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.v9Match(p,id);if(!r)return send(res,404,{error:'Match introuvable'});return send(res,200,r)}
  if(pathname==='/api/v9/h2h'){const p=u.searchParams.get('platform')||'',a=u.searchParams.get('a')||'',b=u.searchParams.get('b')||'';if(!p||!a||!b)return send(res,400,{error:'Deux clubs sont requis'});const r=await store.v9H2H(p,a,b);return send(res,200,r||{})}
  if(pathname==='/api/v9/admin'){const expected=process.env.ADMIN_TOKEN||'',key=u.searchParams.get('key')||'';if(!expected||key!==expected)return send(res,404,{error:'not found'});const r=await store.v9Admin();return send(res,200,{...r,crawl})}
  if(pathname==='/api/overview'){const o=await store.overview();return send(res,200,{recentClubs:o.recentClubs.map(label),topPlayers:o.topPlayers.map(label),matches:o.matches.map(label)})}
  if(pathname==='/api/search'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',r=await store.search(q,p);return send(res,200,{clubs:r.clubs.map(label),players:r.players.map(label)})}
  if(pathname==='/api/discover'&&req.method==='POST'){const q=(u.searchParams.get('q')||'').trim(),p=u.searchParams.get('platform')||'';if(q.length<2)return send(res,400,{error:'2 caractères minimum'});const found=await liveDiscover(store,q,p),r=await store.search(norm(q),p);return send(res,200,{found,clubs:r.clubs.map(label),players:r.players.map(label)})}
  if(pathname==='/api/club/refresh'&&req.method==='POST'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',name=u.searchParams.get('name')||'';if(!p||!id)return send(res,400,{error:'Club invalide'});await syncClub(store,{club_id:id,name},p);const r=await store.clubAdvanced(p,id);return send(res,200,{...r,club:label(r.club),players:r.players.map(label)})}
  if(pathname==='/api/rankings'){const p=u.searchParams.get('platform')||'',metric=u.searchParams.get('metric')||'goals';return send(res,200,{metric,items:(await store.rankings(p,metric)).map(label)})}
  if(pathname==='/api/matches'){const p=u.searchParams.get('platform')||'';return send(res,200,{items:(await store.recentMatches(p,80)).map(label)})}
  if(pathname==='/api/club'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.clubAdvanced(p,id);if(!r)return send(res,404,{error:'Club introuvable'});store.v8TouchView?.('club',p,id).catch(()=>{});return send(res,200,{...r,club:label(r.club),players:r.players.map(label)})}
  if(pathname==='/api/player'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.player(p,id);if(!r)return send(res,404,{error:'Joueur introuvable'});store.v8TouchView?.('player',p,id).catch(()=>{});return send(res,200,{player:label(r.player),recent:r.recent,advanced:r.advanced})}
  return send(res,404,{error:'not found'});
}catch(e){console.error(e);return send(res,500,{error:e.message})}});
server.listen(PORT,HOST,()=>{console.log(`FC Clubs Global V9 on ${HOST}:${PORT} [${store.mode}]`);if(process.env.AUTO_MAX_CRAWL!=='0')setTimeout(()=>runCrawler(store),1200)});setInterval(()=>runCrawler(store),Math.max(1,Number(process.env.AUTO_CRAWL_LOOP_HOURS||2))*3600000).unref();
