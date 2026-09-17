import http from 'node:http';
import pg from 'pg';
import {norm,num} from './constants.js';

const {Pool}=pg;
const ROUTE='/api/v26/cc-page-import';
const MAX_BODY=20*1024*1024;
let pool=null;
const db=()=>pool||(pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:4}));
const text=v=>String(v??'').trim();
const safePlatform=v=>{const s=text(v).toLowerCase();if(/switch|\bnx\b/.test(s))return'nx';if(/ps4|xbox.?one|gen4/.test(s))return'common-gen4';return'common-gen5'};
const segUid=x=>`CC26:${text(x.id)}:${norm(x.teamName)}:${text(x.pos)}:${text(x.archetypeId)}`;
const playerId=x=>`cc:${text(x.id)}`;
const clubId=name=>`ccname:${norm(name)}`;

async function initSchema(client){
  await client.query(`CREATE TABLE IF NOT EXISTS cc_player_segments(
    uid TEXT PRIMARY KEY,cc_id TEXT,external_id TEXT,platform TEXT,name TEXT,pos TEXT,season TEXT,
    match_count INTEGER DEFAULT 0,global_rating DOUBLE PRECISION DEFAULT 0,total_goals INTEGER DEFAULT 0,
    total_assists INTEGER DEFAULT 0,team_name TEXT,archetype_id TEXT,archetype_label TEXT,raw_json TEXT,updated_at BIGINT DEFAULT 0
  );CREATE INDEX IF NOT EXISTS cc_segments_player_idx ON cc_player_segments(cc_id);CREATE INDEX IF NOT EXISTS cc_segments_team_idx ON cc_player_segments(team_name);`)
}

async function importPage(payload){
  if(!payload||!Array.isArray(payload.data))throw new Error('Format Club Champions attendu: {data:[...],meta:{...}}');
  const rows=payload.data.filter(x=>x&&x.id!=null&&x.name).map(x=>({
    uid:segUid(x),cc_id:text(x.id),external_id:text(x.externalId),platform:safePlatform(x.platform),name:text(x.name),
    pos:text(x.pos),season:text(x.season||payload.meta?.season||'FC26'),match_count:num(x.matchCount),global_rating:num(x.globalRating),
    total_goals:num(x.totalGoals),total_assists:num(x.totalAssists),team_name:text(x.teamName),archetype_id:text(x.archetypeId),
    archetype_label:text(x.archetypeLabel),raw_json:JSON.stringify(x)
  }));
  if(!rows.length)throw new Error('Aucun joueur valide dans cette page');
  const client=await db().connect();
  try{
    await client.query('BEGIN');await initSchema(client);
    await client.query(`INSERT INTO cc_player_segments(uid,cc_id,external_id,platform,name,pos,season,match_count,global_rating,total_goals,total_assists,team_name,archetype_id,archetype_label,raw_json,updated_at)
      SELECT x.uid,x.cc_id,x.external_id,x.platform,x.name,x.pos,x.season,x.match_count,x.global_rating,x.total_goals,x.total_assists,x.team_name,x.archetype_id,x.archetype_label,x.raw_json,EXTRACT(EPOCH FROM NOW())::BIGINT
      FROM jsonb_to_recordset($1::jsonb) AS x(uid text,cc_id text,external_id text,platform text,name text,pos text,season text,match_count integer,global_rating double precision,total_goals integer,total_assists integer,team_name text,archetype_id text,archetype_label text,raw_json text)
      ON CONFLICT(uid) DO UPDATE SET external_id=EXCLUDED.external_id,platform=EXCLUDED.platform,name=EXCLUDED.name,pos=EXCLUDED.pos,season=EXCLUDED.season,match_count=EXCLUDED.match_count,global_rating=EXCLUDED.global_rating,total_goals=EXCLUDED.total_goals,total_assists=EXCLUDED.total_assists,team_name=EXCLUDED.team_name,archetype_id=EXCLUDED.archetype_id,archetype_label=EXCLUDED.archetype_label,raw_json=EXCLUDED.raw_json,updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT`,[JSON.stringify(rows)]);

    const ids=[...new Set(rows.map(r=>r.cc_id))];
    const segs=(await client.query('SELECT * FROM cc_player_segments WHERE cc_id=ANY($1::text[])',[ids])).rows;
    const groups=new Map();
    for(const s of segs){let g=groups.get(s.cc_id);if(!g){g={id:s.cc_id,name:s.name,platform:s.platform,externalId:s.external_id,games:0,goals:0,assists:0,weighted:0,teamName:'',teamGames:-1,segments:[]};groups.set(s.cc_id,g)}g.games+=num(s.match_count);g.goals+=num(s.total_goals);g.assists+=num(s.total_assists);g.weighted+=num(s.global_rating)*Math.max(1,num(s.match_count));g.segments.push(JSON.parse(s.raw_json||'{}'));if(num(s.match_count)>g.teamGames&&s.team_name){g.teamGames=num(s.match_count);g.teamName=s.team_name}}
    const players=[...groups.values()].map(g=>({uid:`FC26:${g.platform}:${playerId(g)}`,platform:g.platform,player_id:playerId(g),name:g.name,name_norm:norm(g.name),club_id:g.teamName?clubId(g.teamName):'',club_name:g.teamName,games:g.games,goals:g.goals,assists:g.assists,rating:g.games?g.weighted/g.games:0,raw_json:JSON.stringify({source:'club-champions',externalId:g.externalId,segments:g.segments})}));
    const clubs=[...new Map(players.filter(p=>p.club_name).map(p=>[p.club_id,{uid:`FC26:${p.platform}:${p.club_id}`,platform:p.platform,club_id:p.club_id,name:p.club_name,name_norm:norm(p.club_name),raw_json:JSON.stringify({source:'club-champions',synthetic:true})}])).values()];
    if(clubs.length)await client.query(`INSERT INTO clubs(uid,platform,club_id,name,name_norm,updated_at,raw_json) SELECT x.uid,x.platform,x.club_id,x.name,x.name_norm,EXTRACT(EPOCH FROM NOW())::BIGINT,x.raw_json FROM jsonb_to_recordset($1::jsonb) AS x(uid text,platform text,club_id text,name text,name_norm text,raw_json text) ON CONFLICT(uid) DO UPDATE SET name=EXCLUDED.name,name_norm=EXCLUDED.name_norm,updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,raw_json=EXCLUDED.raw_json`,[JSON.stringify(clubs)]);
    await client.query(`INSERT INTO players(uid,platform,player_id,name,name_norm,club_id,club_name,games,goals,assists,rating,updated_at,raw_json) SELECT x.uid,x.platform,x.player_id,x.name,x.name_norm,x.club_id,x.club_name,x.games,x.goals,x.assists,x.rating,EXTRACT(EPOCH FROM NOW())::BIGINT,x.raw_json FROM jsonb_to_recordset($1::jsonb) AS x(uid text,platform text,player_id text,name text,name_norm text,club_id text,club_name text,games integer,goals integer,assists integer,rating double precision,raw_json text) ON CONFLICT(uid) DO UPDATE SET name=EXCLUDED.name,name_norm=EXCLUDED.name_norm,club_id=EXCLUDED.club_id,club_name=EXCLUDED.club_name,games=EXCLUDED.games,goals=EXCLUDED.goals,assists=EXCLUDED.assists,rating=EXCLUDED.rating,updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT,raw_json=EXCLUDED.raw_json`,[JSON.stringify(players)]);
    await client.query('COMMIT');
    return{rows:rows.length,players:players.length,clubs:clubs.length,page:num(payload.meta?.page),total:num(payload.meta?.total),totalPages:num(payload.meta?.totalPages),season:text(payload.meta?.season||'FC26')}
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}

function authorized(req,u){const expected=process.env.ADMIN_TOKEN||'';return !!expected&&(req.headers['x-admin-token']||u.searchParams.get('key')||'')===expected}
function send(res,code,data){res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data))}
async function body(req){const a=[];let n=0;for await(const c of req){n+=c.length;if(n>MAX_BODY)throw new Error('Page trop volumineuse');a.push(c)}return JSON.parse(Buffer.concat(a).toString('utf8')||'{}')}

const previous=http.createServer.bind(http);
http.createServer=function(listener){return previous(async(req,res)=>{try{const u=new URL(req.url,'http://local');if(u.pathname!==ROUTE)return listener(req,res);if(!authorized(req,u))return send(res,404,{error:'not found'});if(req.method==='GET')return send(res,200,{ok:true,route:ROUTE,expects:'Club Champions page JSON',dedupe:'segment + aggregated player'});if(req.method!=='POST')return send(res,405,{error:'POST requis'});const result=await importPage(await body(req));console.log(`[CC26] page=${result.page}/${result.totalPages} rows=${result.rows} players=${result.players} clubs=${result.clubs}`);return send(res,200,{ok:true,...result})}catch(e){console.error('[CC26]',e.message);return send(res,400,{error:e.message})}})};
console.log(`[CC26] Club Champions page importer enabled route=${ROUTE}`);
