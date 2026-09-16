import {Store,estimateFormation} from './store5.js';
import {num,roleBucket} from './constants.js';

const DUP_WINDOW_SECONDS=600;
function cleanName(v){return String(v||'').trim().toLowerCase()}
function sideKey(id,name,goals){return `${String(id||'').trim()||cleanName(name)}:${num(goals)}`}
function matchSignature(m){
  const sides=[sideKey(m.home_club_id,m.home_name,m.home_goals),sideKey(m.away_club_id,m.away_name,m.away_goals)].sort();
  return `${m.platform||''}|${sides.join('|')}`;
}
function exactMatchId(m){return String(m.match_id||m.uid||'').trim()}
function dedupeMatches(rows){
  const out=[],groups=new Map(),ids=new Set();
  for(const m of rows||[]){
    const id=exactMatchId(m),ts=num(m.ts),sig=matchSignature(m);
    if(id&&ids.has(`${m.platform||''}|${id}`))continue;
    const times=groups.get(sig)||[];
    const duplicate=ts>0&&times.some(t=>Math.abs(ts-t)<=DUP_WINDOW_SECONDS);
    if(duplicate)continue;
    if(id)ids.add(`${m.platform||''}|${id}`);
    if(ts>0){times.push(ts);groups.set(sig,times)}
    out.push(m);
  }
  return out;
}
function canonicalMatchKey(m){
  const ts=num(m.ts),bucket=ts>0?Math.round(ts/DUP_WINDOW_SECONDS):`id:${exactMatchId(m)}`;
  return `${matchSignature(m)}|${bucket}`;
}
function perspective(m,id){
  const home=String(m.home_club_id)===String(id);
  const gf=home?num(m.home_goals):num(m.away_goals),ga=home?num(m.away_goals):num(m.home_goals);
  return {...m,gf,ga,gd:gf-ga,result:gf>ga?'V':gf<ga?'D':'N',opponent:home?m.away_name:m.home_name,opponent_id:home?m.away_club_id:m.home_club_id};
}
function uniqueOpponents(matches,id){
  const map=new Map();
  for(const m of matches){
    const x=perspective(m,id),key=String(x.opponent_id||cleanName(x.opponent));
    if(!key)continue;
    let o=map.get(key);
    if(!o){o={name:x.opponent,id:x.opponent_id,score:`${x.gf}-${x.ga}`,result:x.result,ts:x.ts,type:x.match_type,meetings:0,wins:0,draws:0,losses:0};map.set(key,o)}
    o.meetings++;
    if(x.result==='V')o.wins++;else if(x.result==='N')o.draws++;else o.losses++;
  }
  return [...map.values()].slice(0,10);
}

const originalRecentMatches=Store.prototype.recentMatches;
Store.prototype.recentMatches=async function(p='',limit=60){
  const raw=await originalRecentMatches.call(this,p,Math.max(limit*5,160));
  return dedupeMatches(raw).slice(0,limit);
};

const originalClubAdvanced=Store.prototype.clubAdvanced;
Store.prototype.clubAdvanced=async function(p,id){
  const base=await originalClubAdvanced.call(this,p,id);if(!base)return null;
  const rawMatches=await this.q('SELECT * FROM matches WHERE platform=$1 AND(home_club_id=$2 OR away_club_id=$2)ORDER BY ts DESC LIMIT 240',[p,id]);
  const matches=dedupeMatches(rawMatches).slice(0,40);
  const curve=matches.slice(0,10).reverse().map((m,i)=>({...perspective(m,id),index:i+1}));
  const opponents=uniqueOpponents(matches,id);

  const perfRaw=await this.q('SELECT mp.*,m.ts,m.uid match_uid,m.match_id,m.match_type,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.club_id=$2 ORDER BY m.ts DESC LIMIT 5000',[p,id]);
  const keptMatches=dedupeMatches(rawMatches),canonical=new Map();
  for(const m of keptMatches)canonical.set(String(m.uid),canonicalMatchKey(m));
  for(const m of rawMatches){
    if(canonical.has(String(m.uid)))continue;
    const sig=matchSignature(m),ts=num(m.ts),near=keptMatches.find(k=>matchSignature(k)===sig&&ts>0&&num(k.ts)>0&&Math.abs(ts-num(k.ts))<=DUP_WINDOW_SECONDS);
    if(near)canonical.set(String(m.uid),canonicalMatchKey(near));
  }
  const seenPerf=new Set(),perf=[];
  for(const r of perfRaw){
    const mk=canonical.get(String(r.match_uid))||canonicalMatchKey(r),pk=`${mk}|${r.player_id}|${r.club_id}`;
    if(seenPerf.has(pk))continue;seenPerf.add(pk);perf.push({...r,match_uid:mk});
  }
  const stats=new Map();
  for(const r of perf){const k=String(r.player_id),s=stats.get(k)||{apps:0,roles:{},ratings:[]};s.apps++;const rb=roleBucket(r.position);if(rb)s.roles[rb]=(s.roles[rb]||0)+1;if(num(r.rating)>0)s.ratings.push(num(r.rating));stats.set(k,s)}
  const players=(base.players||[]).map(x=>{const s=stats.get(String(x.player_id))||{apps:0,roles:{},ratings:[]},role=Object.entries(s.roles).sort((a,b)=>b[1]-a[1])[0]?.[0]||x.recent_role||roleBucket(x.position);return{...x,recent_role:role||'',recent_apps:s.apps,recent_rating:s.ratings.length?s.ratings.reduce((a,b)=>a+b,0)/s.ratings.length:0}});
  return {...base,players,matches:matches.slice(0,20),curve,opponents,formation:estimateFormation(perf,players)};
};

const originalPlayer=Store.prototype.player;
Store.prototype.player=async function(p,id){
  const base=await originalPlayer.call(this,p,id);if(!base)return null;
  const raw=await this.q('SELECT mp.*,m.uid match_uid,m.match_id,m.match_type,m.ts,m.home_club_id,m.home_name,m.home_goals,m.away_club_id,m.away_name,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.player_id=$2 ORDER BY m.ts DESC LIMIT 200',[p,id]);
  const matches=dedupeMatches(raw),recent=[];
  for(const r of matches){recent.push(r);if(recent.length>=30)break}
  return {...base,recent};
};
