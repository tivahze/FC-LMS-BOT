import {Store} from './store5.js';
import {num} from './constants.js';
const previousPlayer=Store.prototype.player;
Store.prototype.player=async function(platform,id){
  const r=await previousPlayer.call(this,platform,id);if(!r||this.mode!=='postgres')return r;
  const current=String(r.player?.club_id||'');
  const [all,club,pos]=await Promise.all([
    this.one(`SELECT COUNT(*) apps,COALESCE(SUM(goals),0) goals,COALESCE(SUM(assists),0) assists,COALESCE(AVG(NULLIF(rating,0)),0) avg_rating FROM match_players WHERE platform=$1 AND player_id=$2`,[platform,String(id)]),
    current?this.one(`SELECT COUNT(*) apps,COALESCE(SUM(goals),0) goals,COALESCE(SUM(assists),0) assists,COALESCE(AVG(NULLIF(rating,0)),0) avg_rating FROM match_players WHERE platform=$1 AND player_id=$2 AND club_id=$3`,[platform,String(id),current]):Promise.resolve(null),
    this.one(`SELECT NULLIF(trim(position),'') position,COUNT(*) games FROM match_players WHERE platform=$1 AND player_id=$2 AND NULLIF(trim(position),'') IS NOT NULL GROUP BY NULLIF(trim(position),'') ORDER BY COUNT(*) DESC LIMIT 1`,[platform,String(id)])
  ]);
  const pack=x=>({apps:num(x?.apps),goals:num(x?.goals),assists:num(x?.assists),avgRating:num(x?.avg_rating),gpg:num(x?.apps)?num(x?.goals)/num(x?.apps):0,apg:num(x?.apps)?num(x?.assists)/num(x?.apps):0});
  r.advanced={...(r.advanced||{}),observed:pack(all),currentClubObserved:pack(club),bestPositionObserved:pos?.position||'',bestPositionGames:num(pos?.games)};
  return r;
};
