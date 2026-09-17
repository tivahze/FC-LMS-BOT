import {Store} from './store5.js';
import {ea,extractClubs,syncClub} from './crawler5.js';
import {sleep,gap,norm} from './constants.js';

const PLATFORM='common-gen5';
const META_PLATFORM='priority:les-mannequins:platform';
const META_CLUB='priority:les-mannequins:club_id';
const QUERIES=['Les Mannequins','Mannequins','FC Mannequins','FC Mannequin','Mannequin'];
const PLAYER_HINTS=['Tivahze','gorux08','gorux','ScOtche06','scotche','OCTechelle','Oct Echelle','oct'].map(norm);
let running=false;

const isTargetName=name=>norm(name).includes('mannequin');
const knownHits=players=>{
  const names=players.map(x=>norm(x.name));
  return PLAYER_HINTS.filter(h=>names.some(n=>n===h||n.includes(h)||h.includes(n))).length;
};

async function markPriority(store,club){
  await store.setMeta(META_PLATFORM,club.platform||PLATFORM);
  await store.setMeta(META_CLUB,club.club_id);
  if(store.mode==='postgres'){
    await store.pool.query(`INSERT INTO watched_clubs(platform,club_id,name,last_viewed,last_polled,first_seen)
      VALUES($1,$2,$3,EXTRACT(EPOCH FROM NOW())::BIGINT,0,EXTRACT(EPOCH FROM NOW())::BIGINT)
      ON CONFLICT(platform,club_id) DO UPDATE SET name=EXCLUDED.name,last_viewed=EXTRACT(EPOCH FROM NOW())::BIGINT`,
      [club.platform||PLATFORM,String(club.club_id),String(club.name||'Les Mannequins')]);
  }
}

async function hydrateAndScore(store,club){
  try{await syncClub(store,{club_id:club.club_id,name:club.name},club.platform||PLATFORM)}catch(e){console.warn(`[PRIORITY22] sync ${club.club_id}: ${e.message}`)}
  const players=await store.q(`SELECT name,player_id,club_name FROM players WHERE platform=$1 AND club_id=$2 ORDER BY updated_at DESC`,[club.platform||PLATFORM,String(club.club_id)]);
  const hits=knownHits(players),nameScore=isTargetName(club.name)?100:0,exact=norm(club.name)==='lesmannequins'?100:0;
  return{club,players,hits,score:exact+nameScore+hits*60};
}

async function discover(store){
  const found=new Map();
  const local=await store.q(`SELECT platform,club_id,name FROM clubs WHERE platform=$1 AND name_norm LIKE '%mannequin%' ORDER BY updated_at DESC LIMIT 20`,[PLATFORM]);
  for(const c of local)found.set(String(c.club_id),c);
  for(const q of QUERIES){
    for(const endpoint of ['/currentSeasonLeaderboard/search','/allTimeLeaderboard/search']){
      try{
        const clubs=await extractClubs(store,await ea(endpoint,{platform:PLATFORM,clubName:q,maxResultCount:100}),PLATFORM);
        for(const c of clubs)if(isTargetName(c.name))found.set(String(c.id),{platform:PLATFORM,club_id:String(c.id),name:c.name});
      }catch(e){console.warn(`[PRIORITY22] search ${q}: ${e.message}`)}
      await sleep(gap());
    }
  }
  if(!found.size){console.warn('[PRIORITY22] Les Mannequins not found yet');return null}
  const scored=[];
  for(const club of [...found.values()].slice(0,8)){
    scored.push(await hydrateAndScore(store,club));
    await sleep(gap());
  }
  scored.sort((a,b)=>b.score-a.score||b.players.length-a.players.length);
  const best=scored[0];
  if(!best)return null;
  await markPriority(store,best.club);
  console.log(`[PRIORITY22] selected ${best.club.name} id=${best.club.club_id} players=${best.players.length} knownHits=${best.hits}`);
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
        const scored=await hydrateAndScore(store,club);
        await markPriority(store,club);
        console.log(`[PRIORITY22] refreshed ${club.name} id=${club.club_id} players=${scored.players.length} knownHits=${scored.hits}`);
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
  console.log('[PRIORITY22] Les Mannequins priority indexing enabled');
  setTimeout(()=>refresh(this),15000).unref();
  setInterval(()=>refresh(this),10*60000).unref();
};
