import {Store} from './store5.js';
import {ea,extractClubs,normalizeMatches} from './crawler5.js';
import {BASE,sleep,num} from './constants.js';

const PLATFORM='common-gen5';
const META_CURSOR='mass23:club_id_cursor';
const PRIORITY_CURSOR='priority:les-mannequins:id_cursor_fast2';
const DISCOVERY_BATCH=Math.max(300,Number(process.env.MASS23_DISCOVERY_BATCH||600));
const DISCOVERY_CONCURRENCY=Math.max(3,Number(process.env.MASS23_DISCOVERY_CONCURRENCY||6));
const HARVEST_BATCH=Math.max(8,Number(process.env.MASS23_HARVEST_BATCH||18));
const INTERVAL_MINUTES=Math.max(2,Number(process.env.MASS23_INTERVAL_MINUTES||3));
const REHARVEST_HOURS=Math.max(24,Number(process.env.MASS23_REHARVEST_HOURS||168));
const headers={accept:'application/json','accept-language':'fr-FR,fr;q=0.9,en;q=0.8','user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36',referer:'https://www.ea.com/'};
const state={running:false,cursor:0,probed:0,clubsFound:0,newClubs:0,harvested:0,matches:0,playerRows:0,newPlayers:0,lastClub:'',lastError:'',started:0,durationSec:0};
let running=false;

async function infoOnce(id){
  const u=new URL(BASE+'/clubs/info');
  u.searchParams.set('platform',PLATFORM);
  u.searchParams.set('clubIds',String(id));
  try{
    const r=await fetch(u,{headers,signal:AbortSignal.timeout(5000)});
    if(!r.ok)return null;
    return await r.json();
  }catch{return null}
}

async function seedCursor(store){
  const own=Number(await store.meta(META_CURSOR,'0'))||0;
  const priority=Number(await store.meta(PRIORITY_CURSOR,'0'))||0;
  let maxKnown=0;
  try{
    const r=await store.one(`SELECT COALESCE(MAX(club_id::bigint),0) max_id FROM clubs WHERE platform=$1 AND club_id ~ '^[0-9]+$'`,[PLATFORM]);
    maxKnown=Number(r?.max_id||0);
  }catch{}
  const cursor=Math.max(1,own,priority,maxKnown>0?maxKnown-250:1);
  return cursor;
}

async function discoverIds(store){
  let cursor=await seedCursor(store),start=cursor;
  const before=num((await store.one(`SELECT COUNT(*) c FROM clubs WHERE platform=$1`,[PLATFORM]))?.c);
  let found=0;
  console.log(`[MASS23] discovery start cursor=${cursor} batch=${DISCOVERY_BATCH} concurrency=${DISCOVERY_CONCURRENCY}`);
  for(let done=0;done<DISCOVERY_BATCH;done+=DISCOVERY_CONCURRENCY){
    const ids=Array.from({length:Math.min(DISCOVERY_CONCURRENCY,DISCOVERY_BATCH-done)},(_,i)=>cursor+i);
    const payloads=await Promise.all(ids.map(async id=>[id,await infoOnce(id)]));
    for(const[id,payload] of payloads){
      if(!payload)continue;
      try{
        const clubs=await extractClubs(store,payload,PLATFORM);
        if(clubs.length){
          found+=clubs.length;
          state.lastClub=clubs.map(c=>`${c.name}#${c.id}`).join(', ');
        }
      }catch(e){state.lastError=e.message;console.warn(`[MASS23] parse club ${id}: ${e.message}`)}
    }
    cursor+=ids.length;
    if(cursor-start>=100&&((cursor-start)%100)<DISCOVERY_CONCURRENCY){
      await store.setMeta(META_CURSOR,cursor);
      console.log(`[MASS23] discovery progress cursor=${cursor}`);
    }
    await sleep(140);
  }
  await store.setMeta(META_CURSOR,cursor);
  const after=num((await store.one(`SELECT COUNT(*) c FROM clubs WHERE platform=$1`,[PLATFORM]))?.c);
  state.cursor=cursor;state.probed=DISCOVERY_BATCH;state.clubsFound=found;state.newClubs=Math.max(0,after-before);
  console.log(`[MASS23] discovery done cursor=${cursor} payloadClubs=${found} clubs=${before}->${after}`);
}

async function savePrivateHistory(store,row){
  const payload=await ea('/clubs/matches',{platform:row.platform,clubIds:String(row.club_id),matchType:'friendlyMatch',maxResultCount:100});
  const matches=normalizeMatches(payload,'friendlyMatch');
  const playerKeys=new Set();
  for(const m of matches){
    for(const c of [m.home,m.away])if(c?.id&&c?.name)await store.upsertClub({id:String(c.id),name:String(c.name),raw:c},row.platform);
    for(const p of m.players||[]){
      if(!p?.id&&!p?.name)continue;
      playerKeys.add(`${p.clubId||''}|${p.id||p.name}`);
      await store.upsertPlayer({id:String(p.id||p.name),name:String(p.name||p.id),rating:p.rating,raw:p.raw},row.platform,p.clubId,p.clubName);
    }
    await store.upsertMatch(m,row.platform);
  }
  return{matches:matches.length,players:playerKeys.size};
}

async function markHarvest(store,row,result,stateName='done',error=''){
  await store.pool.query(`INSERT INTO private_harvest23(platform,club_id,last_run,matches,players,state,attempts,last_error)
    VALUES($1,$2,EXTRACT(EPOCH FROM NOW())::BIGINT,$3,$4,$5,1,$6)
    ON CONFLICT(platform,club_id) DO UPDATE SET last_run=EXCLUDED.last_run,matches=EXCLUDED.matches,players=EXCLUDED.players,state=EXCLUDED.state,attempts=private_harvest23.attempts+1,last_error=EXCLUDED.last_error`,
    [row.platform,String(row.club_id),num(result?.matches),num(result?.players),stateName,String(error||'').slice(0,300)]);
}

async function harvestPrivateMatches(store){
  const cutoff=Math.floor(Date.now()/1000)-REHARVEST_HOURS*3600;
  const rows=await store.q(`SELECT c.platform,c.club_id,c.name,COALESCE(h.last_run,0) last_run,COALESCE(h.state,'new') harvest_state
    FROM clubs c LEFT JOIN private_harvest23 h ON h.platform=c.platform AND h.club_id=c.club_id
    WHERE c.platform=$1 AND (h.club_id IS NULL OR h.last_run<$2 OR h.state='retry')
    ORDER BY CASE WHEN h.club_id IS NULL THEN 0 ELSE 1 END,c.updated_at DESC,COALESCE(h.last_run,0) ASC
    LIMIT $3`,[PLATFORM,cutoff,HARVEST_BATCH]);
  if(!rows.length)return;
  const beforePlayers=num((await store.one(`SELECT COUNT(*) c FROM players WHERE platform=$1`,[PLATFORM]))?.c);
  console.log(`[MASS23] private harvest start clubs=${rows.length}`);
  for(let i=0;i<rows.length;i+=2){
    const pair=rows.slice(i,i+2);
    await Promise.all(pair.map(async row=>{
      try{
        const result=await savePrivateHistory(store,row);
        await markHarvest(store,row,result,'done','');
        state.harvested++;state.matches+=result.matches;state.playerRows+=result.players;
        console.log(`[MASS23] private ${row.name||row.club_id}#${row.club_id} matches=${result.matches} playerRows=${result.players}`);
      }catch(e){
        state.lastError=e.message;
        await markHarvest(store,row,{matches:0,players:0},'retry',e.message);
        console.warn(`[MASS23] private ${row.club_id}: ${e.message}`);
      }
    }));
    await sleep(300);
  }
  const afterPlayers=num((await store.one(`SELECT COUNT(*) c FROM players WHERE platform=$1`,[PLATFORM]))?.c);
  state.newPlayers+=Math.max(0,afterPlayers-beforePlayers);
  console.log(`[MASS23] private harvest done players=${beforePlayers}->${afterPlayers} new=${Math.max(0,afterPlayers-beforePlayers)}`);
}

async function cycle(store){
  if(store.mode!=='postgres'||running)return;
  running=true;state.running=true;Object.assign(state,{probed:0,clubsFound:0,newClubs:0,harvested:0,matches:0,playerRows:0,newPlayers:0,lastError:'',started:Math.floor(Date.now()/1000)});
  try{
    await discoverIds(store);
    await harvestPrivateMatches(store);
  }catch(e){state.lastError=e.message;console.warn('[MASS23]',e.message)}finally{
    state.durationSec=Math.max(1,Math.floor(Date.now()/1000)-state.started);state.running=false;running=false;
    console.log(`[MASS23] cycle done cursor=${state.cursor} newClubs=${state.newClubs} harvested=${state.harvested} matches=${state.matches} newPlayers=${state.newPlayers} duration=${state.durationSec}s${state.lastError?' lastError='+state.lastError:''}`);
  }
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);
  if(this.mode!=='postgres')return;
  await this.pool.query(`CREATE TABLE IF NOT EXISTS private_harvest23(
    platform TEXT NOT NULL,club_id TEXT NOT NULL,last_run BIGINT DEFAULT 0,matches INTEGER DEFAULT 0,players INTEGER DEFAULT 0,
    state TEXT DEFAULT 'new',attempts INTEGER DEFAULT 0,last_error TEXT DEFAULT '',PRIMARY KEY(platform,club_id))`);
  await this.pool.query(`CREATE INDEX IF NOT EXISTS private_harvest23_run_idx ON private_harvest23(platform,state,last_run)`);
  const cursor=await seedCursor(this),q=await this.one(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE state='done') done,COALESCE(SUM(matches),0) matches,COALESCE(SUM(players),0) players FROM private_harvest23 WHERE platform=$1`,[PLATFORM]);
  console.log(`[MASS23] massive EA indexer ready cursor=${cursor} harvested=${num(q?.done)}/${num(q?.total)} archivedMatches=${num(q?.matches)} playerRows=${num(q?.players)} every=${INTERVAL_MINUTES}m`);
  setTimeout(()=>cycle(this),20000).unref();
  setInterval(()=>cycle(this),INTERVAL_MINUTES*60000).unref();
};

const previousDashboard=Store.prototype.dashboard;
Store.prototype.dashboard=async function(){
  const d=await previousDashboard.call(this);if(this.mode!=='postgres')return d;
  let q={total:0,done:0,retry:0,matches:0,players:0};
  try{q=await this.one(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE state='done') done,COUNT(*) FILTER(WHERE state='retry') retry,COALESCE(SUM(matches),0) matches,COALESCE(SUM(players),0) players FROM private_harvest23 WHERE platform=$1`,[PLATFORM])||q}catch(e){if(e?.code!=='42P01')console.warn('[MASS23 dashboard]',e.message)}
  return{...d,massIndexer:{...state,harvestTotal:num(q?.total),harvestDone:num(q?.done),harvestRetry:num(q?.retry),archiveMatches:num(q?.matches),archivePlayerRows:num(q?.players),intervalMinutes:INTERVAL_MINUTES,discoveryBatch:DISCOVERY_BATCH,harvestBatch:HARVEST_BATCH}};
};

console.log('[MASS23] massive club + private-match indexer enabled');