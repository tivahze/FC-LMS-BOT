import {Store} from './store5.js';
import {num} from './constants.js';

const scoreFor=(m,id)=>{const home=String(m.home_club_id)===String(id),gf=home?num(m.home_goals):num(m.away_goals),ga=home?num(m.away_goals):num(m.home_goals);return{gf,ga,result:gf>ga?'V':gf<ga?'D':'N'}};

Store.prototype.v9Seasons=async function(){return{current:'fc26',items:[{id:'fc26',label:'FC 26',available:true},{id:'fc27',label:'FC 27',available:false,status:'À venir'}]}};

Store.prototype.v9Match=async function(platform,matchId){
  if(this.mode!=='postgres')return null;
  const match=await this.one(`SELECT * FROM matches WHERE platform=$1 AND match_id=$2 LIMIT 1`,[platform,String(matchId)]);if(!match)return null;
  const players=await this.q(`SELECT mp.*,p.games career_games,p.goals career_goals,p.assists career_assists,p.rating career_rating,p.raw_json player_raw_json FROM match_players mp LEFT JOIN players p ON p.platform=mp.platform AND p.player_id=mp.player_id WHERE mp.match_uid=$1 ORDER BY CASE WHEN mp.club_id=$2 THEN 0 ELSE 1 END,mp.rating DESC,mp.goals DESC,mp.assists DESC`,[match.uid,match.home_club_id]);
  const homePlayers=players.filter(x=>String(x.club_id)===String(match.home_club_id)),awayPlayers=players.filter(x=>String(x.club_id)===String(match.away_club_id));
  const motm=[...players].sort((a,b)=>num(b.rating)-num(a.rating)||num(b.goals)-num(a.goals)||num(b.assists)-num(a.assists))[0]||null;
  return{match,players,homePlayers,awayPlayers,motm};
};

Store.prototype.v9H2H=async function(platform,a,b){
  if(this.mode!=='postgres'||!a||!b)return null;
  const matches=await this.q(`SELECT * FROM matches WHERE platform=$1 AND ((home_club_id=$2 AND away_club_id=$3) OR (home_club_id=$3 AND away_club_id=$2)) ORDER BY ts DESC LIMIT 250`,[platform,String(a),String(b)]);
  const ca=await this.one(`SELECT platform,club_id,name,skill,games,wins,draws,losses FROM clubs WHERE platform=$1 AND club_id=$2`,[platform,String(a)]),cb=await this.one(`SELECT platform,club_id,name,skill,games,wins,draws,losses FROM clubs WHERE platform=$1 AND club_id=$2`,[platform,String(b)]);
  let aWins=0,bWins=0,draws=0,aGoals=0,bGoals=0;for(const m of matches){const sa=scoreFor(m,a);aGoals+=sa.gf;bGoals+=sa.ga;if(sa.result==='V')aWins++;else if(sa.result==='D')bWins++;else draws++}
  return{clubA:ca||{platform,club_id:String(a),name:`Club ${a}`},clubB:cb||{platform,club_id:String(b),name:`Club ${b}`},summary:{games:matches.length,aWins,bWins,draws,aGoals,bGoals},matches};
};

Store.prototype.v9Records=async function(platform=''){
  if(this.mode!=='postgres')return{};
  const [goalsMatch,marginMatch,playerGoals,playerAssists,playerContrib,playerRating,matches]=await Promise.all([
    this.one(`SELECT platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals,(home_goals+away_goals) value FROM matches WHERE($1='' OR platform=$1) ORDER BY (home_goals+away_goals) DESC,ts DESC LIMIT 1`,[platform]),
    this.one(`SELECT platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals,ABS(home_goals-away_goals) value FROM matches WHERE($1='' OR platform=$1) ORDER BY ABS(home_goals-away_goals) DESC,ts DESC LIMIT 1`,[platform]),
    this.one(`SELECT mp.platform,mp.player_id,mp.name,mp.club_id,mp.club_name,mp.goals value,m.match_id,m.ts,m.home_name,m.away_name,m.home_goals,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE($1='' OR mp.platform=$1) ORDER BY mp.goals DESC,mp.rating DESC,m.ts DESC LIMIT 1`,[platform]),
    this.one(`SELECT mp.platform,mp.player_id,mp.name,mp.club_id,mp.club_name,mp.assists value,m.match_id,m.ts,m.home_name,m.away_name,m.home_goals,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE($1='' OR mp.platform=$1) ORDER BY mp.assists DESC,mp.rating DESC,m.ts DESC LIMIT 1`,[platform]),
    this.one(`SELECT mp.platform,mp.player_id,mp.name,mp.club_id,mp.club_name,(mp.goals+mp.assists) value,m.match_id,m.ts,m.home_name,m.away_name,m.home_goals,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE($1='' OR mp.platform=$1) ORDER BY (mp.goals+mp.assists) DESC,mp.rating DESC,m.ts DESC LIMIT 1`,[platform]),
    this.one(`SELECT mp.platform,mp.player_id,mp.name,mp.club_id,mp.club_name,mp.rating value,m.match_id,m.ts,m.home_name,m.away_name,m.home_goals,m.away_goals FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE($1='' OR mp.platform=$1) AND mp.rating>0 AND mp.rating<=10 ORDER BY mp.rating DESC,(mp.goals+mp.assists) DESC,m.ts DESC LIMIT 1`,[platform]),
    this.q(`SELECT platform,match_id,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals FROM matches WHERE($1='' OR platform=$1) ORDER BY ts ASC LIMIT 5000`,[platform])
  ]);
  const streaks=new Map();let longest={club_id:'',club_name:'',platform:'',wins:0};for(const m of matches){for(const id of [m.home_club_id,m.away_club_id]){const s=scoreFor(m,id),k=`${m.platform}|${id}`,prev=streaks.get(k)||0,next=s.result==='V'?prev+1:0;streaks.set(k,next);if(next>longest.wins)longest={club_id:String(id),club_name:String(id)===String(m.home_club_id)?m.home_name:m.away_name,platform:m.platform,wins:next}}}
  return{goalsMatch,marginMatch,playerGoals,playerAssists,playerContrib,playerRating,longestWinStreak:longest};
};

Store.prototype.v9Live=async function(limit=60){
  limit=Math.min(150,Math.max(10,num(limit)||60));if(this.mode!=='postgres')return[];
  const [matches,clubs,players]=await Promise.all([
    this.q(`SELECT platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals FROM matches ORDER BY ts DESC LIMIT $1`,[limit]),
    this.q(`SELECT platform,club_id,name,skill,games,updated_at FROM clubs ORDER BY updated_at DESC LIMIT $1`,[Math.ceil(limit/3)]),
    this.q(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,updated_at FROM players ORDER BY updated_at DESC LIMIT $1`,[Math.ceil(limit/3)])
  ]);
  const events=[...matches.map(x=>({type:'match',at:num(x.ts),data:x})),...clubs.map(x=>({type:'club',at:num(x.updated_at),data:x})),...players.map(x=>({type:'player',at:num(x.updated_at),data:x}))];return events.sort((a,b)=>b.at-a.at).slice(0,limit);
};

Store.prototype.v9Admin=async function(){
  if(this.mode!=='postgres')return{storage:this.mode};
  const [counts,platforms,recent,quality,size,meta]=await Promise.all([
    this.dashboard(),
    this.q(`SELECT platform,(SELECT COUNT(*) FROM clubs c2 WHERE c2.platform=x.platform) clubs,(SELECT COUNT(*) FROM players p2 WHERE p2.platform=x.platform) players,(SELECT COUNT(*) FROM matches m2 WHERE m2.platform=x.platform) matches FROM (SELECT platform FROM clubs UNION SELECT platform FROM players UNION SELECT platform FROM matches) x ORDER BY platform`),
    this.one(`SELECT (SELECT COUNT(*) FROM matches WHERE ts>=EXTRACT(EPOCH FROM NOW()-INTERVAL '24 hours')) matches_24h,(SELECT COUNT(*) FROM clubs WHERE updated_at>=EXTRACT(EPOCH FROM NOW()-INTERVAL '24 hours')) clubs_24h,(SELECT COUNT(*) FROM players WHERE updated_at>=EXTRACT(EPOCH FROM NOW()-INTERVAL '24 hours')) players_24h,(SELECT MAX(ts) FROM matches) latest_match,(SELECT MAX(updated_at) FROM clubs) latest_club,(SELECT MAX(updated_at) FROM players) latest_player`),
    this.v8Stats(),
    this.one(`SELECT pg_database_size(current_database()) bytes,pg_size_pretty(pg_database_size(current_database())) pretty`),
    this.q(`SELECT key,value FROM meta ORDER BY key LIMIT 100`)
  ]);
  return{counts,platforms,recent,quality:quality.quality,coverage:quality.coverage,size,meta};
};

console.log('[V9] matches, records, h2h, live, seasons and admin analytics ready');
