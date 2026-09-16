import {Store} from './store5.js';

const n=v=>Number(v||0);
const parseSpec=(value,fallback='games:desc')=>{
  const [rawKey,rawDir]=String(value||fallback).split(':');
  return{key:rawKey||fallback.split(':')[0],dir:rawDir==='asc'?'ASC':'DESC',dirName:rawDir==='asc'?'asc':'desc'};
};
const playerPosition=`CASE WHEN raw_json IS NOT NULL AND raw_json<>'' THEN COALESCE(raw_json::jsonb->>'position',raw_json::jsonb->>'proPosition',raw_json::jsonb->>'positionName',raw_json::jsonb->>'role','') ELSE '' END`;

const oldPaged=Store.prototype.paged;
Store.prototype.paged=async function(table,q,p,sort,page,limit){
  if(this.mode!=='postgres')return oldPaged.call(this,table,q,p,String(sort||'').split(':')[0],page,limit);
  page=Math.max(1,n(page)||1);limit=Math.min(100,Math.max(10,n(limit)||50));const offset=(page-1)*limit,pat=`%${q||''}%`;
  if(table==='clubs'){
    const spec=parseSpec(sort,'skill:desc');
    const exprs={name:'name',platform:'platform',skill:'skill',games:'games',wins:'wins',draws:'draws',losses:'losses',winrate:`CASE WHEN games>0 THEN wins::double precision/games*100 ELSE 0 END`,recent:'updated_at'};
    const expr=exprs[spec.key]||exprs.skill;
    const total=n((await this.one(`SELECT COUNT(*) c FROM clubs WHERE($1='' OR platform=$1)AND($2='' OR name_norm LIKE $3)`,[p||'',q||'',pat]))?.c);
    const items=await this.q(`SELECT platform,club_id,name,skill,wins,draws,losses,games,updated_at FROM clubs WHERE($1='' OR platform=$1)AND($2='' OR name_norm LIKE $3) ORDER BY ${expr} ${spec.dir} NULLS LAST,name ASC LIMIT $4 OFFSET $5`,[p||'',q||'',pat,limit,offset]);
    return{total,items};
  }
  const spec=parseSpec(sort,'games:desc');
  const exprs={name:'name',club:'club_name',platform:'platform',position:playerPosition,rating:'rating',games:'games',goals:'goals',assists:'assists',contributions:'(goals+assists)',recent:'updated_at'};
  const expr=exprs[spec.key]||exprs.games;
  const total=n((await this.one(`SELECT COUNT(*) c FROM players WHERE($1='' OR platform=$1)AND($2='' OR name_norm LIKE $3)`,[p||'',q||'',pat]))?.c);
  const items=await this.q(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating,updated_at,raw_json,${playerPosition} position FROM players WHERE($1='' OR platform=$1)AND($2='' OR name_norm LIKE $3) ORDER BY ${expr} ${spec.dir} NULLS LAST,name ASC LIMIT $4 OFFSET $5`,[p||'',q||'',pat,limit,offset]);
  return{total,items};
};

const oldRankings=Store.prototype.v8Rankings;
Store.prototype.v8Rankings=async function(type='player',metric='goals:desc',platform='',minGames=3,page=1,limit=50){
  if(this.mode!=='postgres')return oldRankings.call(this,type,String(metric||'').split(':')[0],platform,minGames,page,limit);
  page=Math.max(1,n(page)||1);limit=Math.min(100,Math.max(10,n(limit)||50));minGames=Math.max(0,n(minGames));const offset=(page-1)*limit;
  if(type==='club'){
    const spec=parseSpec(metric,'skill:desc');
    const exprs={name:'name',platform:'platform',skill:'skill',games:'games',wins:'wins',draws:'draws',losses:'losses',winrate:`CASE WHEN games>0 THEN wins::double precision/games*100 ELSE 0 END`};
    const expr=exprs[spec.key]||exprs.skill;
    const total=n((await this.one(`SELECT COUNT(*) c FROM clubs WHERE($1='' OR platform=$1)AND games>=$2`,[platform,minGames]))?.c);
    const items=await this.q(`SELECT platform,club_id,name,skill,wins,draws,losses,games,CASE WHEN games>0 THEN wins::double precision/games*100 ELSE 0 END winrate FROM clubs WHERE($1='' OR platform=$1)AND games>=$2 ORDER BY ${expr} ${spec.dir} NULLS LAST,games DESC,name ASC LIMIT $3 OFFSET $4`,[platform,minGames,limit,offset]);
    return{type:'club',metric:spec.key,dir:spec.dirName,page,pages:Math.max(1,Math.ceil(total/limit)),total,items};
  }
  const spec=parseSpec(metric,'goals:desc');
  const exprs={name:'name',club:'club_name',platform:'platform',position:playerPosition,rating:'rating',games:'games',goals:'goals',assists:'assists',contributions:'(goals+assists)',gpg:`CASE WHEN games>0 THEN goals::double precision/games ELSE 0 END`,apg:`CASE WHEN games>0 THEN assists::double precision/games ELSE 0 END`};
  const expr=exprs[spec.key]||exprs.goals;
  const total=n((await this.one(`SELECT COUNT(*) c FROM players WHERE($1='' OR platform=$1)AND games>=$2`,[platform,minGames]))?.c);
  const items=await this.q(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating,raw_json,${playerPosition} position,CASE WHEN games>0 THEN goals::double precision/games ELSE 0 END gpg,CASE WHEN games>0 THEN assists::double precision/games ELSE 0 END apg,(goals+assists) contributions FROM players WHERE($1='' OR platform=$1)AND games>=$2 ORDER BY ${expr} ${spec.dir} NULLS LAST,games DESC,name ASC LIMIT $3 OFFSET $4`,[platform,minGames,limit,offset]);
  return{type:'player',metric:spec.key,dir:spec.dirName,page,pages:Math.max(1,Math.ceil(total/limit)),total,items};
};
console.log('[SORTING16] click-to-sort ascending/descending enabled');
