import http from 'node:http';
import pg from 'pg';
import {cuid,puid,norm,num} from './constants.js';

const {Pool}=pg;
const ROUTE='/api/v25/bulk-import';
const DEFAULT_PLATFORM='common-gen5';
const MAX_BODY=Math.max(10,Number(process.env.BULK25_MAX_MB||100))*1024*1024;
const SQL_CHUNK=Math.max(250,Number(process.env.BULK25_SQL_CHUNK||3000));
let pool=null;

const getPool=()=>{
  if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL requis');
  if(!pool)pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:4});
  return pool;
};

const text=(v,d='')=>String(v??d).trim();
const platformOf=(x,d=DEFAULT_PLATFORM)=>text(x.platform??x.platform_id??x.platformId,d)||d;
const pick=(x,...keys)=>{for(const k of keys)if(x?.[k]!==undefined&&x?.[k]!==null&&x?.[k]!=='')return x[k];return undefined};

function clubRow(x,defaultPlatform){
  const platform=platformOf(x,defaultPlatform);
  const id=text(pick(x,'club_id','clubId','clubID','id'));
  const name=text(pick(x,'club_name','clubName','name','teamName'));
  if(!id||!name)return null;
  return{
    uid:cuid(platform,id),platform,club_id:id,name,name_norm:norm(name),
    skill:num(pick(x,'skill','skillRating','skillrating')),
    wins:num(pick(x,'wins','win')),draws:num(pick(x,'draws','ties','tie')),
    losses:num(pick(x,'losses','loss')),games:num(pick(x,'games','gamesPlayed','matches')),
    raw_json:JSON.stringify(x)
  };
}

function playerRow(x,defaultPlatform){
  const platform=platformOf(x,defaultPlatform);
  const name=text(pick(x,'name','player_name','playerName','gamertag','eaId','displayName','proName'));
  const id=text(pick(x,'player_id','playerId','personaId','persona_id','blazeId','id')??name);
  if(!id||!name)return null;
  const clubId=text(pick(x,'club_id','clubId','clubID'));
  const clubName=text(pick(x,'club_name','clubName','teamName'));
  let rating=num(pick(x,'rating','ratingAve','averageRating','avgRating'));
  if(rating>10&&rating<=100)rating/=10;if(rating>100&&rating<=1000)rating/=100;if(rating>10)rating=0;
  return{
    uid:puid(platform,id),platform,player_id:id,name,name_norm:norm(name),club_id:clubId,club_name:clubName,
    games:num(pick(x,'games','gamesPlayed','appearances','matches')),
    goals:num(pick(x,'goals')),assists:num(pick(x,'assists')),rating,
    raw_json:JSON.stringify(x)
  };
}

function parseCsv(src){
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<src.length;i++){
    const c=src[i];
    if(quoted){if(c==='"'&&src[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;continue;}
    if(c==='"'){quoted=true;continue}if(c===','){row.push(field);field='';continue}if(c==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';continue}field+=c;
  }
  if(field||row.length){row.push(field.replace(/\r$/,''));rows.push(row)}
  if(rows.length<2)return[];
  const headers=rows.shift().map(x=>x.trim());
  return rows.filter(r=>r.some(v=>String(v).trim())).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??''])));
}

function decodeBody(raw,contentType){
  const s=raw.toString('utf8').replace(/^\uFEFF/,'');
  if(contentType.includes('text/csv')||contentType.includes('application/csv'))return parseCsv(s);
  if(contentType.includes('ndjson')||contentType.includes('x-ndjson'))return s.split(/\r?\n/).map(x=>x.trim()).filter(Boolean).map(x=>JSON.parse(x));
  return JSON.parse(s||'{}');
}

function splitPayload(payload,defaultPlatform){
  let clubs=[],players=[];
  if(Array.isArray(payload)){
    for(const x of payload){
      const t=text(x?.type??x?.entity).toLowerCase();
      const looksPlayer=t==='player'||t==='joueur'||pick(x,'player_id','playerId','personaId','gamertag','playerName')!==undefined;
      if(looksPlayer){const r=playerRow(x,defaultPlatform);if(r)players.push(r)}else{const r=clubRow(x,defaultPlatform);if(r)clubs.push(r)}
    }
  }else if(payload&&typeof payload==='object'){
    const dp=text(payload.defaultPlatform??payload.platform,defaultPlatform)||defaultPlatform;
    for(const x of Array.isArray(payload.clubs)?payload.clubs:[]){const r=clubRow(x,dp);if(r)clubs.push(r)}
    for(const x of Array.isArray(payload.players)?payload.players:[]){const r=playerRow(x,dp);if(r)players.push(r)}
    if(!payload.clubs&&!payload.players){
      const looksPlayer=pick(payload,'player_id','playerId','personaId','gamertag','playerName')!==undefined;
      const r=looksPlayer?playerRow(payload,dp):clubRow(payload,dp);if(r)(looksPlayer?players:clubs).push(r);
    }
  }
  return{clubs,players};
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
        skill=CASE WHEN EXCLUDED.skill>0 THEN EXCLUDED.skill ELSE clubs.skill END,
        wins=GREATEST(clubs.wins,EXCLUDED.wins),draws=GREATEST(clubs.draws,EXCLUDED.draws),
        losses=GREATEST(clubs.losses,EXCLUDED.losses),games=GREATEST(clubs.games,EXCLUDED.games),
        updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,
        raw_json=CASE WHEN length(EXCLUDED.raw_json)>2 THEN EXCLUDED.raw_json ELSE clubs.raw_json END`,[JSON.stringify(chunk)]);
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
        games=GREATEST(players.games,EXCLUDED.games),goals=GREATEST(players.goals,EXCLUDED.goals),assists=GREATEST(players.assists,EXCLUDED.assists),
        rating=CASE WHEN EXCLUDED.rating>0 THEN EXCLUDED.rating ELSE players.rating END,
        updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,
        raw_json=CASE WHEN length(EXCLUDED.raw_json)>2 THEN EXCLUDED.raw_json ELSE players.raw_json END`,[JSON.stringify(chunk)]);
  }
}

async function importPayload(payload,defaultPlatform=DEFAULT_PLATFORM){
  const db=getPool();
  const {clubs,players}=splitPayload(payload,defaultPlatform);
  if(!clubs.length&&!players.length)throw new Error('Aucun club ou joueur valide dans le fichier');
  const before=(await db.query('SELECT (SELECT COUNT(*) FROM clubs)::bigint clubs,(SELECT COUNT(*) FROM players)::bigint players')).rows[0];
  const client=await db.connect();
  try{
    await client.query('BEGIN');
    if(clubs.length)await upsertClubs(client,clubs);
    if(players.length)await upsertPlayers(client,players);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
  const after=(await db.query('SELECT (SELECT COUNT(*) FROM clubs)::bigint clubs,(SELECT COUNT(*) FROM players)::bigint players')).rows[0];
  return{
    accepted:{clubs:clubs.length,players:players.length,total:clubs.length+players.length},
    new:{clubs:Number(after.clubs)-Number(before.clubs),players:Number(after.players)-Number(before.players)},
    totals:{clubs:Number(after.clubs),players:Number(after.players)},sqlChunk:SQL_CHUNK
  };
}

function authorized(req,u){
  const expected=process.env.ADMIN_TOKEN||'';
  if(!expected)return false;
  return (req.headers['x-admin-token']||u.searchParams.get('key')||'')===expected;
}
function json(res,code,data){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
async function readBody(req){
  const parts=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw new Error(`Fichier trop volumineux (max ${Math.floor(MAX_BODY/1024/1024)} MB)`);parts.push(chunk)}
  return Buffer.concat(parts);
}

const originalCreateServer=http.createServer.bind(http);
http.createServer=function patchedCreateServer(listener){
  return originalCreateServer(async(req,res)=>{
    try{
      const u=new URL(req.url,'http://local');
      if(u.pathname!==ROUTE)return listener(req,res);
      if(!authorized(req,u))return json(res,404,{error:'not found'});
      if(req.method==='GET'){
        const db=getPool(),counts=(await db.query('SELECT (SELECT COUNT(*) FROM clubs)::bigint clubs,(SELECT COUNT(*) FROM players)::bigint players')).rows[0];
        return json(res,200,{ok:true,route:ROUTE,formats:['application/json','application/x-ndjson','text/csv'],maxMb:Math.floor(MAX_BODY/1024/1024),sqlChunk:SQL_CHUNK,totals:{clubs:Number(counts.clubs),players:Number(counts.players)}});
      }
      if(req.method!=='POST')return json(res,405,{error:'POST requis'});
      const raw=await readBody(req),contentType=text(req.headers['content-type']).toLowerCase(),payload=decodeBody(raw,contentType),defaultPlatform=text(u.searchParams.get('platform'),DEFAULT_PLATFORM)||DEFAULT_PLATFORM;
      const t0=Date.now(),result=await importPayload(payload,defaultPlatform);
      console.log(`[BULK25] imported clubs=${result.accepted.clubs} players=${result.accepted.players} newClubs=${result.new.clubs} newPlayers=${result.new.players} ms=${Date.now()-t0}`);
      return json(res,200,{ok:true,...result,durationMs:Date.now()-t0});
    }catch(e){console.error('[BULK25]',e.message);return json(res,400,{error:e.message})}
  });
};

console.log(`[BULK25] high-speed PostgreSQL bulk importer enabled route=${ROUTE} max=${Math.floor(MAX_BODY/1024/1024)}MB chunk=${SQL_CHUNK}`);
