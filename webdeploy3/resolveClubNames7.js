import {Store} from './store5.js';
import {ea,extractClubs} from './crawler5.js';
import {norm,sleep,num} from './constants.js';

const isPlaceholder=name=>/^club\s*#\d+$/i.test(String(name||'').trim())||/^club$/i.test(String(name||'').trim());
const publicName=(name,id)=>isPlaceholder(name)?`Nom du club indisponible${id?` (ID ${id})`:''}`:String(name||'Club inconnu');
const now=()=>Math.floor(Date.now()/1000);

async function ensureState(store){
  if(store.mode!=='postgres')return;
  await store.pool.query(`CREATE TABLE IF NOT EXISTS club_name_resolution_state(
    platform TEXT NOT NULL,
    club_id TEXT NOT NULL,
    failures INTEGER DEFAULT 0,
    last_attempt BIGINT DEFAULT 0,
    retry_after BIGINT DEFAULT 0,
    last_error TEXT DEFAULT '',
    PRIMARY KEY(platform,club_id)
  )`);
  await store.pool.query(`CREATE INDEX IF NOT EXISTS club_name_resolution_retry_idx ON club_name_resolution_state(retry_after,platform,club_id)`);
}

async function canRetry(store,platform,clubId){
  if(store.mode!=='postgres')return true;
  const row=await store.one(`SELECT retry_after FROM club_name_resolution_state WHERE platform=$1 AND club_id=$2`,[platform,String(clubId)]);
  return !row||num(row.retry_after)<=now();
}

async function markFailure(store,platform,clubId,error=''){ 
  if(store.mode!=='postgres')return;
  const prev=await store.one(`SELECT failures FROM club_name_resolution_state WHERE platform=$1 AND club_id=$2`,[platform,String(clubId)]);
  const failures=num(prev?.failures)+1;
  const delayHours=failures<=1?6:failures===2?24:failures===3?72:168;
  const retryAfter=now()+delayHours*3600;
  await store.pool.query(`INSERT INTO club_name_resolution_state(platform,club_id,failures,last_attempt,retry_after,last_error)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(platform,club_id) DO UPDATE SET failures=EXCLUDED.failures,last_attempt=EXCLUDED.last_attempt,retry_after=EXCLUDED.retry_after,last_error=EXCLUDED.last_error`,
    [platform,String(clubId),failures,now(),retryAfter,String(error||'').slice(0,300)]);
}

async function markSuccess(store,platform,clubId){
  if(store.mode==='postgres')await store.pool.query(`DELETE FROM club_name_resolution_state WHERE platform=$1 AND club_id=$2`,[platform,String(clubId)]);
}

async function applyResolvedName(store,platform,clubId,name){
  if(!name||isPlaceholder(name))return false;
  await store.pool.query(`UPDATE clubs SET name=$1,name_norm=$2,updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE platform=$3 AND club_id=$4`,[name,norm(name),platform,String(clubId)]);
  await store.pool.query(`UPDATE players SET club_name=$1 WHERE platform=$2 AND club_id=$3 AND (club_name='' OR LOWER(club_name)='club' OR club_name ~* '^club #[0-9]+$')`,[name,platform,String(clubId)]);
  await store.pool.query(`UPDATE matches SET home_name=$1 WHERE platform=$2 AND home_club_id=$3 AND (home_name='' OR LOWER(home_name)='club' OR home_name ~* '^club #[0-9]+$')`,[name,platform,String(clubId)]);
  await store.pool.query(`UPDATE matches SET away_name=$1 WHERE platform=$2 AND away_club_id=$3 AND (away_name='' OR LOWER(away_name)='club' OR away_name ~* '^club #[0-9]+$')`,[name,platform,String(clubId)]);
  await store.pool.query(`UPDATE match_players SET club_name=$1 WHERE platform=$2 AND club_id=$3 AND (club_name='' OR LOWER(club_name)='club' OR club_name ~* '^club #[0-9]+$')`,[name,platform,String(clubId)]);
  await markSuccess(store,platform,clubId);
  return true;
}

async function resolveOne(store,platform,clubId,{force=false}={}){
  if(!force&&!(await canRetry(store,platform,clubId)))return false;
  let lastError='not found';
  try{
    const payload=await ea('/clubs/info',{platform,clubIds:String(clubId)});
    const clubs=await extractClubs(store,payload,platform);
    const hit=clubs.find(c=>String(c.id)===String(clubId))||clubs[0];
    if(hit?.name&&!isPlaceholder(hit.name))return await applyResolvedName(store,platform,clubId,String(hit.name));
    lastError='EA returned no usable club name';
  }catch(e){lastError=e.message;console.warn(`[CLUB-NAME] ${platform}/${clubId}: ${e.message}`)}
  await markFailure(store,platform,clubId,lastError);
  return false;
}

async function resolvePlaceholders(store,limit=50){
  if(store.mode!=='postgres')return {found:0,resolved:0,skipped:0};
  await ensureState(store);
  const rows=await store.q(`SELECT c.platform,c.club_id,c.name
    FROM clubs c
    LEFT JOIN club_name_resolution_state s ON s.platform=c.platform AND s.club_id=c.club_id
    WHERE (LOWER(TRIM(c.name))='club' OR c.name ~* '^club #[0-9]+$')
      AND (s.retry_after IS NULL OR s.retry_after<=EXTRACT(EPOCH FROM NOW())::BIGINT)
    ORDER BY c.updated_at DESC
    LIMIT $1`,[limit]);
  const total=await store.one(`SELECT COUNT(*) c FROM clubs WHERE LOWER(TRIM(name))='club' OR name ~* '^club #[0-9]+$'`);
  let resolved=0;
  for(const r of rows){if(await resolveOne(store,r.platform,r.club_id))resolved++;await sleep(150)}
  const skipped=Math.max(0,num(total?.c)-rows.length);
  console.log(`[CLUB-NAME-RESOLVER] eligible=${rows.length} resolved=${resolved} cooldown=${skipped}`);
  return{found:rows.length,resolved,skipped};
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);
  if(this.mode==='postgres'){
    await ensureState(this);
    setTimeout(()=>resolvePlaceholders(this,50).catch(e=>console.warn('[CLUB-NAME-RESOLVER]',e.message)),1500).unref();
  }
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
  for(const clubId of [...unresolved.keys()].slice(0,8)){
    if(await canRetry(this,platform,clubId)){
      if(await resolveOne(this,platform,clubId))changed=true;
      await sleep(100);
    }
  }
  if(changed)r=await previousClubAdvanced.call(this,platform,id);

  r.matches=(r.matches||[]).map(m=>({...m,home_name:publicName(m.home_name,m.home_club_id),away_name:publicName(m.away_name,m.away_club_id)}));
  r.curve=(r.curve||[]).map(x=>({...x,opponent:publicName(x.opponent,x.opponent_id),home_name:publicName(x.home_name,x.home_club_id),away_name:publicName(x.away_name,x.away_club_id)}));
  r.opponents=(r.opponents||[]).map(o=>({...o,name:publicName(o.name,o.id)}));
  return r;
};
