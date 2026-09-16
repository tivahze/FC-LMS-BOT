import {Store,estimateFormation} from './store5.js';
import {num,roleBucket} from './constants.js';

const DAY=86400;
function cleanName(v){return String(v||'').trim().toLowerCase()}
function sideKey(id,name,goals){return `${String(id||'').trim()||cleanName(name)}:${num(goals)}`}
function matchType(m){return String(m.match_type??m.type??'').toLowerCase()}
function matchSignature(m){
  const sides=[sideKey(m.home_club_id??m.home?.id,m.home_name??m.home?.name,m.home_goals??m.home?.goals),sideKey(m.away_club_id??m.away?.id,m.away_name??m.away?.name,m.away_goals??m.away?.goals)].sort();
  return `${m.platform||''}|${matchType(m)}|${sides.join('|')}`;
}
function exactMatchId(m){return String(m.match_id||m.uid||m.id||'').trim()}
function dayBucket(m){const ts=num(m.ts);return ts>0?Math.floor(ts/DAY):`id:${exactMatchId(m)}`}
function canonicalMatchKey(m){return `${matchSignature(m)}|${dayBucket(m)}`}
function dedupeMatches(rows){
  const seen=new Set(),ids=new Set(),out=[];
  for(const m of rows||[]){
    const id=exactMatchId(m),idKey=id?`${m.platform||''}|${id}`:'',key=canonicalMatchKey(m);
    if(idKey&&ids.has(idKey))continue;
    if(seen.has(key))continue;
    if(idKey)ids.add(idKey);seen.add(key);out.push(m);
  }
  return out;
}
function perspective(m,id){
  const home=String(m.home_club_id)===String(id);
  const gf=home?num(m.home_goals):num(m.away_goals),ga=home?num(m.away_goals):num(m.home_goals);
  return {...m,gf,ga,gd:gf-ga,result:gf>ga?'V':gf<ga?'D':'N',opponent:home?m.away_name:m.home_name,opponent_id:home?m.away_club_id:m.home_club_id};
}
function uniqueOpponents(matches,id){
  const map=new Map();
  for(const m of matches){
    const x=perspective(m,id),key=String(x.opponent_id||cleanName(x.opponent));if(!key)continue;
    let o=map.get(key);
    if(!o){o={name:x.opponent,id:x.opponent_id,score:`${x.gf}-${x.ga}`,result:x.result,ts:x.ts,type:x.match_type,meetings:0,wins:0,draws:0,losses:0};map.set(key,o)}
    o.meetings++;if(x.result==='V')o.wins++;else if(x.result==='N')o.draws++;else o.losses++;
  }
  return [...map.values()].slice(0,10);
}
function dedupeRoster(players){
  const out=[],byName=new Map();
  for(const p of players||[]){
    const key=cleanName(p.name);if(!key){out.push(p);continue}
    const old=byName.get(key);
    if(!old){byName.set(key,p);out.push(p);continue}
    const score=x=>(String(x.player_id||'').toLowerCase()!==cleanName(x.name)?1000000:0)+num(x.games)*100+num(x.rating)*10+num(x.recent_apps);
    if(score(p)>score(old)){const i=out.indexOf(old);if(i>=0)out[i]=p;byName.set(key,p)}
  }
  return out;
}

async function repairPostgres(store){
  const c=await store.pool.connect();
  try{
    await c.query('BEGIN');
    const before=await c.query('SELECT (SELECT COUNT(*) FROM clubs)::bigint clubs,(SELECT COUNT(*) FROM players)::bigint players,(SELECT COUNT(*) FROM matches)::bigint matches,(SELECT COUNT(*) FROM match_players)::bigint appearances');
    await c.query('DROP TABLE IF EXISTS _fc_dup_matches');
    await c.query(`CREATE TEMP TABLE _fc_dup_matches ON COMMIT DROP AS
      WITH keyed AS(
        SELECT uid,
          ROW_NUMBER() OVER(PARTITION BY
            platform,
            COALESCE(match_type,''),
            CASE WHEN ts>0 THEN FLOOR(ts/86400.0)::bigint::text ELSE uid END,
            LEAST(LOWER(COALESCE(NULLIF(home_club_id,''),home_name,'')),LOWER(COALESCE(NULLIF(away_club_id,''),away_name,''))),
            GREATEST(LOWER(COALESCE(NULLIF(home_club_id,''),home_name,'')),LOWER(COALESCE(NULLIF(away_club_id,''),away_name,''))),
            CASE WHEN LOWER(COALESCE(NULLIF(home_club_id,''),home_name,''))<=LOWER(COALESCE(NULLIF(away_club_id,''),away_name,'')) THEN home_goals ELSE away_goals END,
            CASE WHEN LOWER(COALESCE(NULLIF(home_club_id,''),home_name,''))<=LOWER(COALESCE(NULLIF(away_club_id,''),away_name,'')) THEN away_goals ELSE home_goals END
          ORDER BY LENGTH(COALESCE(raw_json,'')) DESC,ts DESC,uid
          ) rn
        FROM matches
      ) SELECT uid FROM keyed WHERE rn>1`);
    const dup=(await c.query('SELECT COUNT(*)::bigint c FROM _fc_dup_matches')).rows[0]?.c||0;
    await c.query('DELETE FROM match_players WHERE match_uid IN(SELECT uid FROM _fc_dup_matches)');
    await c.query('DELETE FROM matches WHERE uid IN(SELECT uid FROM _fc_dup_matches)');
    const orphan=(await c.query('DELETE FROM match_players mp WHERE NOT EXISTS(SELECT 1 FROM matches m WHERE m.uid=mp.match_uid) RETURNING mp.uid')).rowCount||0;
    await c.query("UPDATE clubs SET name=TRIM(name) WHERE name<>TRIM(name); UPDATE players SET name=TRIM(name),club_name=TRIM(club_name) WHERE name<>TRIM(name) OR club_name<>TRIM(club_name)");
    const clubAliases=(await c.query("SELECT COUNT(*)::bigint c FROM(SELECT platform,name_norm FROM clubs WHERE name_norm<>'' GROUP BY platform,name_norm HAVING COUNT(DISTINCT club_id)>1)x")).rows[0]?.c||0;
    const playerAliases=(await c.query("SELECT COUNT(*)::bigint c FROM(SELECT platform,club_id,name_norm FROM players WHERE name_norm<>'' GROUP BY platform,club_id,name_norm HAVING COUNT(DISTINCT player_id)>1)x")).rows[0]?.c||0;
    await c.query('COMMIT');
    console.log(`[DB-AUDIT] clubs=${before.rows[0].clubs} players=${before.rows[0].players} matches=${before.rows[0].matches} appearances=${before.rows[0].appearances} duplicateMatchesRemoved=${dup} orphanAppearancesRemoved=${orphan} clubNameCollisions=${clubAliases} playerNameCollisions=${playerAliases}`);
  }catch(e){await c.query('ROLLBACK').catch(()=>{});console.warn('[DB-AUDIT] repair skipped:',e.message)}finally{c.release()}
}

const originalInit=Store.prototype.init;
Store.prototype.init=async function(){await originalInit.call(this);if(this.mode==='postgres')await repairPostgres(this)};

const originalUpsertMatch=Store.prototype.upsertMatch;
Store.prototype.upsertMatch=async function(m,p){
  if(this.mode==='postgres'&&num(m.ts)>0){
    try{
      const ts=num(m.ts),start=Math.floor(ts/DAY)*DAY,end=start+DAY,h=String(m.home?.id||''),a=String(m.away?.id||''),type=String(m.type||'');
      const rows=await this.q(`SELECT match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals,platform FROM matches WHERE platform=$1 AND COALESCE(match_type,'')=$2 AND ts>=$3 AND ts<$4 AND((home_club_id=$5 AND away_club_id=$6)OR(home_club_id=$6 AND away_club_id=$5)) LIMIT 100`,[p,type,start,end,h,a]);
      const sig=matchSignature({...m,platform:p}),same=rows.find(x=>matchSignature(x)===sig);
      if(same)m={...m,id:same.match_id};
    }catch(e){console.warn('[DB-AUDIT] duplicate guard:',e.message)}
  }
  return originalUpsertMatch.call(this,m,p);
};

const originalRecentMatches=Store.prototype.recentMatches;
Store.prototype.recentMatches=async function(p='',limit=60){const raw=await originalRecentMatches.call(this,p,Math.max(limit*6,240));return dedupeMatches(raw).slice(0,limit)};

const originalClubAdvanced=Store.prototype.clubAdvanced;
Store.prototype.clubAdvanced=async function(p,id){
  const base=await originalClubAdvanced.call(this,p,id);if(!base)return null;
  const rawMatches=await this.q('SELECT * FROM matches WHERE platform=$1 AND(home_club_id=$2 OR away_club_id=$2)ORDER BY ts DESC LIMIT 400',[p,id]);
  const matches=dedupeMatches(rawMatches).slice(0,50),curve=matches.slice(0,10).reverse().map((m,i)=>({...perspective(m,id),index:i+1})),opponents=uniqueOpponents(matches,id);
  const perfRaw=await this.q('SELECT mp.*,m.ts,m.uid match_uid,m.match_id,m.match_type,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.club_id=$2 ORDER BY m.ts DESC LIMIT 8000',[p,id]);
  const matchMap=new Map(rawMatches.map(m=>[String(m.uid),canonicalMatchKey(m)])),seenPerf=new Set(),perf=[];
  for(const r of perfRaw){const mk=matchMap.get(String(r.match_uid))||canonicalMatchKey(r),pk=`${mk}|${r.player_id}|${r.club_id}`;if(seenPerf.has(pk))continue;seenPerf.add(pk);perf.push({...r,match_uid:mk})}
  const stats=new Map();
  for(const r of perf){const k=String(r.player_id),s=stats.get(k)||{apps:0,roles:{},ratings:[]};s.apps++;const rb=roleBucket(r.position);if(rb)s.roles[rb]=(s.roles[rb]||0)+1;if(num(r.rating)>0)s.ratings.push(num(r.rating));stats.set(k,s)}
  const enriched=(base.players||[]).map(x=>{const s=stats.get(String(x.player_id))||{apps:0,roles:{},ratings:[]},role=Object.entries(s.roles).sort((a,b)=>b[1]-a[1])[0]?.[0]||x.recent_role||roleBucket(x.position);return{...x,recent_role:role||'',recent_apps:s.apps,recent_rating:s.ratings.length?s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length:0}}),players=dedupeRoster(enriched);
  return {...base,players,matches:matches.slice(0,20),curve,opponents,formation:estimateFormation(perf,players)};
};

const originalPlayer=Store.prototype.player;
Store.prototype.player=async function(p,id){
  const base=await originalPlayer.call(this,p,id);if(!base)return null;
  const raw=await this.q('SELECT mp.*,m.uid match_uid,m.match_id,m.match_type,m.ts,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.player_id=$2 ORDER BY m.ts DESC LIMIT 300',[p,id]);
  return {...base,recent:dedupeMatches(raw).slice(0,30)};
};
