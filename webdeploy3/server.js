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
const DATA_DIR = process.env.DATA_DIR || '/tmp/fc-clubs-v4';
const BASE = 'https://proclubs.ea.com/api/fc';
const PLATFORMS = ['common-gen5','common-gen4','nx'];
const LABEL = {'common-gen5':'Current Gen','common-gen4':'Last Gen',nx:'Switch'};
const MATCH_TYPES = ['friendlyMatch','leagueMatch','playoffMatch'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const norm = s => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'');
const cuid = (p,id) => `FC26:${p}:${id}`;
const puid = (p,id) => `FC26:${p}:${id}`;
const muid = (p,id) => `FC26:${p}:${id}`;
const now = () => Math.floor(Date.now()/1000);
const gap = () => Number(process.env.EA_REQUEST_GAP_MS || 450);

class Store {
  constructor(){
    this.mode = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
    this.persistent = this.mode === 'postgres';
    if(this.mode==='postgres') this.pool = new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL_DISABLE==='1'?false:{rejectUnauthorized:false},max:8});
    else { fs.mkdirSync(DATA_DIR,{recursive:true}); this.db = new DatabaseSync(path.join(DATA_DIR,'fcclubs.db')); }
  }
  async init(){
    const schema = `
      CREATE TABLE IF NOT EXISTS clubs(uid TEXT PRIMARY KEY,platform TEXT,club_id TEXT,name TEXT,name_norm TEXT DEFAULT '',skill DOUBLE PRECISION DEFAULT 0,wins INTEGER DEFAULT 0,draws INTEGER DEFAULT 0,losses INTEGER DEFAULT 0,games INTEGER DEFAULT 0,updated_at BIGINT DEFAULT 0,synced_at BIGINT DEFAULT 0,raw_json TEXT);
      CREATE TABLE IF NOT EXISTS players(uid TEXT PRIMARY KEY,platform TEXT,player_id TEXT,name TEXT,name_norm TEXT DEFAULT '',club_id TEXT,club_name TEXT,games INTEGER DEFAULT 0,goals INTEGER DEFAULT 0,assists INTEGER DEFAULT 0,rating DOUBLE PRECISION DEFAULT 0,updated_at BIGINT DEFAULT 0,raw_json TEXT);
      CREATE TABLE IF NOT EXISTS matches(uid TEXT PRIMARY KEY,platform TEXT,match_id TEXT,match_type TEXT,ts BIGINT DEFAULT 0,home_club_id TEXT,home_name TEXT,home_goals INTEGER DEFAULT 0,away_club_id TEXT,away_name TEXT,away_goals INTEGER DEFAULT 0,raw_json TEXT);
      CREATE TABLE IF NOT EXISTS match_players(uid TEXT PRIMARY KEY,match_uid TEXT,platform TEXT,player_id TEXT,name TEXT,club_id TEXT,club_name TEXT,position TEXT,goals INTEGER DEFAULT 0,assists INTEGER DEFAULT 0,rating DOUBLE PRECISION DEFAULT 0,raw_json TEXT);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE INDEX IF NOT EXISTS clubs_name_idx ON clubs(name_norm); CREATE INDEX IF NOT EXISTS clubs_platform_idx ON clubs(platform); CREATE INDEX IF NOT EXISTS clubs_sync_idx ON clubs(synced_at);
      CREATE INDEX IF NOT EXISTS players_name_idx ON players(name_norm); CREATE INDEX IF NOT EXISTS players_club_idx ON players(platform,club_id); CREATE INDEX IF NOT EXISTS players_stats_idx ON players(goals,assists,rating,games);
      CREATE INDEX IF NOT EXISTS matches_ts_idx ON matches(ts); CREATE INDEX IF NOT EXISTS matches_clubs_idx ON matches(platform,home_club_id,away_club_id); CREATE INDEX IF NOT EXISTS mp_player_idx ON match_players(platform,player_id);
    `;
    if(this.mode==='postgres') await this.pool.query(schema);
    else this.db.exec('PRAGMA journal_mode=WAL;'+schema.replaceAll('DOUBLE PRECISION','REAL').replaceAll('BIGINT','INTEGER'));
  }
  async q(sql,params=[]){
    if(this.mode==='postgres') return (await this.pool.query(sql,params)).rows;
    const s = sql.replace(/\$(\d+)/g,'?');
    return this.db.prepare(s).all(...params);
  }
  async one(sql,params=[]){ const r=await this.q(sql,params); return r[0]; }
  async run(sql,params=[]){
    if(this.mode==='postgres') return this.pool.query(sql,params);
    const s=sql.replace(/\$(\d+)/g,'?'); return this.db.prepare(s).run(...params);
  }
  async upsertClub(x,p){
    const vals=[cuid(p,x.id),p,String(x.id),String(x.name||'Club inconnu'),norm(x.name),num(x.skill),num(x.wins),num(x.draws),num(x.losses),num(x.games),JSON.stringify(x.raw||x)];
    if(this.mode==='postgres') await this.pool.query(`INSERT INTO clubs(uid,platform,club_id,name,name_norm,skill,wins,draws,losses,games,updated_at,raw_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,EXTRACT(EPOCH FROM NOW())::BIGINT,$11) ON CONFLICT(uid) DO UPDATE SET name=EXCLUDED.name,name_norm=EXCLUDED.name_norm,skill=CASE WHEN EXCLUDED.skill>0 THEN EXCLUDED.skill ELSE clubs.skill END,wins=GREATEST(clubs.wins,EXCLUDED.wins),draws=GREATEST(clubs.draws,EXCLUDED.draws),losses=GREATEST(clubs.losses,EXCLUDED.losses),games=GREATEST(clubs.games,EXCLUDED.games),updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,raw_json=EXCLUDED.raw_json`,vals);
    else this.db.prepare(`INSERT INTO clubs(uid,platform,club_id,name,name_norm,skill,wins,draws,losses,games,updated_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,unixepoch(),?) ON CONFLICT(uid) DO UPDATE SET name=excluded.name,name_norm=excluded.name_norm,skill=CASE WHEN excluded.skill>0 THEN excluded.skill ELSE clubs.skill END,wins=MAX(clubs.wins,excluded.wins),draws=MAX(clubs.draws,excluded.draws),losses=MAX(clubs.losses,excluded.losses),games=MAX(clubs.games,excluded.games),updated_at=unixepoch(),raw_json=excluded.raw_json`).run(...vals);
  }
  async upsertPlayer(x,p,clubId='',clubName=''){
    const id=String(x.id||x.name); const vals=[puid(p,id),p,id,String(x.name||id),norm(x.name||id),String(clubId||''),String(clubName||''),num(x.games),num(x.goals),num(x.assists),num(x.rating),JSON.stringify(x.raw||x)];
    if(this.mode==='postgres') await this.pool.query(`INSERT INTO players(uid,platform,player_id,name,name_norm,club_id,club_name,games,goals,assists,rating,updated_at,raw_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,EXTRACT(EPOCH FROM NOW())::BIGINT,$12) ON CONFLICT(uid) DO UPDATE SET name=EXCLUDED.name,name_norm=EXCLUDED.name_norm,club_id=CASE WHEN EXCLUDED.club_id<>'' THEN EXCLUDED.club_id ELSE players.club_id END,club_name=CASE WHEN EXCLUDED.club_name<>'' THEN EXCLUDED.club_name ELSE players.club_name END,games=GREATEST(players.games,EXCLUDED.games),goals=GREATEST(players.goals,EXCLUDED.goals),assists=GREATEST(players.assists,EXCLUDED.assists),rating=CASE WHEN EXCLUDED.rating>0 THEN EXCLUDED.rating ELSE players.rating END,updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,raw_json=EXCLUDED.raw_json`,vals);
    else this.db.prepare(`INSERT INTO players(uid,platform,player_id,name,name_norm,club_id,club_name,games,goals,assists,rating,updated_at,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,unixepoch(),?) ON CONFLICT(uid) DO UPDATE SET name=excluded.name,name_norm=excluded.name_norm,club_id=CASE WHEN excluded.club_id<>'' THEN excluded.club_id ELSE players.club_id END,club_name=CASE WHEN excluded.club_name<>'' THEN excluded.club_name ELSE players.club_name END,games=MAX(players.games,excluded.games),goals=MAX(players.goals,excluded.goals),assists=MAX(players.assists,excluded.assists),rating=CASE WHEN excluded.rating>0 THEN excluded.rating ELSE players.rating END,updated_at=unixepoch(),raw_json=excluded.raw_json`).run(...vals);
  }
  async upsertMatch(m,p){
    const vals=[muid(p,m.id),p,String(m.id),m.type,num(m.ts),String(m.home?.id||''),m.home?.name||'',num(m.home?.goals),String(m.away?.id||''),m.away?.name||'',num(m.away?.goals),JSON.stringify(m.raw||m)];
    if(this.mode==='postgres') await this.pool.query(`INSERT INTO matches(uid,platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals,raw_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(uid) DO UPDATE SET match_type=EXCLUDED.match_type,ts=EXCLUDED.ts,home_club_id=EXCLUDED.home_club_id,home_name=EXCLUDED.home_name,home_goals=EXCLUDED.home_goals,away_club_id=EXCLUDED.away_club_id,away_name=EXCLUDED.away_name,away_goals=EXCLUDED.away_goals,raw_json=EXCLUDED.raw_json`,vals);
    else this.db.prepare(`INSERT INTO matches(uid,platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET match_type=excluded.match_type,ts=excluded.ts,home_club_id=excluded.home_club_id,home_name=excluded.home_name,home_goals=excluded.home_goals,away_club_id=excluded.away_club_id,away_name=excluded.away_name,away_goals=excluded.away_goals,raw_json=excluded.raw_json`).run(...vals);
    for(const x of m.players||[]){
      const id=String(x.id||x.name), u=`${muid(p,m.id)}:${id}:${x.clubId||''}`;
      const pv=[u,muid(p,m.id),p,id,x.name||id,String(x.clubId||''),x.clubName||'',x.position||'',num(x.goals),num(x.assists),num(x.rating),JSON.stringify(x.raw||x)];
      if(this.mode==='postgres') await this.pool.query(`INSERT INTO match_players(uid,match_uid,platform,player_id,name,club_id,club_name,position,goals,assists,rating,raw_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(uid) DO UPDATE SET position=EXCLUDED.position,goals=EXCLUDED.goals,assists=EXCLUDED.assists,rating=EXCLUDED.rating,raw_json=EXCLUDED.raw_json`,pv);
      else this.db.prepare(`INSERT INTO match_players(uid,match_uid,platform,player_id,name,club_id,club_name,position,goals,assists,rating,raw_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET position=excluded.position,goals=excluded.goals,assists=excluded.assists,rating=excluded.rating,raw_json=excluded.raw_json`).run(...pv);
    }
  }
  async getMeta(k,d='0'){return (await this.one('SELECT value FROM meta WHERE key=$1',[k]))?.value??d;}
  async setMeta(k,v){if(this.mode==='postgres')await this.pool.query('INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[k,String(v)]);else this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,String(v));}
  async markSynced(p,id){if(this.mode==='postgres')await this.pool.query('UPDATE clubs SET synced_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE platform=$1 AND club_id=$2',[p,id]);else this.db.prepare('UPDATE clubs SET synced_at=unixepoch() WHERE platform=? AND club_id=?').run(p,id);}
  async dashboard(){
    const a=await this.one('SELECT COUNT(*) c FROM clubs'),b=await this.one('SELECT COUNT(*) c FROM players'),c=await this.one('SELECT COUNT(*) c FROM matches'),d=await this.one('SELECT COUNT(DISTINCT platform) c FROM clubs');
    return {clubs:Number(a.c),players:Number(b.c),matches:Number(c.c),platforms:Number(d.c),storage:this.mode,persistent:this.persistent};
  }
  async search(q,p){
    const pat=`%${q}%`,pre=`${q}%`;
    if(this.mode==='postgres'){
      const clubs=await this.q(`SELECT platform,club_id,name,skill,wins,draws,losses,games FROM clubs WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3) ORDER BY CASE WHEN name_norm=$2 THEN 0 WHEN name_norm LIKE $4 THEN 1 ELSE 2 END,skill DESC LIMIT 30`,[p,q,pat,pre]);
      const players=await this.q(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating FROM players WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3) ORDER BY CASE WHEN name_norm=$2 THEN 0 WHEN name_norm LIKE $4 THEN 1 ELSE 2 END,games DESC,rating DESC LIMIT 30`,[p,q,pat,pre]); return {clubs,players};
    }
    const clubs=this.db.prepare("SELECT platform,club_id,name,skill,wins,draws,losses,games FROM clubs WHERE (?='' OR platform=?) AND (?='' OR name_norm LIKE ?) ORDER BY CASE WHEN name_norm=? THEN 0 WHEN name_norm LIKE ? THEN 1 ELSE 2 END,skill DESC LIMIT 30").all(p,p,q,pat,q,pre);
    const players=this.db.prepare("SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating FROM players WHERE (?='' OR platform=?) AND (?='' OR name_norm LIKE ?) ORDER BY CASE WHEN name_norm=? THEN 0 WHEN name_norm LIKE ? THEN 1 ELSE 2 END,games DESC,rating DESC LIMIT 30").all(p,p,q,pat,q,pre); return {clubs,players};
  }
  async paged(table,q,p,sort,page,limit){
    const offset=(page-1)*limit,pat=`%${q}%`;
    const orders=table==='clubs'?{skill:'skill DESC,games DESC',games:'games DESC,skill DESC',name:'name ASC',recent:'updated_at DESC',wins:'wins DESC'}:{rating:'rating DESC,games DESC',goals:'goals DESC,games DESC',assists:'assists DESC,games DESC',games:'games DESC,goals DESC',name:'name ASC',recent:'updated_at DESC'};
    const order=orders[sort]||Object.values(orders)[0];
    if(this.mode==='postgres'){
      const total=Number((await this.one(`SELECT COUNT(*) c FROM ${table} WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3)`,[p,q,pat])).c);
      const cols=table==='clubs'?'platform,club_id,name,skill,wins,draws,losses,games,updated_at':'platform,player_id,name,club_id,club_name,games,goals,assists,rating,updated_at';
      const items=await this.q(`SELECT ${cols} FROM ${table} WHERE ($1='' OR platform=$1) AND ($2='' OR name_norm LIKE $3) ORDER BY ${order} LIMIT $4 OFFSET $5`,[p,q,pat,limit,offset]); return {total,items};
    }
    const where="(?='' OR platform=?) AND (?='' OR name_norm LIKE ?)",cols=table==='clubs'?'platform,club_id,name,skill,wins,draws,losses,games,updated_at':'platform,player_id,name,club_id,club_name,games,goals,assists,rating,updated_at';
    const total=this.db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(p,p,q,pat).c; const items=this.db.prepare(`SELECT ${cols} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(p,p,q,pat,limit,offset); return {total,items};
  }
  async rankings(p,m){const metric=['goals','assists','rating','games'].includes(m)?m:'goals';if(this.mode==='postgres')return this.q(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating FROM players WHERE ($1='' OR platform=$1) AND games>0 ORDER BY ${metric} DESC,games DESC LIMIT 100`,[p]);return this.db.prepare(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating FROM players WHERE (?='' OR platform=?) AND games>0 ORDER BY ${metric} DESC,games DESC LIMIT 100`).all(p,p);}
  async club(p,id){const club=await this.one('SELECT * FROM clubs WHERE platform=$1 AND club_id=$2',[p,id]);if(!club)return null;const players=await this.q('SELECT platform,player_id,name,club_name,games,goals,assists,rating FROM players WHERE platform=$1 AND club_id=$2 ORDER BY games DESC,rating DESC LIMIT 150',[p,id]);const matches=await this.q('SELECT platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals FROM matches WHERE platform=$1 AND (home_club_id=$2 OR away_club_id=$2) ORDER BY ts DESC LIMIT 30',[p,id]);return {club,players,matches};}
  async player(p,id){const player=await this.one('SELECT * FROM players WHERE platform=$1 AND player_id=$2',[p,id]);if(!player)return null;const recent=await this.q(`SELECT mp.position,mp.goals,mp.assists,mp.rating,m.match_id,m.match_type,m.ts,m.home_name,m.home_goals,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.player_id=$2 ORDER BY m.ts DESC LIMIT 20`,[p,id]);return {player:{...player,gpg:num(player.games)?num(player.goals)/num(player.games):0,apg:num(player.games)?num(player.assists)/num(player.games):0},recent};}
  async recentMatches(p='',limit=40){if(this.mode==='postgres')return this.q(`SELECT platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals FROM matches WHERE ($1='' OR platform=$1) ORDER BY ts DESC LIMIT $2`,[p,limit]);return this.db.prepare(`SELECT platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals FROM matches WHERE (?='' OR platform=?) ORDER BY ts DESC LIMIT ?`).all(p,p,limit);}
  async overview(){
    const recentClubs=await this.q('SELECT platform,club_id,name,skill,games FROM clubs ORDER BY updated_at DESC LIMIT 8');
    const topPlayers=await this.q('SELECT platform,player_id,name,club_name,games,goals,assists,rating FROM players WHERE games>0 ORDER BY goals DESC,games DESC LIMIT 8');
    const matches=await this.recentMatches('',8); return {recentClubs,topPlayers,matches};
  }
}

const store=new Store(); await store.init();
async function ea(endpoint,params){const u=new URL(BASE+endpoint);for(const[k,v]of Object.entries(params))if(v!==undefined&&v!==null)u.searchParams.set(k,String(v));const r=await fetch(u,{headers:{accept:'application/json','accept-language':'fr-FR,fr;q=0.9,en;q=0.8','user-agent':'Mozilla/5.0 FC-Clubs-Global-V4','referer':'https://www.ea.com/'},signal:AbortSignal.timeout(18000)});if(!r.ok)throw new Error(`EA ${r.status}`);return r.json();}
async function extractClubs(payload,p){const out=[],seen=new Set();const walk=async(v,d=0)=>{if(d>7||v==null)return;if(Array.isArray(v)){for(const x of v)await walk(x,d+1);return}if(typeof v!=='object')return;const id=v.clubId??v.club_id??v.id??v.club?.clubId;const name=v.clubName??v.name??v.club?.name??v.details?.name;if(id&&name&&!seen.has(String(id))){seen.add(String(id));const x={id:String(id),name:String(name),skill:num(v.skillRating??v.skillrating??v.skill??v.skillRatingPoints),wins:num(v.wins),draws:num(v.draws??v.ties),losses:num(v.losses),games:num(v.games??v.gamesPlayed??v.totalGames),raw:v};out.push(x);await store.upsertClub(x,p)}for(const z of Object.values(v))if(z&&typeof z==='object')await walk(z,d+1)};await walk(payload);return out;}
async function extractPlayers(payload,p,clubId,clubName){const out=[],seen=new Set();const walk=async(v,d=0)=>{if(d>7||v==null)return;if(Array.isArray(v)){for(const x of v)await walk(x,d+1);return}if(typeof v!=='object')return;const name=v.name??v.playerName??v.proName??v.eaId??v.playername??v.displayName;const id=v.playerId??v.player_id??v.personaId??v.blazeId??v.persona_id??(name&&v.position!==undefined?name:null);const looks=name&&id&&(v.games!==undefined||v.gamesPlayed!==undefined||v.goals!==undefined||v.assists!==undefined||v.rating!==undefined||v.position!==undefined||v.proName!==undefined||v.eaId!==undefined);if(looks&&!seen.has(String(id))){seen.add(String(id));const x={id:String(id),name:String(name),games:num(v.games??v.gamesPlayed??v.appearances),goals:num(v.goals),assists:num(v.assists),rating:num(v.rating??v.averageRating??v.avgRating),raw:v};out.push(x);await store.upsertPlayer(x,p,clubId,clubName)}for(const z of Object.values(v))if(z&&typeof z==='object')await walk(z,d+1)};await walk(payload);return out;}
function normalizeMatches(payload,p,type){const arr=Array.isArray(payload)?payload:Object.values(payload||{}).filter(x=>x&&typeof x==='object');const out=[];for(const m of arr){if(!m||typeof m!=='object')continue;const id=String(m.matchId??m.match_id??m.id??m.timestamp??m.ts??`${type}-${Math.random()}`);const ts=num(m.timestamp??m.ts??m.time??m.matchTimestamp??m.date);const clubsObj=m.clubs??m.club??{};let clubs=[];if(Array.isArray(clubsObj))clubs=clubsObj;else if(clubsObj&&typeof clubsObj==='object')clubs=Object.entries(clubsObj).map(([key,c])=>({...c,_key:key}));if(clubs.length<2){const candidates=[];for(const v of Object.values(m))if(v&&typeof v==='object'&&(v.clubId||v.clubName||v.name)&&!Array.isArray(v))candidates.push(v);clubs=candidates.slice(0,2)}const mapClub=c=>({id:String(c.clubId??c.club_id??c.id??c._key??''),name:String(c.clubName??c.name??c.details?.name??c.club?.name??'Club'),goals:num(c.goals??c.score??c.result?.goals??c.clubDetails?.goals)});const home=mapClub(clubs[0]||{}),away=mapClub(clubs[1]||{}),players=[];for(const c of clubs){const cc=mapClub(c);const ps=c.players??c.members??c.playerStats??{};const list=Array.isArray(ps)?ps:Object.values(ps||{});for(const v of list){if(!v||typeof v!=='object')continue;const name=v.name??v.playerName??v.proName??v.eaId??v.playername;const pid=v.playerId??v.personaId??v.blazeId??v.id??name;if(name&&pid)players.push({id:String(pid),name:String(name),clubId:cc.id,clubName:cc.name,position:String(v.position??v.pos??''),goals:num(v.goals),assists:num(v.assists),rating:num(v.rating??v.averageRating??v.avgRating),raw:v})}}out.push({id,type,ts,home,away,players,raw:m})}return out;}

let running=false;let crawl={running:false,scanned:0,clubsSynced:0,playersRead:0,matchesRead:0,discovered:0,lastError:'',platform:'',prefix:'',started:0};
const chars='abcdefghijklmnopqrstuvwxyz0123456789';
const prefixes=[...chars,...[...chars].flatMap(a=>[...chars].map(b=>a+b))];
async function syncClub(row,p){let clubName=row.name||'';try{const info=await extractClubs(await ea('/clubs/info',{platform:p,clubIds:row.club_id}),p);clubName=info.find(x=>x.id===String(row.club_id))?.name||clubName}catch(e){crawl.lastError=e.message}for(const ep of ['/members/career/stats','/members/stats']){await sleep(gap());try{const x=await extractPlayers(await ea(ep,{platform:p,clubId:row.club_id}),p,String(row.club_id),clubName);crawl.playersRead+=x.length}catch(e){crawl.lastError=e.message}}for(const type of MATCH_TYPES){await sleep(gap());try{const payload=await ea('/clubs/matches',{platform:p,clubIds:row.club_id,matchType:type,maxResultCount:10});const ms=normalizeMatches(payload,p,type);for(const m of ms){for(const c of [m.home,m.away])if(c.id){await store.upsertClub({id:c.id,name:c.name,raw:c},p)}for(const x of m.players)await store.upsertPlayer({id:x.id,name:x.name,raw:x.raw},p,x.clubId,x.clubName);await store.upsertMatch(m,p)}crawl.matchesRead+=ms.length}catch(e){crawl.lastError=e.message}}await store.markSynced(p,String(row.club_id));}
async function runCrawler(){if(running)return;running=true;crawl={running:true,scanned:0,clubsSynced:0,playersRead:0,matchesRead:0,discovered:0,lastError:'',platform:'',prefix:'',started:now()};try{for(const p of PLATFORMS){crawl.platform=p;for(const ep of ['/allTimeLeaderboard','/currentSeasonLeaderboard']){try{crawl.discovered+=(await extractClubs(await ea(ep,{platform:p,maxResultCount:100}),p)).length}catch(e){crawl.lastError=e.message}await sleep(gap())}let cursor=Number(await store.getMeta('cursor:'+p,'0'))||0;const batch=Math.max(40,Number(process.env.CRAWL_PREFIX_BATCH||90));for(let i=0;i<batch;i++){const prefix=prefixes[cursor%prefixes.length];crawl.prefix=prefix;for(const ep of ['/allTimeLeaderboard/search','/currentSeasonLeaderboard/search']){try{crawl.discovered+=(await extractClubs(await ea(ep,{platform:p,clubName:prefix,maxResultCount:50}),p)).length}catch(e){crawl.lastError=e.message}crawl.scanned++;await sleep(gap())}cursor=(cursor+1)%prefixes.length;await store.setMeta('cursor:'+p,cursor)}const lim=Math.max(40,Number(process.env.CRAWL_SYNC_BATCH||100));const rows=await store.q(`SELECT club_id,name FROM clubs WHERE platform=$1 ORDER BY COALESCE(synced_at,0) ASC,updated_at DESC LIMIT $2`,[p,lim]);for(const c of rows){await syncClub(c,p);crawl.clubsSynced++}}}finally{crawl.running=false;crawl.platform='';crawl.prefix='';running=false;}}
async function liveDiscover(q,p=''){const plats=p?[p]:PLATFORMS;let found=0;for(const pl of plats){for(const ep of ['/allTimeLeaderboard/search','/currentSeasonLeaderboard/search']){try{const clubs=await extractClubs(await ea(ep,{platform:pl,clubName:q,maxResultCount:50}),pl);found+=clubs.length;for(const c of clubs.slice(0,5))await syncClub({club_id:c.id,name:c.name},pl)}catch(e){crawl.lastError=e.message}await sleep(gap())}}return found;}

const indexHtml=fs.readFileSync(path.join(DIR,'index.html'),'utf8');
const label=x=>({...x,platform_label:LABEL[x.platform]||x.platform});
const page=u=>{const p=Math.max(1,Number(u.searchParams.get('page')||1)),limit=Math.min(60,Math.max(12,Number(u.searchParams.get('limit')||30)));return {p,limit}};
function send(res,code,data){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://local');if(u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});return res.end(indexHtml)}if(u.pathname==='/api/health')return send(res,200,{ok:true,version:'v4',storage:store.mode});if(u.pathname==='/api/crawl')return send(res,200,crawl);if(u.pathname==='/api/dashboard')return send(res,200,await store.dashboard());if(u.pathname==='/api/overview'){const o=await store.overview();return send(res,200,{recentClubs:o.recentClubs.map(label),topPlayers:o.topPlayers.map(label),matches:o.matches.map(label)})}if(u.pathname==='/api/search'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'';const r=await store.search(q,p);return send(res,200,{clubs:r.clubs.map(label),players:r.players.map(label)})}if(u.pathname==='/api/discover'&&req.method==='POST'){const q=(u.searchParams.get('q')||'').trim(),p=u.searchParams.get('platform')||'';if(q.length<2)return send(res,400,{error:'2 caractères minimum'});const found=await liveDiscover(q,p);const r=await store.search(norm(q),p);return send(res,200,{found,clubs:r.clubs.map(label),players:r.players.map(label)})}if(u.pathname==='/api/clubs'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'skill',pg=page(u),r=await store.paged('clubs',q,p,sort,pg.p,pg.limit);return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label)})}if(u.pathname==='/api/players'){const q=norm(u.searchParams.get('q')||''),p=u.searchParams.get('platform')||'',sort=u.searchParams.get('sort')||'games',pg=page(u),r=await store.paged('players',q,p,sort,pg.p,pg.limit);return send(res,200,{page:pg.p,total:r.total,pages:Math.max(1,Math.ceil(r.total/pg.limit)),items:r.items.map(label)})}if(u.pathname==='/api/rankings'){const p=u.searchParams.get('platform')||'',m=u.searchParams.get('metric')||'goals';return send(res,200,{metric:m,items:(await store.rankings(p,m)).map(label)})}if(u.pathname==='/api/matches'){const p=u.searchParams.get('platform')||'';return send(res,200,{items:(await store.recentMatches(p,60)).map(label)})}if(u.pathname==='/api/club'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.club(p,id);if(!r)return send(res,404,{error:'Club introuvable'});return send(res,200,{club:label(r.club),players:r.players.map(label),matches:r.matches.map(label)})}if(u.pathname==='/api/player'){const p=u.searchParams.get('platform')||'',id=u.searchParams.get('id')||'',r=await store.player(p,id);if(!r)return send(res,404,{error:'Joueur introuvable'});return send(res,200,{player:label(r.player),recent:r.recent})}return send(res,404,{error:'not found'})}catch(e){console.error(e);return send(res,500,{error:e.message})}});
server.listen(PORT,HOST,()=>{console.log(`FC Clubs Global V4 on ${HOST}:${PORT} [${store.mode}]`);if(process.env.AUTO_MAX_CRAWL!=='0')setTimeout(runCrawler,1200)});
setInterval(()=>{if(!running)runCrawler()},Math.max(1,Number(process.env.AUTO_CRAWL_LOOP_HOURS||3))*3600000).unref();
