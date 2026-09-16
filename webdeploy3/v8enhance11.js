import {Store} from './store5.js';
import {num} from './constants.js';
const prevInit=Store.prototype.init;
Store.prototype.init=async function(){
  await prevInit.call(this);
  if(this.mode!=='postgres')return;
  await this.pool.query(`CREATE TABLE IF NOT EXISTS profile_views(entity_type TEXT NOT NULL,platform TEXT NOT NULL,entity_id TEXT NOT NULL,views BIGINT DEFAULT 0,last_viewed BIGINT DEFAULT 0,PRIMARY KEY(entity_type,platform,entity_id));CREATE INDEX IF NOT EXISTS profile_views_rank_v8_idx ON profile_views(entity_type,views DESC,last_viewed DESC);`);
};
Store.prototype.v8TouchView=async function(type,platform,id){
  if(this.mode!=='postgres'||!['player','club'].includes(type)||!platform||!id)return;
  await this.pool.query(`INSERT INTO profile_views(entity_type,platform,entity_id,views,last_viewed)VALUES($1,$2,$3,1,EXTRACT(EPOCH FROM NOW())::BIGINT)ON CONFLICT(entity_type,platform,entity_id)DO UPDATE SET views=profile_views.views+1,last_viewed=EXCLUDED.last_viewed`,[type,platform,String(id)]);
};
Store.prototype.v8Popular=async function(type='player',limit=8){
  limit=Math.min(20,Math.max(1,num(limit)||8));if(this.mode!=='postgres')return[];
  if(type==='club')return this.q(`SELECT c.platform,c.club_id,c.name,c.skill,c.games,v.views,v.last_viewed FROM profile_views v JOIN clubs c ON c.platform=v.platform AND c.club_id=v.entity_id WHERE v.entity_type='club' ORDER BY v.views DESC,v.last_viewed DESC LIMIT $1`,[limit]);
  return this.q(`SELECT p.platform,p.player_id,p.name,p.club_id,p.club_name,p.games,p.goals,p.assists,p.rating,p.raw_json,v.views,v.last_viewed FROM profile_views v JOIN players p ON p.platform=v.platform AND p.player_id=v.entity_id WHERE v.entity_type='player' ORDER BY v.views DESC,v.last_viewed DESC LIMIT $1`,[limit]);
};
const prevPlayer=Store.prototype.player;
Store.prototype.player=async function(p,id){
  const r=await prevPlayer.call(this,p,id);if(!r)return r;
  if(this.mode==='postgres'){
    const history=await this.q(`SELECT mp.club_id,COALESCE(NULLIF(MAX(mp.club_name),''),'Nom indisponible') club_name,COUNT(*) appearances,MAX(m.ts) last_seen,MIN(m.ts) first_seen FROM match_players mp JOIN matches m ON m.uid=mp.match_uid WHERE mp.platform=$1 AND mp.player_id=$2 AND mp.club_id<>'' GROUP BY mp.club_id ORDER BY MAX(m.ts) DESC LIMIT 20`,[p,String(id)]);
    r.advanced={...(r.advanced||{}),clubHistory:history};
  }
  return r;
};
