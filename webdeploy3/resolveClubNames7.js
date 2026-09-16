import {Store} from './store5.js';
import {ea,extractClubs} from './crawler5.js';
import {norm,sleep} from './constants.js';

const isPlaceholder=name=>/^club\s*#\d+$/i.test(String(name||'').trim())||/^club$/i.test(String(name||'').trim());

async function applyResolvedName(store,platform,clubId,name){
  if(!name||isPlaceholder(name))return false;
  await store.pool.query(`UPDATE clubs SET name=$1,name_norm=$2,updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE platform=$3 AND club_id=$4`,[name,norm(name),platform,String(clubId)]);
  await store.pool.query(`UPDATE players SET club_name=$1 WHERE platform=$2 AND club_id=$3 AND (club_name='' OR LOWER(club_name)='club' OR club_name ~* '^club #[0-9]+$')`,[name,platform,String(clubId)]);
  await store.pool.query(`UPDATE matches SET home_name=$1 WHERE platform=$2 AND home_club_id=$3 AND (home_name='' OR LOWER(home_name)='club' OR home_name ~* '^club #[0-9]+$')`,[name,platform,String(clubId)]);
  await store.pool.query(`UPDATE matches SET away_name=$1 WHERE platform=$2 AND away_club_id=$3 AND (away_name='' OR LOWER(away_name)='club' OR away_name ~* '^club #[0-9]+$')`,[name,platform,String(clubId)]);
  await store.pool.query(`UPDATE match_players SET club_name=$1 WHERE platform=$2 AND club_id=$3 AND (club_name='' OR LOWER(club_name)='club' OR club_name ~* '^club #[0-9]+$')`,[name,platform,String(clubId)]);
  return true;
}

async function resolveOne(store,platform,clubId){
  try{
    const payload=await ea('/clubs/info',{platform,clubIds:String(clubId)});
    const clubs=await extractClubs(store,payload,platform);
    const hit=clubs.find(c=>String(c.id)===String(clubId))||clubs[0];
    if(hit?.name&&!isPlaceholder(hit.name))return await applyResolvedName(store,platform,clubId,String(hit.name));
  }catch(e){console.warn(`[CLUB-NAME] ${platform}/${clubId}: ${e.message}`)}
  return false;
}

async function resolvePlaceholders(store,limit=50){
  if(store.mode!=='postgres')return {found:0,resolved:0};
  const rows=await store.q(`SELECT platform,club_id,name FROM clubs WHERE LOWER(TRIM(name))='club' OR name ~* '^club #[0-9]+$' ORDER BY updated_at DESC LIMIT $1`,[limit]);
  let resolved=0;
  for(const r of rows){if(await resolveOne(store,r.platform,r.club_id))resolved++;await sleep(250)}
  console.log(`[CLUB-NAME-RESOLVER] found=${rows.length} resolved=${resolved} unresolved=${rows.length-resolved}`);
  return{found:rows.length,resolved};
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);
  if(this.mode==='postgres')await resolvePlaceholders(this,50);
};

const previousClubAdvanced=Store.prototype.clubAdvanced;
Store.prototype.clubAdvanced=async function(platform,id){
  let r=await previousClubAdvanced.call(this,platform,id);
  if(!r||this.mode!=='postgres')return r;
  const unresolved=new Map();
  for(const m of r.matches||[]){
    if(isPlaceholder(m.home_name)&&m.home_club_id)unresolved.set(String(m.home_club_id),m.home_name);
    if(isPlaceholder(m.away_name)&&m.away_club_id)unresolved.set(String(m.away_club_id),m.away_name);
  }
  let changed=false;
  for(const clubId of [...unresolved.keys()].slice(0,12)){if(await resolveOne(this,platform,clubId))changed=true;await sleep(200)}
  if(changed)r=await previousClubAdvanced.call(this,platform,id);
  return r;
};
