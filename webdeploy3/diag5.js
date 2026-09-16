import {Store} from './store5.js';
const prev=Store.prototype.init;
Store.prototype.init=async function(){
  await prev.call(this);
  if(this.mode!=='postgres')return;
  try{
    const rows=await this.q(`SELECT platform,LOWER(TRIM(COALESCE(match_type,''))) match_type,
      LEAST(LOWER(TRIM(home_name))||':'||home_goals,LOWER(TRIM(away_name))||':'||away_goals) side_a,
      GREATEST(LOWER(TRIM(home_name))||':'||home_goals,LOWER(TRIM(away_name))||':'||away_goals) side_b,
      COUNT(*)::int copies,
      JSON_AGG(JSON_BUILD_OBJECT('uid',uid,'match_id',match_id,'ts',ts,'played_utc',TO_CHAR(TO_TIMESTAMP(ts) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'),'played_paris',TO_CHAR(TO_TIMESTAMP(ts) AT TIME ZONE 'Europe/Paris','YYYY-MM-DD HH24:MI:SS'),'home_id',home_club_id,'home',home_name,'hg',home_goals,'away_id',away_club_id,'away',away_name,'ag',away_goals) ORDER BY ts DESC) examples
      FROM matches
      GROUP BY platform,LOWER(TRIM(COALESCE(match_type,''))),LEAST(LOWER(TRIM(home_name))||':'||home_goals,LOWER(TRIM(away_name))||':'||away_goals),GREATEST(LOWER(TRIM(home_name))||':'||home_goals,LOWER(TRIM(away_name))||':'||away_goals)
      HAVING COUNT(*)>1 ORDER BY COUNT(*) DESC LIMIT 20`);
    console.log('[MATCH-DIAG] '+JSON.stringify(rows));
  }catch(e){console.warn('[MATCH-DIAG]',e.message)}
};
