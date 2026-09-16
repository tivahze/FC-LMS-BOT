import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

const { Pool } = pg;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || '/tmp/fc-clubs-v3';
const BASE = 'https://proclubs.ea.com/api/fc';
const PLATFORMS = ['common-gen5', 'common-gen4', 'nx'];
const LABEL = { 'common-gen5': 'Current Gen', 'common-gen4': 'Last Gen', nx: 'Switch' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const uid = (p, id) => `FC26:${p}:${id}`;

class Store {
  constructor() {
    this.mode = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
    this.persistent = this.mode === 'postgres';
    if (this.mode === 'postgres') {
      this.pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL_DISABLE === '1' ? false : { rejectUnauthorized: false }, max: 6 });
    } else {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      this.db = new DatabaseSync(path.join(DATA_DIR, 'fcclubs.db'));
    }
  }

  async init() {
    if (this.mode === 'postgres') {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS clubs(
          uid TEXT PRIMARY KEY, platform TEXT NOT NULL, club_id TEXT NOT NULL, name TEXT NOT NULL,
          name_norm TEXT DEFAULT '', skill DOUBLE PRECISION DEFAULT 0, wins INTEGER DEFAULT 0,
          draws INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, games INTEGER DEFAULT 0,
          updated_at BIGINT DEFAULT 0, synced_at BIGINT DEFAULT 0, raw_json TEXT
        );
        CREATE TABLE IF NOT EXISTS players(
          uid TEXT PRIMARY KEY, platform TEXT NOT NULL, player_id TEXT NOT NULL, name TEXT NOT NULL,
          name_norm TEXT DEFAULT '', club_id TEXT, club_name TEXT, games INTEGER DEFAULT 0,
          goals INTEGER DEFAULT 0, assists INTEGER DEFAULT 0, rating DOUBLE PRECISION DEFAULT 0,
          updated_at BIGINT DEFAULT 0, raw_json TEXT
        );
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
        CREATE INDEX IF NOT EXISTS clubs_name_idx ON clubs(name_norm);
        CREATE INDEX IF NOT EXISTS clubs_platform_idx ON clubs(platform);
        CREATE INDEX IF NOT EXISTS players_name_idx ON players(name_norm);
        CREATE INDEX IF NOT EXISTS players_club_idx ON players(platform, club_id);
      `);
    } else {
      this.db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS clubs(uid TEXT PRIMARY KEY,platform TEXT,club_id TEXT,name TEXT,name_norm TEXT DEFAULT '',skill REAL DEFAULT 0,wins INTEGER DEFAULT 0,draws INTEGER DEFAULT 0,losses INTEGER DEFAULT 0,games INTEGER DEFAULT 0,updated_at INTEGER DEFAULT 0,synced_at INTEGER DEFAULT 0,raw_json TEXT);
        CREATE TABLE IF NOT EXISTS players(uid TEXT PRIMARY KEY,platform TEXT,player_id TEXT,name TEXT,name_norm TEXT DEFAULT '',club_id TEXT,club_name TEXT,games INTEGER DEFAULT 0,goals INTEGER DEFAULT 0,assists INTEGER DEFAULT 0,rating REAL DEFAULT 0,updated_at INTEGER DEFAULT 0,raw_json TEXT);
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
        CREATE INDEX IF NOT EXISTS clubs_name_idx ON clubs(name_norm);
        CREATE INDEX IF NOT EXISTS clubs_platform_idx ON clubs(platform);
        CREATE INDEX IF NOT EXISTS players_name_idx ON players(name_norm);
        CREATE INDEX IF NOT EXISTS players_club_idx ON players(platform,club_id);`);
    }
  }

  async upsertClub(x, p) {
    const values = [uid(p, x.id), p, x.id, x.name, norm(x.name), x.skill, x.wins, x.draws, x.losses, x.games, JSON.stringify(x.raw)];
    if (this.mode === 'postgres') {
      await this.pool.query(`INSERT INTO clubs(uid,platform,club_id,name,name_norm,skill,wins,draws,losses,games,updated_at,raw_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,EXTRACT(EPOCH FROM NOW())::BIGINT,$11)
        ON CONFLICT(uid) DO UPDATE SET
          name=EXCLUDED.name,name_norm=EXCLUDED.name_norm,
          skill=CASE WHEN EXCLUDED.skill>0 THEN EXCLUDED.skill ELSE clubs.skill END,
          wins=GREATEST(clubs.wins,EXCLUDED.wins),draws=GREATEST(clubs.draws,EXCLUDED.draws),
          losses=GREATEST(clubs.losses,EXCLUDED.losses),games=GREATEST(clubs.games,EXCLUDED.games),
          updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,raw_json=EXCLUDED.raw_json`, values);
    } else {
      this.db.prepare(`INSERT INTO clubs(uid,platform,club_id,name,name_norm,skill,wins,draws,losses,games,updated_at,raw_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch(),?) ON CONFLICT(uid) DO UPDATE SET
        name=excluded.name,name_norm=excluded.name_norm,skill=CASE WHEN excluded.skill>0 THEN excluded.skill ELSE clubs.skill END,
        wins=MAX(clubs.wins,excluded.wins),draws=MAX(clubs.draws,excluded.draws),losses=MAX(clubs.losses,excluded.losses),
        games=MAX(clubs.games,excluded.games),updated_at=unixepoch(),raw_json=excluded.raw_json`).run(...values);
    }
  }

  async upsertPlayer(x, p, clubId, clubName) {
    const values = [uid(p, x.id), p, x.id, x.name, norm(x.name), clubId, clubName, x.games, x.goals, x.assists, x.rating, JSON.stringify(x.raw)];
    if (this.mode === 'postgres') {
      await this.pool.query(`INSERT INTO players(uid,platform,player_id,name,name_norm,club_id,club_name,games,goals,assists,rating,updated_at,raw_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,EXTRACT(EPOCH FROM NOW())::BIGINT,$12)
        ON CONFLICT(uid) DO UPDATE SET
          name=EXCLUDED.name,name_norm=EXCLUDED.name_norm,club_id=EXCLUDED.club_id,club_name=EXCLUDED.club_name,
          games=GREATEST(players.games,EXCLUDED.games),goals=GREATEST(players.goals,EXCLUDED.goals),
          assists=GREATEST(players.assists,EXCLUDED.assists),
          rating=CASE WHEN EXCLUDED.rating>0 THEN EXCLUDED.rating ELSE players.rating END,
          updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,raw_json=EXCLUDED.raw_json`, values);
    } else {
      this.db.prepare(`INSERT INTO players(uid,platform,player_id,name,name_norm,club_id,club_name,games,goals,assists,rating,updated_at,raw_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,unixepoch(),?) ON CONFLICT(uid) DO UPDATE SET
        name=excluded.name,name_norm=excluded.name_norm,club_id=excluded.club_id,club_name=excluded.club_name,
        games=MAX(players.games,excluded.games),goals=MAX(players.goals,excluded.goals),assists=MAX(players.assists,excluded.assists),
        rating=CASE WHEN excluded.rating>0 THEN excluded.rating ELSE players.rating END,updated_at=unixepoch(),raw_json=excluded.raw_json`).run(...values);
    }
  }

  async getMeta(key, fallback = '0') {
    if (this.mode === 'postgres') return (await this.pool.query('SELECT value FROM meta WHERE key=$1', [key])).rows[0]?.value ?? fallback;
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? fallback;
  }
  async setMeta(key, value) {
    if (this.mode === 'postgres') await this.pool.query('INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value', [key, String(value)]);
    else this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
  async markSynced(p, clubId) {
    if (this.mode === 'postgres') await this.pool.query('UPDATE clubs SET synced_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE platform=$1 AND club_id=$2', [p, clubId]);
    else this.db.prepare('UPDATE clubs SET synced_at=unixepoch() WHERE platform=? AND club_id=?').run(p, clubId);
  }
  async nextClubs(p, limit) {
    if (this.mode === 'postgres') return (await this.pool.query('SELECT club_id,name FROM clubs WHERE platform=$1 ORDER BY COALESCE(synced_at,0) ASC,updated_at DESC LIMIT $2', [p, limit])).rows;
    return this.db.prepare('SELECT club_id,name FROM clubs WHERE platform=? ORDER BY synced_at ASC,updated_at DESC LIMIT ?').all(p, limit);
  }
  async dashboard() {
    if (this.mode === 'postgres') {
      const r = await this.pool.query(`SELECT (SELECT COUNT(*) FROM clubs)::INT clubs,(SELECT COUNT(*) FROM players)::INT players,(SELECT COALESCE(SUM(games),0) FROM clubs)::BIGINT games,(SELECT COUNT(DISTINCT platform) FROM clubs)::INT platforms`);
      return { ...r.rows[0], games: Number(r.rows[0].games), storage: 'postgres', persistent: true };
    }
    return { clubs: this.db.prepare('SELECT COUNT(*) c FROM clubs').get().c, players: this.db.prepare('SELECT COUNT(*) c FROM players').get().c, games: this.db.prepare('SELECT COALESCE(SUM(games),0) c FROM clubs').get().c, platforms: this.db.prepare('SELECT COUNT(DISTINCT platform) c FROM clubs').get().c, storage: 'sqlite', persistent: false };
  }
  async search(q, p) {
    const pat = `%${q}%`, prefix = `${q}%`;
    if (this.mode === 'postgres') {
      const c = await this.pool.query(`SELECT platform,club_id,name,skill,wins,draws,losses,games FROM clubs WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3) ORDER BY CASE WHEN name_norm=$2 THEN 0 WHEN name_norm LIKE $4 THEN 1 ELSE 2 END,skill DESC LIMIT 20`, [p, q, pat, prefix]);
      const pl = await this.pool.query(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating FROM players WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3) ORDER BY CASE WHEN name_norm=$2 THEN 0 WHEN name_norm LIKE $4 THEN 1 ELSE 2 END,rating DESC,games DESC LIMIT 20`, [p, q, pat, prefix]);
      return { clubs: c.rows, players: pl.rows };
    }
    const clubs = this.db.prepare("SELECT platform,club_id,name,skill,wins,draws,losses,games FROM clubs WHERE (?='' OR platform=?) AND (?='' OR name_norm LIKE ?) ORDER BY CASE WHEN name_norm=? THEN 0 WHEN name_norm LIKE ? THEN 1 ELSE 2 END,skill DESC LIMIT 20").all(p, p, q, pat, q, prefix);
    const players = this.db.prepare("SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating FROM players WHERE (?='' OR platform=?) AND (?='' OR name_norm LIKE ?) ORDER BY CASE WHEN name_norm=? THEN 0 WHEN name_norm LIKE ? THEN 1 ELSE 2 END,rating DESC,games DESC LIMIT 20").all(p, p, q, pat, q, prefix);
    return { clubs, players };
  }
  async listClubs({ q, p, sort, limit, offset }) {
    const pat = `%${q}%`; const order = { skill: 'skill DESC,games DESC', games: 'games DESC,skill DESC', name: 'name ASC', recent: 'updated_at DESC' }[sort] || 'skill DESC,games DESC';
    if (this.mode === 'postgres') {
      const total = Number((await this.pool.query(`SELECT COUNT(*) c FROM clubs WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3)`, [p, q, pat])).rows[0].c);
      const items = (await this.pool.query(`SELECT platform,club_id,name,skill,wins,draws,losses,games FROM clubs WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3) ORDER BY ${order} LIMIT $4 OFFSET $5`, [p, q, pat, limit, offset])).rows;
      return { total, items };
    }
    const where = "(?='' OR platform=?) AND (?='' OR name_norm LIKE ?)";
    const total = this.db.prepare(`SELECT COUNT(*) c FROM clubs WHERE ${where}`).get(p, p, q, pat).c;
    const items = this.db.prepare(`SELECT platform,club_id,name,skill,wins,draws,losses,games FROM clubs WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(p, p, q, pat, limit, offset);
    return { total, items };
  }
  async listPlayers({ q, p, sort, limit, offset }) {
    const pat = `%${q}%`; const order = { rating: 'rating DESC,games DESC', goals: 'goals DESC,games DESC', assists: 'assists DESC,games DESC', games: 'games DESC,goals DESC', name: 'name ASC', recent: 'updated_at DESC' }[sort] || 'rating DESC,games DESC';
    if (this.mode === 'postgres') {
      const total = Number((await this.pool.query(`SELECT COUNT(*) c FROM players WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3)`, [p, q, pat])).rows[0].c);
      const items = (await this.pool.query(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating FROM players WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3) ORDER BY ${order} LIMIT $4 OFFSET $5`, [p, q, pat, limit, offset])).rows;
      return { total, items };
    }
    const where = "(?='' OR platform=?) AND (?='' OR name_norm LIKE ?)";
    const total = this.db.prepare(`SELECT COUNT(*) c FROM players WHERE ${where}`).get(p, p, q, pat).c;
    const items = this.db.prepare(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating FROM players WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(p, p, q, pat, limit, offset);
    return { total, items };
  }
  async rankings(p, metric) {
    const m = ['goals','assists','rating','games'].includes(metric) ? metric : 'goals';
    if (this.mode === 'postgres') return (await this.pool.query(`SELECT platform,player_id,name,club_name,games,goals,assists,rating FROM players WHERE ($1='' OR platform=$1) AND games>0 ORDER BY ${m} DESC,games DESC LIMIT 50`, [p])).rows;
    return this.db.prepare(`SELECT platform,player_id,name,club_name,games,goals,assists,rating FROM players WHERE (?='' OR platform=?) AND games>0 ORDER BY ${m} DESC,games DESC LIMIT 50`).all(p, p);
  }
  async club(p, id) {
    if (this.mode === 'postgres') {
      const c = (await this.pool.query('SELECT * FROM clubs WHERE platform=$1 AND club_id=$2', [p, id])).rows[0];
      const players = (await this.pool.query('SELECT platform,player_id,name,club_name,games,goals,assists,rating FROM players WHERE platform=$1 AND club_id=$2 ORDER BY rating DESC,goals DESC,games DESC LIMIT 100', [p, id])).rows;
      return { club: c, players };
    }
    const club = this.db.prepare('SELECT * FROM clubs WHERE platform=? AND club_id=?').get(p, id);
    const players = this.db.prepare('SELECT platform,player_id,name,club_name,games,goals,assists,rating FROM players WHERE platform=? AND club_id=? ORDER BY rating DESC,goals DESC,games DESC LIMIT 100').all(p, id);
    return { club, players };
  }
  async player(p, id) {
    if (this.mode === 'postgres') return (await this.pool.query('SELECT * FROM players WHERE platform=$1 AND player_id=$2', [p, id])).rows[0];
    return this.db.prepare('SELECT * FROM players WHERE platform=? AND player_id=?').get(p, id);
  }
}

const store = new Store();
await store.init();

function sendJson(res, code, data) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); }
async function ea(endpoint, params) { const u = new URL(BASE + endpoint); for (const [k,v] of Object.entries(params)) u.searchParams.set(k, String(v)); const r = await fetch(u, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 FC-Clubs-Global' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(`EA ${r.status}`); return r.json(); }
async function extractClubs(payload, p) { const out = [], seen = new Set(); const walk = (v,d=0) => { if (d>6 || v==null) return; if (Array.isArray(v)) { v.forEach(x=>walk(x,d+1)); return; } if (typeof v !== 'object') return; const id=v.clubId??v.club_id??v.id, name=v.clubName??v.name??v.club?.name; if (id&&name&&!seen.has(String(id))) { seen.add(String(id)); out.push({ id:String(id), name:String(name), skill:num(v.skillRating??v.skillrating??v.skill), wins:num(v.wins), draws:num(v.draws??v.ties), losses:num(v.losses), games:num(v.games??v.gamesPlayed), raw:v }); } Object.values(v).forEach(x=>{ if (x&&typeof x==='object') walk(x,d+1); }); }; walk(payload); for (const x of out) await store.upsertClub(x,p); return out; }
async function extractPlayers(payload,p,clubId,clubName) { const out=[],seen=new Set(); const walk=(v,d=0)=>{ if(d>6||v==null)return; if(Array.isArray(v)){v.forEach(x=>walk(x,d+1));return;} if(typeof v!=='object')return; const name=v.name??v.playerName??v.proName??v.eaId??v.playername,id=v.playerId??v.player_id??v.personaId??v.blazeId??name; if(name&&id&&!seen.has(String(id))){seen.add(String(id));out.push({id:String(id),name:String(name),games:num(v.games??v.gamesPlayed??v.appearances),goals:num(v.goals),assists:num(v.assists),rating:num(v.rating??v.averageRating??v.avgRating),raw:v});} Object.values(v).forEach(x=>{if(x&&typeof x==='object')walk(x,d+1)});}; walk(payload); for(const x of out)await store.upsertPlayer(x,p,clubId,clubName); return out; }

let running=false; let crawl={running:false,scanned:0,clubs:0,players:0,discovered:0,lastError:'',platform:'',prefix:'',storage:store.mode,persistent:store.persistent};
const chars='abcdefghijklmnopqrstuvwxyz0123456789'; const prefixes=[...chars,...[...chars].flatMap(a=>[...chars].map(b=>a+b))];
async function syncClub(row,p){let clubName=row.name||'';try{const info=await extractClubs(await ea('/clubs/info',{platform:p,clubIds:row.club_id}),p);clubName=info.find(x=>x.id===row.club_id)?.name||clubName;}catch(e){crawl.lastError=e.message;}for(const ep of ['/members/career/stats','/members/stats']){await sleep(Number(process.env.EA_REQUEST_GAP_MS||650));try{crawl.players+=(await extractPlayers(await ea(ep,{platform:p,clubId:row.club_id}),p,row.club_id,clubName)).length;}catch(e){crawl.lastError=e.message;}}await store.markSynced(p,row.club_id);}
async function runCrawler(){if(running)return;running=true;crawl={running:true,scanned:0,clubs:0,players:0,discovered:0,lastError:'',platform:'',prefix:'',storage:store.mode,persistent:store.persistent};try{for(const p of PLATFORMS){crawl.platform=p;for(const ep of ['/allTimeLeaderboard','/currentSeasonLeaderboard']){try{crawl.discovered+=(await extractClubs(await ea(ep,{platform:p,maxResultCount:100}),p)).length;}catch(e){crawl.lastError=e.message;}await sleep(Number(process.env.EA_REQUEST_GAP_MS||650));}let cursor=Number(await store.getMeta('cursor:'+p,0))||0;const batch=Math.max(10,Number(process.env.CRAWL_PREFIX_BATCH||35));for(let i=0;i<batch;i++){const prefix=prefixes[cursor%prefixes.length];crawl.prefix=prefix;for(const ep of ['/allTimeLeaderboard/search','/currentSeasonLeaderboard/search']){try{crawl.discovered+=(await extractClubs(await ea(ep,{platform:p,clubName:prefix,maxResultCount:50}),p)).length;}catch(e){crawl.lastError=e.message;}crawl.scanned++;await sleep(Number(process.env.EA_REQUEST_GAP_MS||650));}cursor=(cursor+1)%prefixes.length;await store.setMeta('cursor:'+p,cursor);}const clubs=await store.nextClubs(p,Math.max(15,Number(process.env.CRAWL_SYNC_BATCH||50)));for(const c of clubs){await syncClub(c,p);crawl.clubs++;}}}finally{crawl.running=false;crawl.platform='';crawl.prefix='';running=false;}}

const indexHtml=fs.readFileSync(path.join(DIR,'index.html'),'utf8');
const page=u=>{const p=Math.max(1,Number(u.searchParams.get('page')||1)),limit=Math.min(60,Math.max(12,Number(u.searchParams.get('limit')||30)));return{p,limit,offset:(p-1)*limit};};
const decorate=x=>({...x,platform_label:LABEL[x.platform]||x.platform});

const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://local');
  if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});return res.end(indexHtml);}
  if(u.pathname==='/api/health')return sendJson(res,200,{ok:true,version:'v3',game:'FC26',storage:store.mode,persistent:store.persistent});
  if(u.pathname==='/api/crawl')return sendJson(res,200,crawl);
  if(u.pathname==='/api/dashboard')return sendJson(res,200,await store.dashboard());
  if(u.pathname==='/api/search'){const q=norm(u.searchParams.get('q')),p=u.searchParams.get('platform')||'',r=await store.search(q,p);return sendJson(res,200,{clubs:r.clubs.map(decorate),players:r.players.map(decorate)});}
  if(u.pathname==='/api/clubs'){const q=norm(u.searchParams.get('q')),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'skill',pg=page(u),r=await store.listClubs({q,p,sort,limit:pg.limit,offset:pg.offset});return sendJson(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(decorate)});}
  if(u.pathname==='/api/players'){const q=norm(u.searchParams.get('q')),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'rating',pg=page(u),r=await store.listPlayers({q,p,sort,limit:pg.limit,offset:pg.offset});return sendJson(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(decorate)});}
  if(u.pathname==='/api/rankings'){const p=u.searchParams.get('platform')||'',m=u.searchParams.get('metric')||'goals';return sendJson(res,200,{metric:m,items:(await store.rankings(p,m)).map(decorate)});}
  if(u.pathname==='/api/club'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.club(p,id);if(!r.club)return sendJson(res,404,{error:'Club introuvable'});return sendJson(res,200,{club:decorate(r.club),players:r.players.map(decorate)});}
  if(u.pathname==='/api/player'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',x=await store.player(p,id);if(!x)return sendJson(res,404,{error:'Joueur introuvable'});return sendJson(res,200,{player:{...decorate(x),gpg:x.games?x.goals/x.games:0,apg:x.games?x.assists/x.games:0}});}
  return sendJson(res,404,{error:'not found'});
}catch(e){console.error(e);return sendJson(res,500,{error:e.message});}});

server.listen(PORT,HOST,()=>{console.log(`FC Clubs Global V3 on ${HOST}:${PORT} [${store.mode}]`);if(process.env.AUTO_MAX_CRAWL!=='0')setTimeout(runCrawler,1000);});
setInterval(()=>{if(!running)runCrawler();},Math.max(1,Number(process.env.AUTO_CRAWL_LOOP_HOURS||6))*3600000).unref();