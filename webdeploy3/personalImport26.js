import http from 'node:http';
import pg from 'pg';
import {cuid,puid,norm,num} from './constants.js';

const {Pool}=pg;
const ROUTE='/api/v26/personal-import';
const DEFAULT_PLATFORM='common-gen5';
const MAX_BODY=Math.max(10,Number(process.env.IMPORT26_MAX_MB||100))*1024*1024;
const SQL_CHUNK=Math.max(250,Number(process.env.IMPORT26_SQL_CHUNK||2500));
let pool=null;

const getPool=()=>{
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL requis');
  if(!pool)pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:4});
  return pool;
};

const text=(v,d='')=>String(v??d).trim();
const knownPlatform=(v)=>['common-gen5','common-gen4','nx'].includes(text(v))?text(v):DEFAULT_PLATFORM;

function clubRow(x){
  const sourceId=text(x.team_id??x.teamId??x.club_id??x.clubId);
  const name=text(x.team_name??x.teamName??x.club_name??x.clubName??x.name);
  if(!sourceId||!name)return null;
  const platform=knownPlatform(x.platform);
  const id=sourceId.startsWith('cc-')?sourceId:`cc-${sourceId}`;
  return{
    uid:cuid(platform,id),platform,club_id:id,name,name_norm:norm(name),
    skill:0,wins:0,draws:0,losses:0,
    games:num(x.games_sum??x.games??x.matches??0),
    raw_json:JSON.stringify({...x,source:'club-champions-personal-export',sourceTeamId:sourceId})
  };
}

function playerRow(x){
  const name=text(x.name??x.player_name??x.playerName);
  const ccId=text(x.player_id??x.playerId??x.id);
  const externalId=text(x.external_id??x.externalId);
  if(!name||(!ccId&&!externalId))return null;
  const platform=knownPlatform(x.platform);
  const id=externalId||`cc-${ccId}`;
  const sourceTeamId=text(x.team_id??x.teamId??x.club_id??x.clubId);
  const clubId=sourceTeamId?(sourceTeamId.startsWith('cc-')?sourceTeamId:`cc-${sourceTeamId}`):'';
  const clubName=text(x.team_name??x.teamName??x.club_name??x.clubName);
  let rating=num(x.rating_weighted??x.globalRating??x.rating??0);
  if(rating>10&&rating<=100)rating/=10;
  if(rating>100&&rating<=1000)rating/=100;
  if(rating>10)rating=0;
  return{
    uid:puid(platform,id),platform,player_id:id,name,name_norm:norm(name),club_id:clubId,club_name:clubName,
    games:num(x.games??x.matchCount??0),goals:num(x.goals??x.totalGoals??0),assists:num(x.assists??x.totalAssists??0),rating,
    raw_json:JSON.stringify({...x,source:'club-champions-personal-export',sourcePlayerId:ccId,sourceExternalId:externalId,sourceTeamId})
  };
}

function dedupe(rows){
  const m=new Map();
  for(const r of rows){
    const p=m.get(r.uid);
    if(!p){m.set(r.uid,r);continue}
    m.set(r.uid,{...p,...r,
      games:Math.max(num(p.games),num(r.games)),
      goals:Math.max(num(p.goals),num(r.goals)),
      assists:Math.max(num(p.assists),num(r.assists)),
      rating:num(r.rating)>0?num(r.rating):num(p.rating),
      club_id:r.club_id||p.club_id,club_name:r.club_name||p.club_name,
      raw_json:r.raw_json||p.raw_json
    });
  }
  return[...m.values()];
}

async function upsertClubs(db,rows){
  for(let i=0;i<rows.length;i+=SQL_CHUNK){
    const chunk=rows.slice(i,i+SQL_CHUNK);
    await db.query(`
      INSERT INTO clubs(uid,platform,club_id,name,name_norm,skill,wins,draws,losses,games,updated_at,raw_json)
      SELECT x.uid,x.platform,x.club_id,x.name,x.name_norm,x.skill,x.wins,x.draws,x.losses,x.games,EXTRACT(EPOCH FROM NOW())::BIGINT,x.raw_json
      FROM jsonb_to_recordset($1::jsonb) AS x(uid text,platform text,club_id text,name text,name_norm text,skill double precision,wins integer,draws integer,losses integer,games integer,raw_json text)
      ON CONFLICT(uid) DO UPDATE SET
        name=EXCLUDED.name,name_norm=EXCLUDED.name_norm,
        games=GREATEST(clubs.games,EXCLUDED.games),
        updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,
        raw_json=EXCLUDED.raw_json`,[JSON.stringify(chunk)]);
  }
}

async function upsertPlayers(db,rows){
  for(let i=0;i<rows.length;i+=SQL_CHUNK){
    const chunk=rows.slice(i,i+SQL_CHUNK);
    await db.query(`
      INSERT INTO players(uid,platform,player_id,name,name_norm,club_id,club_name,games,goals,assists,rating,updated_at,raw_json)
      SELECT x.uid,x.platform,x.player_id,x.name,x.name_norm,x.club_id,x.club_name,x.games,x.goals,x.assists,x.rating,EXTRACT(EPOCH FROM NOW())::BIGINT,x.raw_json
      FROM jsonb_to_recordset($1::jsonb) AS x(uid text,platform text,player_id text,name text,name_norm text,club_id text,club_name text,games integer,goals integer,assists integer,rating double precision,raw_json text)
      ON CONFLICT(uid) DO UPDATE SET
        name=EXCLUDED.name,name_norm=EXCLUDED.name_norm,
        club_id=CASE WHEN EXCLUDED.club_id<>'' THEN EXCLUDED.club_id ELSE players.club_id END,
        club_name=CASE WHEN EXCLUDED.club_name<>'' THEN EXCLUDED.club_name ELSE players.club_name END,
        games=GREATEST(players.games,EXCLUDED.games),
        goals=GREATEST(players.goals,EXCLUDED.goals),
        assists=GREATEST(players.assists,EXCLUDED.assists),
        rating=CASE WHEN EXCLUDED.rating>0 THEN EXCLUDED.rating ELSE players.rating END,
        updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,
        raw_json=EXCLUDED.raw_json`,[JSON.stringify(chunk)]);
  }
}

function authorized(req,u){
  const a=process.env.ADMIN_TOKEN||'';
  const b=process.env.IMPORT26_TOKEN||'';
  const got=text(req.headers['x-import-token']||req.headers['x-admin-token']||u.searchParams.get('key'));
  return !!got&&((a&&got===a)||(b&&got===b));
}
function json(res,code,data){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
async function readBody(req){
  const parts=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw new Error(`Fichier trop volumineux (max ${Math.floor(MAX_BODY/1024/1024)} MB)`);parts.push(chunk)}
  return Buffer.concat(parts).toString('utf8');
}

async function importRows(kind,input){
  const arr=Array.isArray(input)?input:Array.isArray(input?.data)?input.data:[];
  if(!arr.length)throw new Error('Aucune ligne à importer');
  const rows=dedupe(arr.map(kind==='clubs'?clubRow:playerRow).filter(Boolean));
  if(!rows.length)throw new Error('Aucune ligne valide');
  const db=getPool();
  const before=(await db.query(`SELECT COUNT(*)::bigint n FROM ${kind==='clubs'?'clubs':'players'}`)).rows[0];
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    if(kind==='clubs')await upsertClubs(client,rows);else await upsertPlayers(client,rows);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  const after=(await db.query(`SELECT COUNT(*)::bigint n FROM ${kind==='clubs'?'clubs':'players'}`)).rows[0];
  return{accepted:rows.length,new:Number(after.n)-Number(before.n),total:Number(after.n)};
}

const originalCreateServer=http.createServer.bind(http);
http.createServer=function patchedCreateServer(listener){
  return originalCreateServer(async(req,res)=>{
    try{
      const u=new URL(req.url,'http://local');
      if(u.pathname!==ROUTE)return listener(req,res);
      if(!authorized(req,u))return json(res,404,{error:'not found'});
      if(req.method==='GET')return json(res,200,{ok:true,route:ROUTE,kinds:['clubs','players'],chunkRecommended:1000});
      if(req.method!=='POST')return json(res,405,{error:'POST requis'});
      const kind=text(u.searchParams.get('kind')).toLowerCase();
      if(!['clubs','players'].includes(kind))return json(res,400,{error:'kind=clubs ou kind=players requis'});
      const body=JSON.parse(await readBody(req)||'[]');
      const t0=Date.now(),result=await importRows(kind,body);
      console.log(`[IMPORT26] kind=${kind} accepted=${result.accepted} new=${result.new} total=${result.total} ms=${Date.now()-t0}`);
      return json(res,200,{ok:true,kind,...result,durationMs:Date.now()-t0});
    }catch(e){console.error('[IMPORT26]',e.message);return json(res,400,{error:e.message})}
  });
};

console.log(`[IMPORT26] personal export importer enabled route=${ROUTE}`);
