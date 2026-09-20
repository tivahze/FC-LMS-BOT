import {Store} from './store5.js';
import {ea,extractClubs,extractPlayers,normalizeMatches} from './crawler5.js';
import {MATCH_TYPES,sleep,gap,num} from './constants.js';

const PLATFORM='common-gen5';
const LOOP_SECONDS=Math.max(15,Number(process.env.LIVE27_LOOP_SECONDS||20));
const BATCH=Math.max(2,Number(process.env.LIVE27_BATCH||5));
const HOT_SECONDS=Math.max(15,Number(process.env.LIVE27_HOT_SECONDS||20));
const WARM_SECONDS=Math.max(45,Number(process.env.LIVE27_WARM_SECONDS||60));
const ACTIVE_SECONDS=Math.max(120,Number(process.env.LIVE27_ACTIVE_SECONDS||180));
const COLD_SECONDS=Math.max(900,Number(process.env.LIVE27_COLD_SECONDS||1800));
const HOT_WINDOW=Math.max(600,Number(process.env.LIVE27_HOT_WINDOW_SECONDS||1800));
const WARM_WINDOW=Math.max(3600,Number(process.env.LIVE27_WARM_WINDOW_SECONDS||21600));
const ACTIVE_WINDOW=Math.max(21600,Number(process.env.LIVE27_ACTIVE_WINDOW_SECONDS||86400));
const ROSTER_REFRESH_SECONDS=Math.max(900,Number(process.env.LIVE27_ROSTER_REFRESH_SECONDS||21600));
const LEADERBOARD_SECONDS=Math.max(60,Number(process.env.LIVE27_LEADERBOARD_SECONDS||120));
const MATCH_FETCH_COUNT=Math.min(20,Math.max(5,Number(process.env.LIVE27_MATCH_FETCH_COUNT||10)));

const state={running:false,cycles:0,polled:0,newMatches:0,newClubs:0,rosters:0,errors:0,lastError:'',lastClub:'',lastType:'',lastLeaderboard:0,started:0};
let running=false;

const validEaId=id=>/^\d+$/.test(String(id||''));

async function ensure(store,platform,id,name=''){
  if(store.mode!=='postgres'||platform!==PLATFORM||!validEaId(id))return;
  await store.pool.query(`INSERT INTO live_index27(platform,club_id,name,last_poll,latest_match,last_new_match,next_type,last_roster,state,errors,last_error)
    VALUES($1,$2,$3,0,0,0,0,0,'new',0,'')
    ON CONFLICT(platform,club_id) DO UPDATE SET name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE live_index27.name END`,
    [platform,String(id),String(name||'')]);
}

function intervalFor(row,now){
  const latest=num(row.latest_match),viewed=num(row.last_viewed);
  const signal=Math.max(latest,viewed);
  if(signal>=now-HOT_WINDOW)return HOT_SECONDS;
  if(signal>=now-WARM_WINDOW)return WARM_SECONDS;
  if(signal>=now-ACTIVE_WINDOW)return ACTIVE_SECONDS;
  return COLD_SECONDS;
}
function stateFor(latest,viewed,now){
  const signal=Math.max(num(latest),num(viewed));
  if(signal>=now-HOT_WINDOW)return'hot';
  if(signal>=now-WARM_WINDOW)return'warm';
  if(signal>=now-ACTIVE_WINDOW)return'active';
  return'cold';
}

async function saveRoster(store,row){
  if(!validEaId(row.club_id))return 0;
  const payload=await ea('/members/career/stats',{platform:row.platform,clubId:String(row.club_id)});
  return (await extractPlayers(store,payload,row.platform,String(row.club_id),row.name||'')).length;
}

async function pollOne(store,row){
  const now=Math.floor(Date.now()/1000),type=MATCH_TYPES[num(row.next_type)%MATCH_TYPES.length];
  state.lastClub=`${row.name||row.club_id}#${row.club_id}`;state.lastType=type;
  try{
    const payload=await ea('/clubs/matches',{platform:row.platform,clubIds:String(row.club_id),matchType:type,maxResultCount:MATCH_FETCH_COUNT});
    const matches=normalizeMatches(payload,type);
    let latest=num(row.latest_match),newMatches=0,newClubs=0;
    const beforeClubs=num((await store.one('SELECT COUNT(*) c FROM clubs WHERE platform=$1',[PLATFORM]))?.c);

    for(const m of matches){
      latest=Math.max(latest,num(m.ts));
      const exists=await store.one('SELECT 1 ok FROM matches WHERE platform=$1 AND match_id=$2 LIMIT 1',[row.platform,String(m.id)]);
      if(!exists)newMatches++;
      for(const c of [m.home,m.away]){
        if(c?.id&&c?.name&&validEaId(c.id)){
          await store.upsertClub({id:String(c.id),name:String(c.name),raw:c},row.platform);
          await ensure(store,row.platform,c.id,c.name);
        }
      }
      for(const p of m.players||[])await store.upsertPlayer({id:String(p.id||p.name),name:String(p.name||p.id),rating:p.rating,raw:p.raw},row.platform,p.clubId,p.clubName);
      await store.upsertMatch(m,row.platform);
    }

    const afterClubs=num((await store.one('SELECT COUNT(*) c FROM clubs WHERE platform=$1',[PLATFORM]))?.c);
    newClubs=Math.max(0,afterClubs-beforeClubs);

    let roster=0;
    if(newMatches>0 && (!num(row.last_roster)||num(row.last_roster)<now-ROSTER_REFRESH_SECONDS)){
      try{roster=await saveRoster(store,row)}catch(e){console.warn(`[LIVE27] roster ${row.club_id}: ${e.message}`)}
    }

    const currentState=stateFor(latest,row.last_viewed,now);
    await store.pool.query(`UPDATE live_index27 SET last_poll=$1,latest_match=GREATEST(latest_match,$2),
      last_new_match=CASE WHEN $3>0 THEN $1 ELSE last_new_match END,next_type=$4,
      last_roster=CASE WHEN $5>0 THEN $1 ELSE last_roster END,state=$6,errors=0,last_error=''
      WHERE platform=$7 AND club_id=$8`,
      [now,latest,newMatches,(num(row.next_type)+1)%MATCH_TYPES.length,roster,currentState,row.platform,String(row.club_id)]);

    state.polled++;state.newMatches+=newMatches;state.newClubs+=newClubs;if(roster)state.rosters+=roster;
    if(newMatches||newClubs)console.log(`[LIVE27] ${state.lastClub} type=${type} fetched=${matches.length} newMatches=${newMatches} newClubs=${newClubs} roster=${roster} state=${currentState}`);
  }catch(e){
    state.errors++;state.lastError=e.message;
    await store.pool.query(`UPDATE live_index27 SET last_poll=$1,errors=errors+1,last_error=$2,state=CASE WHEN errors>=4 THEN 'cooldown' ELSE state END,next_type=$3 WHERE platform=$4 AND club_id=$5`,
      [now,String(e.message||'').slice(0,250),(num(row.next_type)+1)%MATCH_TYPES.length,row.platform,String(row.club_id)]);
    if(/EA 403|EA 429/.test(String(e.message)))await sleep(3000);
  }
}

async function refreshLeaderboard(store){
  const now=Math.floor(Date.now()/1000);if(state.lastLeaderboard&&state.lastLeaderboard>now-LEADERBOARD_SECONDS)return;
  try{
    const before=num((await store.one('SELECT COUNT(*) c FROM clubs WHERE platform=$1',[PLATFORM]))?.c);
    const clubs=await extractClubs(store,await ea('/currentSeasonLeaderboard',{platform:PLATFORM,maxResultCount:100}),PLATFORM);
    for(const c of clubs)await ensure(store,PLATFORM,c.id,c.name||'');
    const after=num((await store.one('SELECT COUNT(*) c FROM clubs WHERE platform=$1',[PLATFORM]))?.c);
    state.newClubs+=Math.max(0,after-before);state.lastLeaderboard=now;
  }catch(e){state.lastError=e.message}
}

async function nextRows(store){
  const now=Math.floor(Date.now()/1000);
  const rows=await store.q(`SELECT l.*,COALESCE(w.last_viewed,0) last_viewed
    FROM live_index27 l LEFT JOIN watched_clubs w ON w.platform=l.platform AND w.club_id=l.club_id
    WHERE l.platform=$1 AND l.club_id ~ '^[0-9]+$'
    ORDER BY
      CASE WHEN GREATEST(l.latest_match,COALESCE(w.last_viewed,0)) >= $2 THEN 0
           WHEN GREATEST(l.latest_match,COALESCE(w.last_viewed,0)) >= $3 THEN 1
           WHEN l.last_poll=0 THEN 2
           WHEN GREATEST(l.latest_match,COALESCE(w.last_viewed,0)) >= $4 THEN 3 ELSE 4 END,
      l.last_poll ASC
    LIMIT $5`,[PLATFORM,now-HOT_WINDOW,now-WARM_WINDOW,now-ACTIVE_WINDOW,Math.max(BATCH*8,40)]);
  return rows.filter(r=>num(r.last_poll)<=now-intervalFor(r,now)).slice(0,BATCH);
}

async function cycle(store){
  if(store.mode!=='postgres'||running)return;
  running=true;state.running=true;state.started=Math.floor(Date.now()/1000);state.cycles++;
  try{
    await refreshLeaderboard(store);
    const rows=await nextRows(store);
    for(const row of rows){await pollOne(store,row);await sleep(Math.max(350,gap()))}
  }catch(e){state.errors++;state.lastError=e.message;console.warn('[LIVE27]',e.message)}
  finally{state.running=false;running=false}
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);if(this.mode!=='postgres')return;
  await this.pool.query(`CREATE TABLE IF NOT EXISTS live_index27(
    platform TEXT NOT NULL,club_id TEXT NOT NULL,name TEXT DEFAULT '',last_poll BIGINT DEFAULT 0,latest_match BIGINT DEFAULT 0,
    last_new_match BIGINT DEFAULT 0,next_type INTEGER DEFAULT 0,last_roster BIGINT DEFAULT 0,state TEXT DEFAULT 'new',
    errors INTEGER DEFAULT 0,last_error TEXT DEFAULT '',PRIMARY KEY(platform,club_id));
    CREATE INDEX IF NOT EXISTS live_index27_due_idx ON live_index27(platform,last_poll,latest_match,state);`);
  const seedLive=()=>this.pool.query(`INSERT INTO live_index27(platform,club_id,name,last_poll,latest_match,last_new_match,next_type,last_roster,state,errors,last_error)
    SELECT platform,club_id,name,0,COALESCE((SELECT MAX(ts) FROM matches m WHERE m.platform=c.platform AND (m.home_club_id=c.club_id OR m.away_club_id=c.club_id)),0),0,0,0,'new',0,''
    FROM clubs c WHERE platform=$1 AND club_id ~ '^[0-9]+$'
    ON CONFLICT(platform,club_id) DO UPDATE SET name=EXCLUDED.name`,[PLATFORM].then(()=>console.log('[LIVE27] background full seed complete')).catch(e=>console.warn('[LIVE27] background seed:',e.message));
  setTimeout(seedLive,1200).unref();
  const q=await this.one(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE state='hot') hot,COUNT(*) FILTER(WHERE last_poll>0) polled FROM live_index27 WHERE platform=$1`,[PLATFORM]);
  console.log(`[LIVE27] adaptive live indexer ready immediately clubs=${num(q?.total)} polled=${num(q?.polled)} hot=${num(q?.hot)} loop=${LOOP_SECONDS}s batch=${BATCH}; full seed background`);
  setTimeout(()=>cycle(this),7000).unref();
  setInterval(()=>cycle(this),LOOP_SECONDS*1000).unref();
};

const previousUpsertClub=Store.prototype.upsertClub;
Store.prototype.upsertClub=async function(x,platform){
  await previousUpsertClub.call(this,x,platform);
  if(x?.id)await ensure(this,platform,x.id,x.name||'');
};

const previousDashboard=Store.prototype.dashboard;
Store.prototype.dashboard=async function(){
  const d=await previousDashboard.call(this);if(this.mode!=='postgres')return d;
  let q={total:0,hot:0,warm:0,active:0,cold:0,polled:0};
  try{q=await this.one(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE state='hot') hot,COUNT(*) FILTER(WHERE state='warm') warm,COUNT(*) FILTER(WHERE state='active') active,COUNT(*) FILTER(WHERE state IN('cold','cooldown','new')) cold,COUNT(*) FILTER(WHERE last_poll>0) polled FROM live_index27 WHERE platform=$1`,[PLATFORM])||q}catch(e){if(e?.code!=='42P01')console.warn('[LIVE27 dashboard]',e.message)}
  return{...d,live27:{...state,total:num(q.total),hot:num(q.hot),warm:num(q.warm),active:num(q.active),cold:num(q.cold),polledTotal:num(q.polled),loopSeconds:LOOP_SECONDS,batch:BATCH,hotSeconds:HOT_SECONDS,warmSeconds:WARM_SECONDS,activeSeconds:ACTIVE_SECONDS,coldSeconds:COLD_SECONDS}};
};

console.log('[LIVE27] FC27 live match indexer enabled');
