import {Store} from './store5.js';
import {normalizeMatches} from './crawler5.js';

async function backfillArchivedMatchPlayers(store){
  try{
    const rows=await store.q(`SELECT m.uid,m.platform,m.match_id,m.match_type,m.ts,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals,m.raw_json
      FROM matches m
      WHERE NOT EXISTS(SELECT 1 FROM match_players mp WHERE mp.match_uid=m.uid)
      ORDER BY m.ts DESC LIMIT 10000`);
    let parsed=0,added=0,playersAdded=0;
    for(const row of rows){
      let raw;try{raw=JSON.parse(row.raw_json||'{}')}catch{continue}
      const list=normalizeMatches([raw],row.match_type||'leagueMatch');
      if(!list.length)continue;
      const m=list[0];
      m.id=String(row.match_id);m.ts=Number(row.ts||m.ts||0);m.type=row.match_type||m.type;
      if(!m.home?.id)m.home={id:String(row.home_club_id||''),name:row.home_name||'',goals:Number(row.home_goals||0)};
      if(!m.away?.id)m.away={id:String(row.away_club_id||''),name:row.away_name||'',goals:Number(row.away_goals||0)};
      for(const x of m.players||[]){await store.upsertPlayer({id:x.id,name:x.name,rating:x.rating,raw:x.raw},row.platform,x.clubId,x.clubName);playersAdded++}
      await store.upsertMatch(m,row.platform);parsed++;added+=(m.players||[]).length;
    }
    const total=await store.one('SELECT COUNT(*) c FROM match_players');
    console.log(`[DB-BACKFILL] archivedMatches=${rows.length} parsed=${parsed} appearancesAdded=${added} playerRowsTouched=${playersAdded} totalAppearances=${total?.c||0}`);
  }catch(e){console.warn('[DB-BACKFILL] skipped:',e.message)}
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){await previousInit.call(this);if(this.mode==='postgres')await backfillArchivedMatchPlayers(this)};
