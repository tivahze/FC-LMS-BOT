import {Store} from './store5.js';
import {ea,normalizeMatches} from './crawler5.js';
import {MATCH_TYPES,sleep,gap,num} from './constants.js';

const POLL_MINUTES=Math.max(5,Number(process.env.HISTORY_POLL_MINUTES||10));
const POLL_BATCH=Math.max(5,Number(process.env.HISTORY_POLL_BATCH||30));
const active=new Set();

async function saveMatches(store,platform,clubId,clubName,type){
  const payload=await ea('/clubs/matches',{platform,clubIds:String(clubId),matchType:type,maxResultCount:10});
  const matches=normalizeMatches(payload,type);
  for(const m of matches){
    for(const c of [m.home,m.away]){
      if(String(c.id)===String(clubId)&&!c.name)c.name=clubName||'';
      if(c.id&&c.name&&!/^club\s*#?\d*$/i.test(String(c.name).trim()))await store.upsertClub({id:c.id,name:c.name,raw:c},platform);
    }
    for(const x of m.players||[])await store.upsertPlayer({id:x.id,name:x.name,rating:x.rating,raw:x.raw},platform,x.clubId,x.clubName);
    await store.upsertMatch(m,platform);
  }
  return matches.length;
}

async function pollOne(store,row){
  const key=`${row.platform}|${row.club_id}`;
  if(active.has(key))return 0;
  active.add(key);
  let total=0;
  try{
    for(const type of MATCH_TYPES){
      try{total+=await saveMatches(store,row.platform,row.club_id,row.name,type)}catch(e){console.warn(`[HISTORY] ${key}/${type}: ${e.message}`)}
      await sleep(gap());
    }
    if(store.mode==='postgres')await store.pool.query('UPDATE watched_clubs SET last_polled=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE platform=$1 AND club_id=$2',[row.platform,String(row.club_id)]);
    console.log(`[HISTORY] ${key} fetched=${total}`);
  }finally{active.delete(key)}
  return total;
}

async function pollWatched(store){
  if(store.mode!=='postgres')return;
  const rows=await store.q(`SELECT platform,club_id,name,last_viewed,last_polled FROM watched_clubs WHERE last_viewed>EXTRACT(EPOCH FROM NOW())::BIGINT-604800 ORDER BY COALESCE(last_polled,0) ASC,last_viewed DESC LIMIT $1`,[POLL_BATCH]);
  for(const row of rows){await pollOne(store,row);await sleep(gap())}
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);
  if(this.mode!=='postgres')return;
  await this.pool.query(`CREATE TABLE IF NOT EXISTS watched_clubs(platform TEXT NOT NULL,club_id TEXT NOT NULL,name TEXT DEFAULT '',last_viewed BIGINT DEFAULT 0,last_polled BIGINT DEFAULT 0,PRIMARY KEY(platform,club_id));CREATE INDEX IF NOT EXISTS watched_clubs_poll_idx ON watched_clubs(last_polled,last_viewed);`);
  setTimeout(()=>pollWatched(this).catch(e=>console.warn('[HISTORY]',e.message)),15000).unref();
  setInterval(()=>pollWatched(this).catch(e=>console.warn('[HISTORY]',e.message)),POLL_MINUTES*60000).unref();
};

const previousClubAdvanced=Store.prototype.clubAdvanced;
Store.prototype.clubAdvanced=async function(platform,id){
  let result=await previousClubAdvanced.call(this,platform,id);
  if(!result||this.mode!=='postgres')return result;
  const name=String(result.club?.name||'');
  await this.pool.query(`INSERT INTO watched_clubs(platform,club_id,name,last_viewed,last_polled) VALUES($1,$2,$3,EXTRACT(EPOCH FROM NOW())::BIGINT,0) ON CONFLICT(platform,club_id) DO UPDATE SET name=EXCLUDED.name,last_viewed=EXCLUDED.last_viewed`,[platform,String(id),name]);
  const watch=await this.one('SELECT last_polled FROM watched_clubs WHERE platform=$1 AND club_id=$2',[platform,String(id)]);
  if(!num(watch?.last_polled)||num(watch.last_polled)<Math.floor(Date.now()/1000)-POLL_MINUTES*60){
    await pollOne(this,{platform,club_id:String(id),name});
    result=await previousClubAdvanced.call(this,platform,id);
  }
  const meta=await this.one(`SELECT COUNT(*) c,MIN(ts) oldest,MAX(ts) newest FROM matches WHERE platform=$1 AND(home_club_id=$2 OR away_club_id=$2)`,[platform,String(id)]);
  result.history={tracking:true,pollMinutes:POLL_MINUTES,archivedCount:num(meta?.c),oldest:num(meta?.oldest),newest:num(meta?.newest),eaWindowPerType:10};
  return result;
};
