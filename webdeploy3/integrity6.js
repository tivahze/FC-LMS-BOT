import {Store} from './store5.js';
import {norm,num} from './constants.js';

const numericId=v=>/^\d+$/.test(String(v||''));

async function mergeOne(store,oldRow,newRow){
  if(!oldRow||!newRow||oldRow.uid===newRow.uid)return 0;
  const rating=(num(oldRow.games)>num(newRow.games)&&num(oldRow.rating)>0)?num(oldRow.rating):(num(newRow.rating)>0?num(newRow.rating):num(oldRow.rating));
  const raw=String(oldRow.raw_json||'').length>String(newRow.raw_json||'').length?oldRow.raw_json:newRow.raw_json;
  await store.pool.query(`UPDATE players SET name=$1,name_norm=$2,club_id=$3,club_name=$4,games=GREATEST(games,$5),goals=GREATEST(goals,$6),assists=GREATEST(assists,$7),rating=$8,raw_json=$9,updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE uid=$10`,[oldRow.name||newRow.name,norm(oldRow.name||newRow.name),newRow.club_id||oldRow.club_id,newRow.club_name||oldRow.club_name,num(oldRow.games),num(oldRow.goals),num(oldRow.assists),rating,raw,newRow.uid]);
  const oldApps=await store.q('SELECT * FROM match_players WHERE platform=$1 AND player_id=$2 AND club_id=$3',[oldRow.platform,oldRow.player_id,oldRow.club_id]);
  for(const a of oldApps){
    const uid=`${a.match_uid}:${newRow.player_id}:${a.club_id}`;
    await store.pool.query(`INSERT INTO match_players(uid,match_uid,platform,player_id,name,club_id,club_name,position,goals,assists,rating,raw_json)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(uid) DO UPDATE SET name=EXCLUDED.name,position=CASE WHEN EXCLUDED.position<>'' THEN EXCLUDED.position ELSE match_players.position END,goals=GREATEST(match_players.goals,EXCLUDED.goals),assists=GREATEST(match_players.assists,EXCLUDED.assists),rating=CASE WHEN EXCLUDED.rating>0 THEN EXCLUDED.rating ELSE match_players.rating END,raw_json=CASE WHEN LENGTH(EXCLUDED.raw_json)>LENGTH(match_players.raw_json) THEN EXCLUDED.raw_json ELSE match_players.raw_json END`,[uid,a.match_uid,a.platform,newRow.player_id,a.name,a.club_id,a.club_name,a.position,num(a.goals),num(a.assists),num(a.rating),a.raw_json]);
  }
  await store.pool.query('DELETE FROM match_players WHERE platform=$1 AND player_id=$2 AND club_id=$3',[oldRow.platform,oldRow.player_id,oldRow.club_id]);
  await store.pool.query('DELETE FROM players WHERE uid=$1',[oldRow.uid]);
  return 1;
}

async function mergePlayerAliases(store){
  const rows=await store.q(`SELECT * FROM players ORDER BY platform,club_id,name_norm,games DESC,updated_at DESC`);
  const groups=new Map();
  for(const r of rows){const k=`${r.platform}|${r.club_id}|${r.name_norm}`;if(!r.name_norm)continue;(groups.get(k)||groups.set(k,[]).get(k)).push(r)}
  let merged=0;
  for(const g of groups.values()){
    if(g.length<2)continue;
    const nums=g.filter(x=>numericId(x.player_id));
    const fallbacks=g.filter(x=>!numericId(x.player_id)&&norm(x.player_id)===x.name_norm);
    if(!nums.length||!fallbacks.length)continue;
    const canonical=[...nums].sort((a,b)=>String(b.raw_json||'').length-String(a.raw_json||'').length||num(b.rating)-num(a.rating))[0];
    for(const old of fallbacks)merged+=await mergeOne(store,old,canonical);
  }
  return merged;
}

async function repairPlaceholders(store){
  const placeholders=await store.q(`SELECT * FROM clubs WHERE LOWER(TRIM(name))='club' AND games=0 AND skill=0 AND LENGTH(COALESCE(raw_json,''))<80`);
  for(const c of placeholders){
    const label=`Club #${c.club_id}`;
    await store.pool.query('UPDATE clubs SET name=$1,name_norm=$2,synced_at=0 WHERE uid=$3',[label,norm(label),c.uid]);
    await store.pool.query(`UPDATE players SET club_name=$1 WHERE platform=$2 AND club_id=$3 AND LOWER(TRIM(club_name))='club'`,[label,c.platform,c.club_id]);
    await store.pool.query(`UPDATE matches SET home_name=$1 WHERE platform=$2 AND home_club_id=$3 AND LOWER(TRIM(home_name))='club'`,[label,c.platform,c.club_id]);
    await store.pool.query(`UPDATE matches SET away_name=$1 WHERE platform=$2 AND away_club_id=$3 AND LOWER(TRIM(away_name))='club'`,[label,c.platform,c.club_id]);
    await store.pool.query(`UPDATE match_players SET club_name=$1 WHERE platform=$2 AND club_id=$3 AND LOWER(TRIM(club_name))='club'`,[label,c.platform,c.club_id]);
  }
  return placeholders.length;
}

async function integrity(store){
  const before=await store.dashboard();
  const merged=await mergePlayerAliases(store);
  const placeholders=await repairPlaceholders(store);
  const marker=await store.meta('integrity6_refetch','0');
  if(marker!=='1'){
    await store.pool.query('UPDATE clubs SET synced_at=0');
    await store.setMeta('integrity6_refetch','1');
  }
  const after=await store.dashboard();
  console.log(`[DB-INTEGRITY-V6] playersMerged=${merged} placeholdersRenamed=${placeholders} clubs=${before.clubs}->${after.clubs} players=${before.players}->${after.players} matches=${before.matches}->${after.matches} appearances=${before.appearances}->${after.appearances}`);
}

const originalInit=Store.prototype.init;
Store.prototype.init=async function(){await originalInit.call(this);if(this.mode==='postgres')await integrity(this)};

const originalUpsertPlayer=Store.prototype.upsertPlayer;
Store.prototype.upsertPlayer=async function(x,platform,clubId='',clubName=''){
  let y={...x};
  if(this.mode==='postgres'&&clubId&&y.name){
    const n=norm(y.name),id=String(y.id||y.name);
    if(!numericId(id)&&norm(id)===n){
      const known=await this.one(`SELECT * FROM players WHERE platform=$1 AND club_id=$2 AND name_norm=$3 AND player_id ~ '^[0-9]+$' ORDER BY LENGTH(COALESCE(raw_json,'')) DESC LIMIT 1`,[platform,String(clubId),n]);
      if(known)y.id=known.player_id;
    }
  }
  await originalUpsertPlayer.call(this,y,platform,clubId,clubName);
  if(this.mode==='postgres'&&clubId&&numericId(y.id)&&y.name){
    const canonical=await this.one('SELECT * FROM players WHERE platform=$1 AND player_id=$2',[platform,String(y.id)]);
    const olds=await this.q(`SELECT * FROM players WHERE platform=$1 AND club_id=$2 AND name_norm=$3 AND player_id<>$4 AND player_id !~ '^[0-9]+$'`,[platform,String(clubId),norm(y.name),String(y.id)]);
    for(const old of olds)if(norm(old.player_id)===norm(old.name))await mergeOne(this,old,canonical);
  }
};
