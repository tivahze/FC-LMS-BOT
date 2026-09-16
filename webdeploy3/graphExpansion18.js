import {Store} from './store5.js';
import {syncClub} from './crawler5.js';
import {sleep,gap,num} from './constants.js';

const INTERVAL_MINUTES=Math.max(2,Number(process.env.GRAPH_EXPANSION_INTERVAL_MINUTES||3));
const BATCH=Math.max(3,Number(process.env.GRAPH_EXPANSION_BATCH||10));
const RESYNC_DAYS=Math.max(3,Number(process.env.GRAPH_EXPANSION_RESYNC_DAYS||21));
const state={running:false,lastRun:0,processed:0,playersBefore:0,playersAfter:0,clubsBefore:0,clubsAfter:0,lastError:''};
let schedulerStarted=false;

async function cycle(store){
  if(store.mode!=='postgres'||state.running)return;
  state.running=true;state.processed=0;state.lastError='';state.lastRun=Math.floor(Date.now()/1000);
  try{
    const before=await store.one(`SELECT (SELECT COUNT(*) FROM clubs) clubs,(SELECT COUNT(*) FROM players) players`);
    state.clubsBefore=num(before?.clubs);state.playersBefore=num(before?.players);
    const staleBefore=Math.floor(Date.now()/1000)-RESYNC_DAYS*86400;
    const rows=await store.q(`
      SELECT c.platform,c.club_id,c.name,COALESCE(c.synced_at,0) synced_at,
        COALESCE(w.last_viewed,0) last_viewed,
        COALESCE(MAX(m.ts),0) latest_match,
        (SELECT COUNT(*) FROM players p WHERE p.platform=c.platform AND p.club_id=c.club_id) player_count
      FROM clubs c
      LEFT JOIN watched_clubs w ON w.platform=c.platform AND w.club_id=c.club_id
      LEFT JOIN matches m ON m.platform=c.platform AND (m.home_club_id=c.club_id OR m.away_club_id=c.club_id)
      WHERE c.platform='common-gen5' AND (COALESCE(c.synced_at,0)=0 OR COALESCE(c.synced_at,0)<$1)
      GROUP BY c.platform,c.club_id,c.name,c.synced_at,w.last_viewed
      ORDER BY
        CASE WHEN (SELECT COUNT(*) FROM players p WHERE p.platform=c.platform AND p.club_id=c.club_id)=0 THEN 0 ELSE 1 END,
        COALESCE(MAX(m.ts),0) DESC,
        COALESCE(w.last_viewed,0) DESC,
        COALESCE(c.synced_at,0) ASC
      LIMIT $2`,[staleBefore,BATCH]);
    console.log(`[GRAPH18] cycle targets=${rows.length} clubs=${state.clubsBefore} players=${state.playersBefore}`);
    for(const row of rows){
      try{
        await syncClub(store,{club_id:String(row.club_id),name:row.name||''},row.platform);
        state.processed++;
      }catch(e){state.lastError=e.message;console.warn(`[GRAPH18] ${row.platform}|${row.club_id}: ${e.message}`)}
      await sleep(gap());
    }
    const after=await store.one(`SELECT (SELECT COUNT(*) FROM clubs) clubs,(SELECT COUNT(*) FROM players) players`);
    state.clubsAfter=num(after?.clubs);state.playersAfter=num(after?.players);
    console.log(`[GRAPH18] done processed=${state.processed} newClubs=${Math.max(0,state.clubsAfter-state.clubsBefore)} newPlayers=${Math.max(0,state.playersAfter-state.playersBefore)} totals=${state.clubsAfter}/${state.playersAfter}`);
  }finally{state.running=false}
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);
  if(this.mode!=='postgres')return;
  if(!schedulerStarted){
    schedulerStarted=true;
    console.log(`[GRAPH18] opponent/member expansion enabled batch=${BATCH} every=${INTERVAL_MINUTES}m`);
    setTimeout(()=>cycle(this).catch(e=>console.warn('[GRAPH18]',e.message)),30000).unref();
    setInterval(()=>cycle(this).catch(e=>console.warn('[GRAPH18]',e.message)),INTERVAL_MINUTES*60000).unref();
  }
};

const previousDashboard=Store.prototype.dashboard;
Store.prototype.dashboard=async function(){
  const d=await previousDashboard.call(this);
  return this.mode==='postgres'?{...d,graphExpansion:{...state,batch:BATCH,intervalMinutes:INTERVAL_MINUTES,resyncDays:RESYNC_DAYS}}:d;
};
