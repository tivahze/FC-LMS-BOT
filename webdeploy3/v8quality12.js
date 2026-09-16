import {Store} from './store5.js';
import {num} from './constants.js';

const previousStats=Store.prototype.v8Stats;
Store.prototype.v8Stats=async function(){
  const d=await previousStats.call(this);
  if(this.mode!=='postgres')return d;
  const q=await this.one(`SELECT
    (SELECT COUNT(*) FROM clubs WHERE trim(name)='' OR lower(name) LIKE 'club #%' OR lower(name) LIKE 'nom du club indisponible%' OR lower(name)='club inconnu') unresolved_clubs,
    (SELECT COUNT(*) FROM (SELECT DISTINCT platform,club_id FROM (SELECT platform,home_club_id club_id FROM matches WHERE home_club_id<>'' UNION ALL SELECT platform,away_club_id club_id FROM matches WHERE away_club_id<>'') z) x) clubs_with_matches,
    (SELECT COUNT(*) FROM (SELECT DISTINCT platform,player_id FROM match_players WHERE player_id<>'') x) players_with_appearances`);
  return{...d,quality:{...(d.quality||{}),unresolvedClubs:num(q?.unresolved_clubs)},coverage:{clubsWithMatches:num(q?.clubs_with_matches),playersWithAppearances:num(q?.players_with_appearances)}};
};

const previousClub=Store.prototype.clubAdvanced;
Store.prototype.clubAdvanced=async function(platform,id){
  const r=await previousClub.call(this,platform,id);if(!r||this.mode!=='postgres')return r;
  const rows=await this.q(`SELECT ts,home_club_id,home_goals,away_club_id,away_goals FROM matches WHERE platform=$1 AND(home_club_id=$2 OR away_club_id=$2) ORDER BY ts DESC LIMIT 100`,[platform,String(id)]);
  const calc=(list,homeSide)=>{let wins=0,draws=0,losses=0,gf=0,ga=0;for(const m of list){const home=String(m.home_club_id)===String(id),a=home?num(m.home_goals):num(m.away_goals),b=home?num(m.away_goals):num(m.home_goals);gf+=a;ga+=b;if(a>b)wins++;else if(a===b)draws++;else losses++}const games=list.length;return{games,wins,draws,losses,gf,ga,winRate:games?wins/games*100:0,gfAvg:games?gf/games:0,gaAvg:games?ga/games:0,side:homeSide?'home':'away'}};
  const home=rows.filter(m=>String(m.home_club_id)===String(id)),away=rows.filter(m=>String(m.away_club_id)===String(id));
  r.advanced={...(r.advanced||{}),home:calc(home,true),away:calc(away,false)};
  return r;
};
