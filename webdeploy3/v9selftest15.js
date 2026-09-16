import {Store} from './store5.js';
setTimeout(async()=>{
  const s=new Store();
  try{
    await s.init();
    const live=await s.v9Live(3),records=await s.v9Records('');
    const m=await s.one(`SELECT platform,match_id FROM matches ORDER BY ts DESC LIMIT 1`);
    const detail=m?await s.v9Match(m.platform,m.match_id):null;
    const pair=await s.one(`SELECT platform,LEAST(home_club_id,away_club_id) a,GREATEST(home_club_id,away_club_id) b,COUNT(*) c FROM matches WHERE home_club_id<>'' AND away_club_id<>'' GROUP BY 1,2,3 HAVING COUNT(*)>1 ORDER BY c DESC LIMIT 1`);
    const h2h=pair?await s.v9H2H(pair.platform,pair.a,pair.b):null;
    const admin=await s.v9Admin();
    const clubsDesc=await s.paged('clubs','','','skill:desc',1,10),clubsAsc=await s.paged('clubs','','','skill:asc',1,10);
    const playersDesc=await s.v8Rankings('player','goals:desc','',0,1,10),playersAsc=await s.v8Rankings('player','goals:asc','',0,1,10);
    const cd=Number(clubsDesc.items?.[0]?.skill||0),ca=Number(clubsAsc.items?.[0]?.skill||0),pd=Number(playersDesc.items?.[0]?.goals||0),pa=Number(playersAsc.items?.[0]?.goals||0);
    if(cd<ca||pd<pa)throw new Error(`sorting check failed clubs ${cd}<${ca} players ${pd}<${pa}`);
    const filteredPlayers=await s.paged('players','','','games:desc|mg=1|mr=0|ad=90',1,10);
    const filteredClubs=await s.paged('clubs','','','skill:desc|mg=1|mw=0|ad=90',1,10);
    const recentPlayers=await s.v8Rankings('player','form10:desc','',1,1,10);
    const recentClubs=await s.v8Rankings('club','form10:desc','',1,1,10);
    console.log(`[V10-SELFTEST] ok filters=players:${filteredPlayers.total},clubs:${filteredClubs.total} recent=players:${recentPlayers.total},clubs:${recentClubs.total} matchSummary=${detail?.teamSummary?1:0} provenance=${detail?.provenance?1:0}`);
    console.log(`[V9-SELFTEST] ok live=${live.length} records=${records?.goalsMatch?1:0} match=${detail?.match?.match_id||'none'} players=${detail?.players?.length||0} h2h=${h2h?.summary?.games||0} sort=clubs:${cd}/${ca},players:${pd}/${pa} db=${admin?.size?.pretty||'unknown'}`);
  }catch(e){console.error('[V9-SELFTEST] FAILED',e.stack||e.message)}finally{try{if(s.mode==='postgres')await s.pool.end()}catch{}}
},5000).unref();
