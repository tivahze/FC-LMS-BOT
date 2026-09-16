import {Store} from './store5.js';
import {num,norm,positionOf,archetypeOf,stringPlaystyles,signatureFor,archetypeName} from './constants.js';

const enrichPlayer=row=>{
  if(!row)return row;
  let raw={};try{raw=JSON.parse(row.raw_json||'{}')}catch{}
  const a=archetypeOf(raw);
  const rating=num(row.rating);
  return {...row,
    position:positionOf(raw)||row.position||'',
    overall:num(raw.proOverall??raw.overall??raw.ovr),
    archetype_id:a.id||'',archetype_name:a.name||archetypeName(a.id),
    signature_playstyle:a.playstyle||signatureFor(a.id),playstyles:stringPlaystyles(raw),
    rating
  };
};

const prevInit=Store.prototype.init;
Store.prototype.init=async function(){
  await prevInit.call(this);
  if(this.mode!=='postgres')return;
  try{
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS clubs_platform_skill_v8_idx ON clubs(platform,skill DESC,games DESC);
      CREATE INDEX IF NOT EXISTS clubs_platform_games_v8_idx ON clubs(platform,games DESC);
      CREATE INDEX IF NOT EXISTS clubs_updated_v8_idx ON clubs(updated_at DESC);
      CREATE INDEX IF NOT EXISTS players_platform_games_v8_idx ON players(platform,games DESC);
      CREATE INDEX IF NOT EXISTS players_platform_goals_v8_idx ON players(platform,goals DESC,games DESC);
      CREATE INDEX IF NOT EXISTS players_platform_assists_v8_idx ON players(platform,assists DESC,games DESC);
      CREATE INDEX IF NOT EXISTS players_platform_rating_v8_idx ON players(platform,rating DESC,games DESC);
      CREATE INDEX IF NOT EXISTS players_updated_v8_idx ON players(updated_at DESC);
      CREATE INDEX IF NOT EXISTS matches_platform_ts_v8_idx ON matches(platform,ts DESC);
      CREATE INDEX IF NOT EXISTS match_players_player_v8_idx ON match_players(platform,player_id,match_uid);
    `);
  }catch(e){console.warn('[V8 INDEX]',e.message)}
  try{
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await this.pool.query(`CREATE INDEX IF NOT EXISTS players_name_trgm_v8_idx ON players USING gin(name_norm gin_trgm_ops);CREATE INDEX IF NOT EXISTS clubs_name_trgm_v8_idx ON clubs USING gin(name_norm gin_trgm_ops);`);
    this.v8Trgm=true;
  }catch(e){this.v8Trgm=false;console.warn('[V8 TRGM]',e.message)}
  console.log(`[V8] analytics ready; trigram=${this.v8Trgm?'on':'off'}`);
};

Store.prototype.v8Stats=async function(){
  if(this.mode!=='postgres'){
    const d=await this.dashboard();return{...d,quality:{unresolvedClubs:0,duplicatePlayerGroups:0,orphanAppearances:0},latestMatch:0,latestUpdate:0};
  }
  const [d,q,l]=await Promise.all([
    this.dashboard(),
    this.one(`SELECT
      (SELECT COUNT(*) FROM clubs WHERE name='' OR lower(name) LIKE 'club #% ' OR lower(name) LIKE 'nom du club indisponible%') unresolved_clubs,
      (SELECT COUNT(*) FROM (SELECT platform,club_id,name_norm FROM players WHERE name_norm<>'' GROUP BY platform,club_id,name_norm HAVING COUNT(*)>1) x) duplicate_player_groups,
      (SELECT COUNT(*) FROM match_players mp LEFT JOIN matches m ON m.uid=mp.match_uid WHERE m.uid IS NULL) orphan_appearances`),
    this.one(`SELECT COALESCE((SELECT MAX(ts) FROM matches),0) latest_match,COALESCE(GREATEST((SELECT MAX(updated_at) FROM clubs),(SELECT MAX(updated_at) FROM players)),0) latest_update`)
  ]);
  return{...d,latestMatch:num(l?.latest_match),latestUpdate:num(l?.latest_update),quality:{unresolvedClubs:num(q?.unresolved_clubs),duplicatePlayerGroups:num(q?.duplicate_player_groups),orphanAppearances:num(q?.orphan_appearances)}};
};

Store.prototype.v8Search=async function(query,platform='',limit=8){
  const q=norm(query);if(q.length<1)return{players:[],clubs:[]};limit=Math.min(20,Math.max(3,num(limit)||8));
  const pat=`%${q}%`,pre=`${q}%`;
  if(this.mode!=='postgres')return this.search(q,platform);
  const score=this.v8Trgm?`, similarity(name_norm,$2) sim`:`, 0 sim`;
  const order=this.v8Trgm?`CASE WHEN name_norm=$2 THEN 0 WHEN name_norm LIKE $3 THEN 1 WHEN name_norm LIKE $4 THEN 2 ELSE 3 END, similarity(name_norm,$2) DESC`:`CASE WHEN name_norm=$2 THEN 0 WHEN name_norm LIKE $3 THEN 1 ELSE 2 END`;
  const extra=this.v8Trgm?` OR similarity(name_norm,$2)>0.22`:``;
  const [players,clubs]=await Promise.all([
    this.q(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating,raw_json${score} FROM players WHERE($1='' OR platform=$1)AND(name_norm LIKE $4${extra}) ORDER BY ${order},games DESC LIMIT $5`,[platform,q,pre,pat,limit]),
    this.q(`SELECT platform,club_id,name,skill,wins,draws,losses,games${score} FROM clubs WHERE($1='' OR platform=$1)AND(name_norm LIKE $4${extra}) ORDER BY ${order},skill DESC LIMIT $5`,[platform,q,pre,pat,limit])
  ]);
  return{players:players.map(enrichPlayer),clubs};
};

Store.prototype.v8Rankings=async function(type='player',metric='goals',platform='',minGames=3,page=1,limit=50){
  page=Math.max(1,num(page)||1);limit=Math.min(100,Math.max(10,num(limit)||50));minGames=Math.max(0,num(minGames));const offset=(page-1)*limit;
  if(type==='club'){
    const exprs={skill:'skill',wins:'wins',games:'games',winrate:`CASE WHEN games>0 THEN wins::double precision/games*100 ELSE 0 END`};
    const expr=exprs[metric]||exprs.skill;
    const total=num((await this.one(`SELECT COUNT(*) c FROM clubs WHERE($1='' OR platform=$1)AND games>=$2`,[platform,minGames]))?.c);
    const items=await this.q(`SELECT platform,club_id,name,skill,wins,draws,losses,games,${expr} metric_value FROM clubs WHERE($1='' OR platform=$1)AND games>=$2 ORDER BY ${expr} DESC,games DESC,name ASC LIMIT $3 OFFSET $4`,[platform,minGames,limit,offset]);
    return{type:'club',metric,page,pages:Math.max(1,Math.ceil(total/limit)),total,items};
  }
  const exprs={goals:'goals',assists:'assists',rating:'rating',games:'games',contributions:'(goals+assists)',gpg:`CASE WHEN games>0 THEN goals::double precision/games ELSE 0 END`,apg:`CASE WHEN games>0 THEN assists::double precision/games ELSE 0 END`};
  const expr=exprs[metric]||exprs.goals;
  const total=num((await this.one(`SELECT COUNT(*) c FROM players WHERE($1='' OR platform=$1)AND games>=$2`,[platform,minGames]))?.c);
  const rows=await this.q(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating,raw_json,${expr} metric_value FROM players WHERE($1='' OR platform=$1)AND games>=$2 ORDER BY ${expr} DESC,games DESC,name ASC LIMIT $3 OFFSET $4`,[platform,minGames,limit,offset]);
  return{type:'player',metric,page,pages:Math.max(1,Math.ceil(total/limit)),total,items:rows.map(enrichPlayer)};
};

const prevPlayer=Store.prototype.player;
Store.prototype.player=async function(p,id){
  const r=await prevPlayer.call(this,p,id);if(!r)return r;
  const recent=(r.recent||[]).slice(0,30),last10=recent.slice(0,10),ratings=last10.map(x=>num(x.rating)).filter(Boolean);
  const roles={};for(const x of recent){const k=String(x.position||'').trim()||'Inconnu';roles[k]=(roles[k]||0)+1}
  const topRoles=Object.entries(roles).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,games])=>({name,games}));
  const last10Goals=last10.reduce((s,x)=>s+num(x.goals),0),last10Assists=last10.reduce((s,x)=>s+num(x.assists),0);
  r.advanced={
    gpg:num(r.player.games)?num(r.player.goals)/num(r.player.games):0,
    apg:num(r.player.games)?num(r.player.assists)/num(r.player.games):0,
    contributionsPerGame:num(r.player.games)?(num(r.player.goals)+num(r.player.assists))/num(r.player.games):0,
    last10:{games:last10.length,goals:last10Goals,assists:last10Assists,contributions:last10Goals+last10Assists,avgRating:ratings.length?ratings.reduce((a,b)=>a+b,0)/ratings.length:0},
    roles:topRoles,lastUpdated:num(recent[0]?.ts)||num(r.player.updated_at)
  };
  return r;
};

const prevClub=Store.prototype.clubAdvanced;
Store.prototype.clubAdvanced=async function(p,id){
  const r=await prevClub.call(this,p,id);if(!r)return r;
  let matches=r.matches||[];
  if(this.mode==='postgres')matches=await this.q(`SELECT * FROM matches WHERE platform=$1 AND(home_club_id=$2 OR away_club_id=$2) ORDER BY ts DESC LIMIT 100`,[p,String(id)]);
  const results=matches.map(m=>{const home=String(m.home_club_id)===String(id),gf=home?num(m.home_goals):num(m.away_goals),ga=home?num(m.away_goals):num(m.home_goals);return{gf,ga,result:gf>ga?'V':gf<ga?'D':'N',ts:num(m.ts)}});
  const calc=arr=>{const games=arr.length,wins=arr.filter(x=>x.result==='V').length,draws=arr.filter(x=>x.result==='N').length,losses=games-wins-draws,gf=arr.reduce((s,x)=>s+x.gf,0),ga=arr.reduce((s,x)=>s+x.ga,0);return{games,wins,draws,losses,winRate:games?wins/games*100:0,gf,ga,gfAvg:games?gf/games:0,gaAvg:games?ga/games:0,gd:gf-ga}};
  const recent10=calc(results.slice(0,10)),recent25=calc(results.slice(0,25)),archive=calc(results);
  let streak={result:'',count:0};if(results.length){streak.result=results[0].result;for(const x of results){if(x.result===streak.result)streak.count++;else break}}
  const roster=r.players||[],topScorer=[...roster].sort((a,b)=>num(b.goals)-num(a.goals)||num(b.games)-num(a.games))[0]||null,topAssister=[...roster].sort((a,b)=>num(b.assists)-num(a.assists)||num(b.games)-num(a.games))[0]||null,mostUsed=[...roster].sort((a,b)=>num(b.games)-num(a.games))[0]||null,bestRated=[...roster].filter(x=>num(x.rating)>0).sort((a,b)=>num(b.rating)-num(a.rating)||num(b.games)-num(a.games))[0]||null;
  r.advanced={archive,recent10,recent25,streak,topScorer,topAssister,mostUsed,bestRated,lastUpdated:num(matches[0]?.ts)||num(r.club.updated_at)};
  return r;
};
