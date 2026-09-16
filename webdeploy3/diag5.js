import {Store} from './store5.js';
const prev=Store.prototype.init;
Store.prototype.init=async function(){
  await prev.call(this);
  if(this.mode!=='postgres')return;
  try{
    const p=await this.q(`SELECT platform,club_id,club_name,name_norm,COUNT(*)::int copies,
      JSON_AGG(JSON_BUILD_OBJECT('player_id',player_id,'name',name,'games',games,'goals',goals,'assists',assists,'rating',rating,'raw_len',LENGTH(COALESCE(raw_json,''))) ORDER BY games DESC,rating DESC) variants
      FROM players WHERE name_norm<>'' GROUP BY platform,club_id,club_name,name_norm HAVING COUNT(DISTINCT player_id)>1 ORDER BY COUNT(*) DESC,club_name,name_norm LIMIT 60`);
    console.log('[PLAYER-ID-DIAG] '+JSON.stringify(p));
    const c=await this.q(`SELECT platform,name_norm,COUNT(*)::int copies,
      JSON_AGG(JSON_BUILD_OBJECT('club_id',club_id,'name',name,'skill',skill,'games',games,'raw_len',LENGTH(COALESCE(raw_json,''))) ORDER BY games DESC,skill DESC) variants
      FROM clubs WHERE name_norm<>'' GROUP BY platform,name_norm HAVING COUNT(DISTINCT club_id)>1 ORDER BY COUNT(*) DESC,name_norm LIMIT 20`);
    console.log('[CLUB-ID-DIAG] '+JSON.stringify(c));
  }catch(e){console.warn('[DATA-DIAG]',e.message)}
};
