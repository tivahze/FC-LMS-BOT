import {Store} from './store5.js';
import {ea,extractClubs,syncClub} from './crawler5.js';
import {sleep,gap,norm,PLATFORMS} from './constants.js';

const DEFAULT_PLATFORM='common-gen5';
const META_PLATFORM='priority:les-mannequins:platform';
const META_CLUB='priority:les-mannequins:club_id';
const QUERIES=['Les Mannequins','Mannequins','Mannequin','FC Mannequins','FC Mannequin','FC LMS','LMS FC','LMS'];
const CLUB_ALIASES=['Les Mannequins','Mannequins','Mannequin','FC Mannequins','FC Mannequin','FC LMS','LMS FC'].map(norm);
const PLAYER_GROUPS=[
  ['Tivahze'],['gorux08','gorux'],['ScOtche06','scotche'],['OCTechelle','Oct Echelle','echelle'],
  ['NSNicosss','Nicosss'],['Cedric00'],['Vet 62','Vet62'],['Najibwolf'],['Yeye'],['jbm']
].map(g=>g.map(norm));
let running=false;

const isTargetName=name=>{
  const n=norm(name);
  return !!n&&CLUB_ALIASES.some(a=>n===a||n.includes(a)||a.includes(n));
};

const knownHits=players=>{
  const names=players.map(x=>norm(x.name));
  return PLAYER_GROUPS.filter(group=>group.some(h=>names.some(n=>n===h||n.includes(h)||h.includes(n)))).length;
};

function groupKnownRows(rows=[]){
  const map=new Map();
  for(const r of rows){
    if(!r.club_id)continue;
    const key=`${r.platform||DEFAULT_PLATFORM}|${r.club_id}`;
    const x=map.get(key)||{platform:r.platform||DEFAULT_PLATFORM,club_id:String(r.club_id),name:r.club_name||'',players:[]};
    if(r.club_name)x.name=r.club_name;
    x.players.push({name:r.name});
    map.set(key,x);
  }
  return [...map.values()].map(x=>({...x,hits:knownHits(x.players)})).sort((a,b)=>b.hits-a.hits);
}

async function knownRosterCandidates(store){
  const rows=[];
  rows.push(...await store.q(`SELECT platform,club_id,club_name,name FROM players WHERE club_id<>'' AND (
    name_norm LIKE '%tivahze%' OR name_norm LIKE '%gorux%' OR name_norm LIKE '%scotche%' OR
    name_norm LIKE '%octechelle%' OR name_norm LIKE '%echelle%' OR name_norm LIKE '%nicosss%' OR
    name_norm LIKE '%cedric00%' OR name_norm LIKE '%vet62%' OR name_norm LIKE '%najibwolf%' OR
    name_norm LIKE '%yeye%' OR name_norm='jbm')`));
  rows.push(...await store.q(`SELECT platform,club_id,club_name,name FROM match_players WHERE club_id<>'' AND (
    lower(name) LIKE '%tivahze%' OR lower(name) LIKE '%gorux%' OR lower(name) LIKE '%scotche%' OR
    lower(name) LIKE '%octechelle%' OR lower(name) LIKE '%echelle%' OR lower(name) LIKE '%nicosss%' OR
    lower(name) LIKE '%cedric00%' OR lower(name) LIKE '%vet 62%' OR lower(name) LIKE '%vet62%' OR
    lower(name) LIKE '%najibwolf%' OR lower(name) LIKE '%yeye%' OR lower(name)='jbm')`));
  const groups=groupKnownRows(rows);
  for(const c of groups.slice(0,20))console.log(`[PRIORITY22] clue platform=${c.platform} club=${c.name||c.club_id} id=${c.club_id} knownHits=${c.hits} players=${c.players.map(p=>p.name).join(',')}`);
  return groups;
}

async function markPriority(store,club){
  await store.setMeta(META_PLATFORM,club.platform||DEFAULT_PLATFORM);
  await store.setMeta(META_CLUB,String(club.club_id));
  if(store.mode==='postgres'){
    await store.pool.query(`INSERT INTO watched_clubs(platform,club_id,name,last_viewed,last_polled,first_seen)
      VALUES($1,$2,$3,EXTRACT(EPOCH FROM NOW())::BIGINT,0,EXTRACT(EPOCH FROM NOW())::BIGINT)
      ON CONFLICT(platform,club_id) DO UPDATE SET name=CASE WHEN EXCLUDED.name<>'' THEN EXCLUDED.name ELSE watched_clubs.name END,last_viewed=EXTRACT(EPOCH FROM NOW())::BIGINT`,
      [club.platform||DEFAULT_PLATFORM,String(club.club_id),String(club.name||'Les Mannequins')]);
  }
}

async function hydrateAndScore(store,club){
  try{await syncClub(store,{club_id:club.club_id,name:club.name},club.platform||DEFAULT_PLATFORM)}catch(e){console.warn(`[PRIORITY22] sync ${club.club_id}: ${e.message}`)}
  const fresh=await store.one(`SELECT platform,club_id,name FROM clubs WHERE platform=$1 AND club_id=$2`,[club.platform||DEFAULT_PLATFORM,String(club.club_id)]);
  if(fresh?.name)club={...club,name:fresh.name};
  const players=await store.q(`SELECT name,player_id,club_name FROM players WHERE platform=$1 AND club_id=$2 ORDER BY updated_at DESC`,[club.platform||DEFAULT_PLATFORM,String(club.club_id)]);
  const hits=knownHits(players),nameScore=isTargetName(club.name)?200:0,exact=norm(club.name)==='lesmannequins'?200:0;
  return{club,players,hits,score:exact+nameScore+hits*150};
}

async function directEaSearch(store,found){
  for(const platform of PLATFORMS){
    for(const q of QUERIES){
      for(const endpoint of ['/currentSeasonLeaderboard/search','/allTimeLeaderboard/search']){
        try{
          const payload=await ea(endpoint,{platform,clubName:q,maxResultCount:50});
          const clubs=await extractClubs(store,payload,platform);
          const names=clubs.slice(0,8).map(c=>`${c.name}#${c.id}`).join(' | ');
          console.log(`[PRIORITY22] EA search platform=${platform} q="${q}" endpoint=${endpoint} results=${clubs.length}${names?` :: ${names}`:''}`);
          for(const c of clubs){
            if(isTargetName(c.name)){
              found.set(`${platform}|${c.id}`,{platform,club_id:String(c.id),name:c.name});
              console.log(`[PRIORITY22] NAME HIT platform=${platform} club=${c.name} id=${c.id}`);
            }
          }
        }catch(e){console.warn(`[PRIORITY22] EA search failed platform=${platform} q="${q}" endpoint=${endpoint}: ${e.message}`)}
        await sleep(gap());
      }
      if(found.size)break;
    }
    if(found.size)break;
  }
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
  for(const c of local){
    found.set(`${c.platform}|${c.club_id}`,c);
    console.log(`[PRIORITY22] local name candidate platform=${c.platform} club=${c.name} id=${c.club_id}`);
  }

  if(!found.size)await directEaSearch(store,found);
  if(!found.size){console.warn('[PRIORITY22] Les Mannequins not found yet after corrected EA search');return null}

  const scored=[];
  for(const club of [...found.values()].slice(0,20)){
    scored.push(await hydrateAndScore(store,club));
    await sleep(gap());
  }
  scored.sort((a,b)=>b.score-a.score||b.players.length-a.players.length);
  for(const x of scored.slice(0,8))console.log(`[PRIORITY22] candidate ${x.club.name} id=${x.club.club_id} platform=${x.club.platform} players=${x.players.length} knownHits=${x.hits} score=${x.score}`);
  const best=scored[0];
  if(!best)return null;
  if(!isTargetName(best.club.name)&&best.hits<2){console.warn(`[PRIORITY22] candidates found but confidence too low best=${best.club.name} hits=${best.hits}`);return null}
  await markPriority(store,best.club);
  console.log(`[PRIORITY22] selected ${best.club.name} id=${best.club.club_id} platform=${best.club.platform} players=${best.players.length} knownHits=${best.hits}`);
  if(best.players.length)console.log(`[PRIORITY22] roster ${best.players.map(x=>x.name).join(', ')}`);
  return best.club;
}

async function refresh(store){
  if(running||store.mode!=='postgres')return;
  running=true;
  try{
    const platform=await store.meta(META_PLATFORM,DEFAULT_PLATFORM),clubId=await store.meta(META_CLUB,'');
    if(clubId){
      const club=await store.one(`SELECT platform,club_id,name FROM clubs WHERE platform=$1 AND club_id=$2`,[platform,clubId]);
      if(club){
        const scored=await hydrateAndScore(store,club);
        await markPriority(store,scored.club);
        console.log(`[PRIORITY22] refreshed ${scored.club.name} id=${scored.club.club_id} players=${scored.players.length} knownHits=${scored.hits}`);
        if(scored.players.length)console.log(`[PRIORITY22] roster ${scored.players.map(x=>x.name).join(', ')}`);
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
  console.log('[PRIORITY22] Les Mannequins priority indexing enabled + corrected EA search');
  setTimeout(()=>refresh(this),10000).unref();
  setInterval(()=>refresh(this),5*60000).unref();
};