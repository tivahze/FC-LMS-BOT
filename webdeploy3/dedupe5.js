import {Store,estimateFormation} from './store5.js';
import {num,norm,roleBucket} from './constants.js';

const DAY=86400;
const clubKey=(name,id)=>norm(name)||`id${norm(id)}`;
const matchType=m=>String(m.match_type??m.type??'').trim().toLowerCase();
const side=(name,id,goals)=>`${clubKey(name,id)}:${num(goals)}`;
function fingerprint(m){
  const a=side(m.home_name??m.home?.name,m.home_club_id??m.home?.id,m.home_goals??m.home?.goals);
  const b=side(m.away_name??m.away?.name,m.away_club_id??m.away?.id,m.away_goals??m.away?.goals);
  const ts=num(m.ts),day=ts>0?Math.floor(ts/DAY):'0';
  return `${m.platform||''}|${matchType(m)}|${day}|${[a,b].sort().join('|')}`;
}
function dedupeMatches(rows){
  const seen=new Set(),out=[];
  for(const m of rows||[]){const k=fingerprint(m);if(seen.has(k))continue;seen.add(k);out.push(m)}
  return out;
}
function perspective(m,id){
  const home=String(m.home_club_id)===String(id)||clubKey(m.home_name,m.home_club_id)===clubKey('',id);
  const gf=home?num(m.home_goals):num(m.away_goals),ga=home?num(m.away_goals):num(m.home_goals);
  return {...m,gf,ga,gd:gf-ga,result:gf>ga?'V':gf<ga?'D':'N',opponent:home?m.away_name:m.home_name,opponent_id:home?m.away_club_id:m.home_club_id};
}
function uniqueOpponents(matches,id){
  const map=new Map();
  for(const m of matches){
    const x=perspective(m,id),key=clubKey(x.opponent,x.opponent_id);if(!key)continue;
    let o=map.get(key);
    if(!o){o={name:x.opponent,id:x.opponent_id,score:`${x.gf}-${x.ga}`,result:x.result,ts:x.ts,type:x.match_type,meetings:0,wins:0,draws:0,losses:0};map.set(key,o)}
    o.meetings++;if(x.result==='V')o.wins++;else if(x.result==='N')o.draws++;else o.losses++;
  }
  return [...map.values()].slice(0,10);
}
function dedupeRoster(players){
  const byName=new Map(),out=[];
  for(const p of players||[]){
    const k=norm(p.name);if(!k){out.push(p);continue}
    const old=byName.get(k);
    if(!old){byName.set(k,p);out.push(p);continue}
    const score=x=>num(x.recent_apps)*100000+num(x.games)*100+num(x.rating)*10+(String(x.player_id||'')!==String(x.name||'')?1:0);
    if(score(p)>score(old)){const i=out.indexOf(old);if(i>=0)out[i]=p;byName.set(k,p)}
  }
  return out;
}

async function repairPostgres(store){
  const c=await store.pool.connect();
  try{
    await c.query('BEGIN');
    const before=(await c.query('SELECT (SELECT COUNT(*) FROM clubs)::bigint clubs,(SELECT COUNT(*) FROM players)::bigint players,(SELECT COUNT(*) FROM matches)::bigint matches,(SELECT COUNT(*) FROM match_players)::bigint appearances')).rows[0];
    await c.query('DROP TABLE IF EXISTS _fc_dup_matches');
    await c.query(`CREATE TEMP TABLE _fc_dup_matches ON COMMIT DROP AS
      WITH k AS(
        SELECT uid,
          ROW_NUMBER() OVER(PARTITION BY
            platform,
            LOWER(TRIM(COALESCE(match_type,''))),
            CASE WHEN ts>0 THEN FLOOR(ts/86400.0)::bigint ELSE 0 END,
            LEAST(
              LOWER(REGEXP_REPLACE(COALESCE(NULLIF(TRIM(home_name),''),home_club_id,''),'[^a-zA-Z0-9]','','g'))||':'||home_goals,
              LOWER(REGEXP_REPLACE(COALESCE(NULLIF(TRIM(away_name),''),away_club_id,''),'[^a-zA-Z0-9]','','g'))||':'||away_goals
            ),
            GREATEST(
              LOWER(REGEXP_REPLACE(COALESCE(NULLIF(TRIM(home_name),''),home_club_id,''),'[^a-zA-Z0-9]','','g'))||':'||home_goals,
              LOWER(REGEXP_REPLACE(COALESCE(NULLIF(TRIM(away_name),''),away_club_id,''),'[^a-zA-Z0-9]','','g'))||':'||away_goals
            )
          ORDER BY LENGTH(COALESCE(raw_json,'')) DESC,ts DESC,uid
          ) rn
        FROM matches
      ) SELECT uid FROM k WHERE rn>1`);
    const dup=Number((await c.query('SELECT COUNT(*)::bigint c FROM _fc_dup_matches')).rows[0]?.c||0);
    await c.query('DELETE FROM match_players WHERE match_uid IN(SELECT uid FROM _fc_dup_matches)');
    await c.query('DELETE FROM matches WHERE uid IN(SELECT uid FROM _fc_dup_matches)');
    const orphan=(await c.query('DELETE FROM match_players mp WHERE NOT EXISTS(SELECT 1 FROM matches m WHERE m.uid=mp.match_uid) RETURNING mp.uid')).rowCount||0;
    await c.query(`UPDATE clubs SET name=TRIM(name),name_norm=LOWER(REGEXP_REPLACE(TRIM(name),'[^a-zA-Z0-9]','','g'));
                   UPDATE players SET name=TRIM(name),club_name=TRIM(club_name),name_norm=LOWER(REGEXP_REPLACE(TRIM(name),'[^a-zA-Z0-9]','','g'));
                   UPDATE players p SET club_name=c.name FROM clubs c WHERE p.platform=c.platform AND p.club_id=c.club_id AND p.club_id<>'' AND p.club_name IS DISTINCT FROM c.name`);
    const after=(await c.query('SELECT (SELECT COUNT(*) FROM clubs)::bigint clubs,(SELECT COUNT(*) FROM players)::bigint players,(SELECT COUNT(*) FROM matches)::bigint matches,(SELECT COUNT(*) FROM match_players)::bigint appearances')).rows[0];
    const sameClubNames=Number((await c.query("SELECT COUNT(*)::bigint c FROM(SELECT platform,name_norm FROM clubs WHERE name_norm<>'' GROUP BY platform,name_norm HAVING COUNT(DISTINCT club_id)>1)x")).rows[0]?.c||0);
    const samePlayerNames=Number((await c.query("SELECT COUNT(*)::bigint c FROM(SELECT platform,club_id,name_norm FROM players WHERE name_norm<>'' GROUP BY platform,club_id,name_norm HAVING COUNT(DISTINCT player_id)>1)x")).rows[0]?.c||0);
    await c.query('COMMIT');
    console.log(`[DB-AUDIT-V2] before clubs=${before.clubs} players=${before.players} matches=${before.matches} appearances=${before.appearances} | removedMatchDuplicates=${dup} orphanAppearances=${orphan} | after clubs=${after.clubs} players=${after.players} matches=${after.matches} appearances=${after.appearances} | sameClubNameDifferentIds=${sameClubNames} samePlayerNameDifferentIds=${samePlayerNames}`);
  }catch(e){await c.query('ROLLBACK').catch(()=>{});console.warn('[DB-AUDIT-V2] repair skipped:',e.message)}finally{c.release()}
}

const originalInit=Store.prototype.init;
Store.prototype.init=async function(){await originalInit.call(this);if(this.mode==='postgres')await repairPostgres(this)};

const originalUpsertMatch=Store.prototype.upsertMatch;
Store.prototype.upsertMatch=async function(m,p){
  if(this.mode==='postgres'&&num(m.ts)>0){
    try{
      const ts=num(m.ts),start=Math.floor(ts/DAY)*DAY,end=start+DAY,type=String(m.type||''),hn=String(m.home?.name||''),an=String(m.away?.name||'');
      const rows=await this.q(`SELECT * FROM matches WHERE platform=$1 AND LOWER(TRIM(COALESCE(match_type,'')))=LOWER(TRIM($2)) AND ts>=$3 AND ts<$4 AND ((LOWER(REGEXP_REPLACE(TRIM(home_name),'[^a-zA-Z0-9]','','g'))=$5 AND LOWER(REGEXP_REPLACE(TRIM(away_name),'[^a-zA-Z0-9]','','g'))=$6) OR (LOWER(REGEXP_REPLACE(TRIM(home_name),'[^a-zA-Z0-9]','','g'))=$6 AND LOWER(REGEXP_REPLACE(TRIM(away_name),'[^a-zA-Z0-9]','','g'))=$5))`,[p,type,start,end,norm(hn),norm(an)]);
      const candidate={...m,platform:p},same=rows.find(x=>fingerprint(x)===fingerprint(candidate));
      if(same)m={...m,id:same.match_id};
    }catch(e){console.warn('[MATCH-GUARD]',e.message)}
  }
  return originalUpsertMatch.call(this,m,p);
};

const originalRecentMatches=Store.prototype.recentMatches;
Store.prototype.recentMatches=async function(p='',limit=60){const raw=await originalRecentMatches.call(this,p,Math.max(limit*8,320));return dedupeMatches(raw).slice(0,limit)};

const originalClubAdvanced=Store.prototype.clubAdvanced;
Store.prototype.clubAdvanced=async function(p,id){
  const base=await originalClubAdvanced.call(this,p,id);if(!base)return null;
  const rawMatches=await this.q('SELECT * FROM matches WHERE platform=$1 AND(home_club_id=$2 OR away_club_id=$2 OR name_norm=$3)ORDER BY ts DESC LIMIT 600'.replace(' OR name_norm=$3',''),[p,id]);
  const matches=dedupeMatches(rawMatches).slice(0,50);
  const curve=matches.slice(0,10).reverse().map((m,i)=>({...perspective(m,id),index:i+1}));
  const opponents=uniqueOpponents(matches,id);
  const perfRaw=await this.q('SELECT mp.*,m.ts,m.uid match_uid,m.match_id,m.match_type,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.club_id=$2 ORDER BY m.ts DESC LIMIT 12000',[p,id]);
  const validKeys=new Set(matches.map(fingerprint)),seenPerf=new Set(),perf=[];
  for(const r of perfRaw){const mk=fingerprint(r);if(validKeys.size&& !validKeys.has(mk))continue;const pk=`${mk}|${r.player_id}|${r.club_id}`;if(seenPerf.has(pk))continue;seenPerf.add(pk);perf.push({...r,match_uid:mk})}
  const stats=new Map();
  for(const r of perf){const k=String(r.player_id),s=stats.get(k)||{apps:0,roles:{},ratings:[]};s.apps++;const rb=roleBucket(r.position);if(rb)s.roles[rb]=(s.roles[rb]||0)+1;if(num(r.rating)>0)s.ratings.push(num(r.rating));stats.set(k,s)}
  const enriched=(base.players||[]).map(x=>{const s=stats.get(String(x.player_id))||{apps:0,roles:{},ratings:[]},role=Object.entries(s.roles).sort((a,b)=>b[1]-a[1])[0]?.[0]||x.recent_role||roleBucket(x.position);return{...x,recent_role:role||'',recent_apps:s.apps,recent_rating:s.ratings.length?s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length:0}});
  const players=dedupeRoster(enriched);
  return {...base,players,matches:matches.slice(0,20),curve,opponents,formation:estimateFormation(perf,players)};
};

const originalPlayer=Store.prototype.player;
Store.prototype.player=async function(p,id){
  const base=await originalPlayer.call(this,p,id);if(!base)return null;
  const raw=await this.q('SELECT mp.*,m.uid match_uid,m.match_id,m.match_type,m.ts,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.player_id=$2 ORDER BY m.ts DESC LIMIT 500',[p,id]);
  return {...base,recent:dedupeMatches(raw).slice(0,30)};
};
