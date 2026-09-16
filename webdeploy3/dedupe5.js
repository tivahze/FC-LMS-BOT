import {Store,estimateFormation} from './store5.js';
import {num,roleBucket} from './constants.js';

function sideKey(id,name,goals){return `${String(id||name||'').toLowerCase()}:${num(goals)}`}
function matchKey(m){
  const ts=num(m.ts);
  const time=ts>0?Math.floor(ts/60):`id:${m.match_id||m.uid||''}`;
  const sides=[sideKey(m.home_club_id,m.home_name,m.home_goals),sideKey(m.away_club_id,m.away_name,m.away_goals)].sort();
  return `${m.platform||''}|${time}|${sides.join('|')}`;
}
function dedupeMatches(rows){
  const seen=new Set(),out=[];
  for(const m of rows||[]){const k=matchKey(m);if(seen.has(k))continue;seen.add(k);out.push(m)}
  return out;
}
function perspective(m,id){
  const home=String(m.home_club_id)===String(id);
  const gf=home?num(m.home_goals):num(m.away_goals),ga=home?num(m.away_goals):num(m.home_goals);
  return {...m,gf,ga,gd:gf-ga,result:gf>ga?'V':gf<ga?'D':'N',opponent:home?m.away_name:m.home_name,opponent_id:home?m.away_club_id:m.home_club_id};
}

const originalRecentMatches=Store.prototype.recentMatches;
Store.prototype.recentMatches=async function(p='',limit=60){
  const raw=await originalRecentMatches.call(this,p,Math.max(limit*4,120));
  return dedupeMatches(raw).slice(0,limit);
};

const originalClubAdvanced=Store.prototype.clubAdvanced;
Store.prototype.clubAdvanced=async function(p,id){
  const base=await originalClubAdvanced.call(this,p,id);if(!base)return null;
  const rawMatches=await this.q('SELECT * FROM matches WHERE platform=$1 AND(home_club_id=$2 OR away_club_id=$2)ORDER BY ts DESC LIMIT 160',[p,id]);
  const matches=dedupeMatches(rawMatches).slice(0,30);
  const curve=matches.slice(0,10).reverse().map((m,i)=>({...perspective(m,id),index:i+1}));
  const opponents=[...curve].reverse().map(x=>({name:x.opponent,id:x.opponent_id,score:`${x.gf}-${x.ga}`,result:x.result,ts:x.ts,type:x.match_type}));

  const perfRaw=await this.q('SELECT mp.*,m.ts,m.uid match_uid,m.match_id,m.match_type,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.club_id=$2 ORDER BY m.ts DESC LIMIT 4000',[p,id]);
  const seenPerf=new Set(),perf=[];
  for(const r of perfRaw){const mk=matchKey({...r,platform:r.platform});const pk=`${mk}|${r.player_id}|${r.club_id}`;if(seenPerf.has(pk))continue;seenPerf.add(pk);perf.push({...r,match_uid:mk})}
  const stats=new Map();
  for(const r of perf){const k=String(r.player_id),s=stats.get(k)||{apps:0,roles:{},ratings:[]};s.apps++;const rb=roleBucket(r.position);if(rb)s.roles[rb]=(s.roles[rb]||0)+1;if(num(r.rating)>0)s.ratings.push(num(r.rating));stats.set(k,s)}
  const players=(base.players||[]).map(x=>{const s=stats.get(String(x.player_id))||{apps:0,roles:{},ratings:[]},role=Object.entries(s.roles).sort((a,b)=>b[1]-a[1])[0]?.[0]||x.recent_role||roleBucket(x.position);return{...x,recent_role:role||'',recent_apps:s.apps,recent_rating:s.ratings.length?s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length:0}});
  return {...base,players,matches:matches.slice(0,20),curve,opponents,formation:estimateFormation(perf,players)};
};

const originalPlayer=Store.prototype.player;
Store.prototype.player=async function(p,id){
  const base=await originalPlayer.call(this,p,id);if(!base)return null;
  const raw=await this.q('SELECT mp.*,m.match_id,m.match_type,m.ts,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.player_id=$2 ORDER BY m.ts DESC LIMIT 150',[p,id]);
  const seen=new Set(),recent=[];
  for(const r of raw){const k=matchKey({...r,platform:r.platform});if(seen.has(k))continue;seen.add(k);recent.push(r);if(recent.length>=30)break}
  return {...base,recent};
};
