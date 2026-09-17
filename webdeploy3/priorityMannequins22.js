import {Store} from './store5.js';
import {ea,extractClubs,syncClub} from './crawler5.js';
import {sleep,gap,norm,BASE} from './constants.js';

const PLATFORM='common-gen5';
const META_PLATFORM='priority:les-mannequins:platform';
const META_CLUB='priority:les-mannequins:club_id';
const META_CURSOR='priority:les-mannequins:id_cursor_fast2';
const META_NAME_SEARCH='priority:les-mannequins:last_name_search';
const QUERIES=['Les Mannequins','Mannequins','Mannequin','FC Mannequins','FC Mannequin','FC LMS','LMS FC','LMS'];
const CLUB_ALIASES=['Les Mannequins','Mannequins','Mannequin','FC Mannequins','FC Mannequin','FC LMS','LMS FC'].map(norm);
const PLAYER_GROUPS=[
  ['Tivahze'],['gorux08','gorux'],['ScOtche06','scotche'],['OCTechelle','Oct Echelle','echelle'],
  ['NSNicosss','Nicosss'],['Cedric00'],['Vet 62','Vet62'],['Najibwolf'],['Yeye'],['jbm']
].map(g=>g.map(norm));
let running=false;

const isTargetName=name=>{const n=norm(name);return !!n&&CLUB_ALIASES.some(a=>n===a||n.includes(a)||a.includes(n))};
const knownHits=players=>{const names=players.map(x=>norm(x.name));return PLAYER_GROUPS.filter(group=>group.some(h=>names.some(n=>n===h||n.includes(h)||h.includes(n)))).length};

function groupKnownRows(rows=[]){
  const map=new Map();
  for(const r of rows){
    if(!r.club_id)continue;
    const key=`${r.platform||PLATFORM}|${r.club_id}`;
    const x=map.get(key)||{platform:r.platform||PLATFORM,club_id:String(r.club_id),name:r.club_name||'',players:[]};
    if(r.club_name)x.name=r.club_name;
    x.players.push({name:r.name});
    map.set(key,x);
  }
  return [...map.values()].map(x=>({...x,hits:knownHits(x.players)})).sort((a,b)=>b.hits-a.hits);
}

async function knownRosterCandidates(store){
  const rows=[];
  rows.push(...await store.q(`SELECT platform,club_id,club_name,name FROM players WHERE club_id<>'' AND (
    name_norm LIKE '%tivahze%' OR name_norm LIKE '%gorux%' OR name_norm LIKE '%scotche%' OR name_norm LIKE '%octechelle%' OR
    name_norm LIKE '%echelle%' OR name_norm LIKE '%nicosss%' OR name_norm LIKE '%cedric00%' OR name_norm LIKE '%vet62%' OR
    name_norm LIKE '%najibwolf%' OR name_norm LIKE '%yeye%' OR name_norm='jbm')`));
  rows.push(...await store.q(`SELECT platform,club_id,club_name,name FROM match_players WHERE club_id<>'' AND (
    lower(name) LIKE '%tivahze%' OR lower(name) LIKE '%gorux%' OR lower(name) LIKE '%scotche%' OR lower(name) LIKE '%octechelle%' OR
    lower(name) LIKE '%echelle%' OR lower(name) LIKE '%nicosss%' OR lower(name) LIKE '%cedric00%' OR lower(name) LIKE '%vet 62%' OR
    lower(name) LIKE '%vet62%' OR lower(name) LIKE '%najibwolf%' OR lower(name) LIKE '%yeye%' OR lower(name)='jbm')`));
  const groups=groupKnownRows(rows);
  for(const c of groups.slice(0,20))console.log(`[PRIORITY22] clue platform=${c.platform} club=${c.name||c.club_id} id=${c.club_id} knownHits=${c.hits} players=${c.players.map(p=>p.name).join(',')}`);
  return groups;
}

async function markPriority(store,club){
  await store.setMeta(META_PLATFORM,club.platform||PLATFORM);
  await store.setMeta(META_CLUB,String(club.club_id));
  if(store.mode==='postgres')await store.pool.query(`INSERT INTO watched_clubs(platform,club_id,name,last_viewed,last_polled,first_seen)
    VALUES($1,$2,$3,EXTRACT(EPOCH FROM NOW())::BIGINT,0,EXTRACT(EPOCH FROM NOW())::BIGINT)
    ON CONFLICT(platform,club_id) DO UPDATE SET name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE watched_clubs.name END,last_viewed=EXTRACT(EPOCH FROM NOW())::BIGINT`,
    [club.platform||PLATFORM,String(club.club_id),String(club.name||'Les Mannequins')]);
}

async function hydrateAndScore(store,club){
  try{await syncClub(store,{club_id:club.club_id,name:club.name},club.platform||PLATFORM)}catch(e){console.warn(`[PRIORITY22] sync ${club.club_id}: ${e.message}`)}
  const fresh=await store.one(`SELECT platform,club_id,name FROM clubs WHERE platform=$1 AND club_id=$2`,[club.platform||PLATFORM,String(club.club_id)]);
  if(fresh?.name)club={...club,name:fresh.name};
  const players=await store.q(`SELECT name,player_id,club_name FROM players WHERE platform=$1 AND club_id=$2 ORDER BY updated_at DESC`,[club.platform||PLATFORM,String(club.club_id)]);
  const hits=knownHits(players),nameScore=isTargetName(club.name)?250:0,exact=norm(club.name)==='lesmannequins'?250:0;
  return{club,players,hits,score:exact+nameScore+hits*180};
}

async function directEaSearch(store,found){
  const now=Math.floor(Date.now()/1000),last=Number(await store.meta(META_NAME_SEARCH,'0'))||0;
  if(last&&now-last<1800)return;
  await store.setMeta(META_NAME_SEARCH,now);
  for(const q of QUERIES){
    for(const endpoint of ['/currentSeasonLeaderboard/search','/allTimeLeaderboard/search']){
      try{
        const clubs=await extractClubs(store,await ea(endpoint,{platform:PLATFORM,clubName:q,maxResultCount:50}),PLATFORM);
        for(const c of clubs)if(isTargetName(c.name)){
          found.set(`${PLATFORM}|${c.id}`,{platform:PLATFORM,club_id:String(c.id),name:c.name});
          console.log(`[PRIORITY22] NAME HIT club=${c.name} id=${c.id}`);
        }
      }catch(e){console.warn(`[PRIORITY22] EA search ${q}: ${e.message}`)}
      await sleep(gap());
    }
    if(found.size)return;
  }
}

async function initialCursor(store){
  const saved=Number(await store.meta(META_CURSOR,'0'))||0;
  if(saved>1)return saved;
  try{
    const r=await store.one(`SELECT COALESCE(MAX(club_id::bigint),0) max_id FROM clubs WHERE platform=$1 AND club_id ~ '^[0-9]+$'`,[PLATFORM]);
    const maxId=Number(r?.max_id||0),start=maxId>0?Math.max(1,maxId-300):1;
    return start;
  }catch{return 1}
}

async function infoOnce(id){
  const u=new URL(BASE+'/clubs/info');
  u.searchParams.set('platform',PLATFORM);u.searchParams.set('clubIds',String(id));
  try{
    const r=await fetch(u,{headers:{accept:'application/json','accept-language':'fr-FR,fr;q=0.9,en;q=0.8','user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153 Safari/537.36','referer':'https://www.ea.com/'},signal:AbortSignal.timeout(4500)});
    if(!r.ok)return null;
    return await r.json();
  }catch{return null}
}

async function parallelIdScan(store,found){
  let cursor=await initialCursor(store);
  const total=300,concurrency=4,start=cursor;
  console.log(`[PRIORITY22] LIGHT ID scan start cursor=${cursor} count=${total} concurrency=${concurrency}`);
  for(let done=0;done<total;done+=concurrency){
    const ids=Array.from({length:Math.min(concurrency,total-done)},(_,i)=>cursor+i);
    const payloads=await Promise.all(ids.map(async id=>[id,await infoOnce(id)]));
    for(const[id,payload]of payloads){
      if(!payload)continue;
      try{
        const clubs=await extractClubs(store,payload,PLATFORM);
        for(const c of clubs)if(isTargetName(c.name)){
          found.set(`${PLATFORM}|${c.id}`,{platform:PLATFORM,club_id:String(c.id),name:c.name});
          console.log(`[PRIORITY22] LIGHT ID NAME HIT club=${c.name} id=${c.id} probe=${id}`);
          await store.setMeta(META_CURSOR,Math.max(...ids)+1);
          return;
        }
      }catch(e){console.warn(`[PRIORITY22] parse id ${id}: ${e.message}`)}
    }
    cursor+=ids.length;
    if(cursor-start>=100&&((cursor-start)%100)<concurrency)await store.setMeta(META_CURSOR,cursor);
    await sleep(250);
  }
  await store.setMeta(META_CURSOR,cursor);
  console.log(`[PRIORITY22] LIGHT ID scan end nextCursor=${cursor}`);
}

async function discover(store){
  const found=new Map();
  const roster=await knownRosterCandidates(store);
  for(const c of roster.filter(x=>x.hits>=2||isTargetName(x.name))){
    const dbClub=await store.one(`SELECT platform,club_id,name FROM clubs WHERE platform=$1 AND club_id=$2`,[c.platform,String(c.club_id)]);
    found.set(`${c.platform}|${c.club_id}`,dbClub||{platform:c.platform,club_id:c.club_id,name:c.name});
    console.log(`[PRIORITY22] roster candidate ${c.name||c.club_id} id=${c.club_id} knownHits=${c.hits}`);
  }
  const local=await store.q(`SELECT platform,club_id,name FROM clubs WHERE name_norm LIKE '%mannequin%' OR name_norm IN ('fclms','lmsfc') ORDER BY updated_at DESC LIMIT 50`);
  for(const c of local)found.set(`${c.platform}|${c.club_id}`,c);
  if(!found.size)await directEaSearch(store,found);
  if(!found.size)await parallelIdScan(store,found);
  if(!found.size){console.warn('[PRIORITY22] Les Mannequins not found yet; light scan will continue');return null}

  const scored=[];
  for(const club of [...found.values()].slice(0,20)){scored.push(await hydrateAndScore(store,club));await sleep(gap())}
  scored.sort((a,b)=>b.score-a.score||b.players.length-a.players.length);
  const best=scored[0];
  if(!best)return null;
  if(!isTargetName(best.club.name)&&best.hits<2)return null;
  await markPriority(store,best.club);
  console.log(`[PRIORITY22] selected ${best.club.name} id=${best.club.club_id} platform=${best.club.platform} players=${best.players.length} knownHits=${best.hits}`);
  if(best.players.length)console.log(`[PRIORITY22] roster ${best.players.map(x=>x.name).join(', ')}`);
  return best.club;
}

async function refresh(store){
  if(running||store.mode!=='postgres')return;
  running=true;
  try{
    const platform=await store.meta(META_PLATFORM,PLATFORM),clubId=await store.meta(META_CLUB,'');
    if(clubId){
      const club=await store.one(`SELECT platform,club_id,name FROM clubs WHERE platform=$1 AND club_id=$2`,[platform,clubId]);
      if(club){
        const scored=await hydrateAndScore(store,club);await markPriority(store,scored.club);
        console.log(`[PRIORITY22] refreshed ${scored.club.name} id=${scored.club.club_id} players=${scored.players.length} knownHits=${scored.hits}`);
        return;
      }
    }
    await discover(store);
  }catch(e){console.warn('[PRIORITY22]',e.message)}finally{running=false}
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);
  if(this.mode!=='postgres')return;
  console.log('[PRIORITY22] Les Mannequins LIGHT discovery enabled');
  setTimeout(()=>refresh(this),15000).unref();
  setInterval(()=>refresh(this),5*60000).unref();
};