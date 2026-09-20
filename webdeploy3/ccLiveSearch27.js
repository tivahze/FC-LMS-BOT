import {Store} from './store5.js';
import {norm,num} from './constants.js';

const API='https://api.club-champions.eu/cc/player';
const SEASON='FC27';
const PLATFORM='common-gen5';
const CACHE_TTL=Math.max(60000,Number(process.env.CC27_CACHE_MS||21600000));
const GAP=Math.max(1000,Number(process.env.CC27_REQUEST_GAP_MS||1200));
const cache=new Map();
const inflight=new Map();
let lastFetch=0;
let queue=Promise.resolve();

const text=v=>String(v??'').trim();
const keyOf=x=>text(x.externalId)||`cc-${text(x.id)}`;

function aggregate(rows){
  const map=new Map();
  for(const x of rows||[]){
    const name=text(x.name);if(!name)continue;
    const id=keyOf(x);if(!id)continue;
    const k=`${id}|${norm(name)}`;
    const p=map.get(k)||{id,name,externalId:text(x.externalId),ccId:text(x.id),teamId:text(x.teamId),teamName:text(x.teamName),games:0,goals:0,assists:0,weighted:0,weight:0,segments:[]};
    const g=Math.max(0,num(x.matchCount));
    p.games+=g;p.goals+=Math.max(0,num(x.totalGoals));p.assists+=Math.max(0,num(x.totalAssists));
    if(num(x.globalRating)>0){p.weighted+=num(x.globalRating)*Math.max(1,g);p.weight+=Math.max(1,g)}
    if(g>=num(p.bestGames||0)){p.bestGames=g;p.teamId=text(x.teamId)||p.teamId;p.teamName=text(x.teamName)||p.teamName}
    p.segments.push(x);map.set(k,p);
  }
  return[...map.values()].map(p=>({...p,rating:p.weight?p.weighted/p.weight:0}));
}

async function rawFetch(q){
  const u=new URL(API);u.searchParams.set('search',q);u.searchParams.set('page','1');u.searchParams.set('season',SEASON);
  const r=await fetch(u,{headers:{accept:'application/json','user-agent':'FC-Clubs-Global/1.0 (+on-demand public player lookup)'},redirect:'follow'});
  if(!r.ok){console.warn(`[CC27] search HTTP ${r.status} q=${q}`);return[]}
  const body=await r.json();return Array.isArray(body?.data)?body.data:[];
}

async function searchExternal(q){
  const n=norm(q),now=Date.now(),hit=cache.get(n);if(hit&&now-hit.at<CACHE_TTL)return hit.rows;
  if(inflight.has(n))return inflight.get(n);
  const work=queue.then(async()=>{
    const wait=Math.max(0,GAP-(Date.now()-lastFetch));if(wait)await new Promise(r=>setTimeout(r,wait));
    lastFetch=Date.now();
    try{const rows=await rawFetch(q);cache.set(n,{at:Date.now(),rows});if(cache.size>500){for(const[k,v]of cache)if(Date.now()-v.at>CACHE_TTL)cache.delete(k)}return rows}catch(e){console.warn(`[CC27] search failed q=${q}: ${e.message}`);return[]}
  });
  queue=work.catch(()=>{});inflight.set(n,work);try{return await work}finally{inflight.delete(n)}
}

async function importRows(store,rows){
  const players=aggregate(rows);let imported=0;
  for(const p of players){
    const clubId=p.teamId?`cc-${p.teamId}`:'';
    if(p.teamId&&p.teamName){
      try{await store.upsertClub({id:clubId,name:p.teamName,games:p.games,raw:{source:'club-champions-live-search',sourceTeamId:p.teamId}},PLATFORM)}catch(e){console.warn('[CC27] club upsert',e.message)}
    }
    try{
      await store.upsertPlayer({id:p.id,name:p.name,games:p.games,goals:p.goals,assists:p.assists,rating:p.rating,raw:{source:'club-champions-live-search',sourcePlayerId:p.ccId,sourceExternalId:p.externalId,sourceTeamId:p.teamId,segments:p.segments}},PLATFORM,clubId,p.teamName);imported++;
    }catch(e){console.warn('[CC27] player upsert',e.message)}
  }
  return imported;
}

function shouldLookup(query,platform,result){
  const q=norm(query);if(q.length<4)return false;
  if(platform&&platform!==PLATFORM)return false;
  const players=result?.players||[];
  if(players.some(x=>norm(x.name)===q))return false;
  if(players.length>0&&q.length<6)return false;
  return true;
}

const prevSearch=Store.prototype.search;
Store.prototype.search=async function(q,p=''){
  let r=await prevSearch.call(this,q,p);
  if(!shouldLookup(q,p,r))return r;
  const rows=await searchExternal(q);if(!rows.length)return r;
  const n=await importRows(this,rows);if(n){console.log(`[CC27] q=${q} imported=${n}`);r=await prevSearch.call(this,q,p)}
  return r;
};

if(typeof Store.prototype.v8Search==='function'){
  const prevV8=Store.prototype.v8Search;
  Store.prototype.v8Search=async function(q,p='',limit=8){
    let r=await prevV8.call(this,q,p,limit);
    if(!shouldLookup(q,p,r))return r;
    const rows=await searchExternal(q);if(!rows.length)return r;
    const n=await importRows(this,rows);if(n){console.log(`[CC27] v8 q=${q} imported=${n}`);r=await prevV8.call(this,q,p,limit)}
    return r;
  };
}

console.log(`[CC27] on-demand player search fallback enabled season=${SEASON} cache=${CACHE_TTL}ms gap=${GAP}ms`);
