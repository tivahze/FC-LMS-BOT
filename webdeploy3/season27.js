import {Store} from './store5.js';
import {num,norm,CURRENT_SEASON} from './constants.js';

const MIGRATION_KEY='season:fc27:migrated:v1';
const CURRENT='FC27';

async function tableExists(store,name){
  if(store.mode!=='postgres')return false;
  const r=await store.one('SELECT to_regclass($1) name',[name]);
  return !!r?.name;
}
async function clearIfExists(store,name){
  if(await tableExists(store,name))await store.pool.query(`DELETE FROM ${name}`);
}

const previousInit=Store.prototype.init;
Store.prototype.init=async function(){
  await previousInit.call(this);
  if(this.mode!=='postgres')return;

  const lock=await this.pool.connect();
  try{
    await lock.query('SELECT pg_advisory_lock(270027)');
    await lock.query(`
      CREATE TABLE IF NOT EXISTS fc26_clubs_archive AS SELECT * FROM clubs WHERE FALSE;
      CREATE TABLE IF NOT EXISTS fc26_players_archive AS SELECT * FROM players WHERE FALSE;
      CREATE TABLE IF NOT EXISTS fc26_matches_archive AS SELECT * FROM matches WHERE FALSE;
      CREATE TABLE IF NOT EXISTS fc26_match_players_archive AS SELECT * FROM match_players WHERE FALSE;
      CREATE INDEX IF NOT EXISTS fc26_clubs_archive_name_idx ON fc26_clubs_archive(name_norm);
      CREATE INDEX IF NOT EXISTS fc26_players_archive_name_idx ON fc26_players_archive(name_norm);
      CREATE INDEX IF NOT EXISTS fc26_matches_archive_ts_idx ON fc26_matches_archive(ts DESC);
    `);

    const done=(await lock.query('SELECT value FROM meta WHERE key=$1',[MIGRATION_KEY])).rows[0]?.value;
    if(done==='1'){
      await lock.query(`INSERT INTO meta(key,value) VALUES('season:current',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[CURRENT]);
      return;
    }

    const before=(await lock.query(`SELECT
      (SELECT COUNT(*) FROM clubs) clubs,
      (SELECT COUNT(*) FROM players) players,
      (SELECT COUNT(*) FROM matches) matches,
      (SELECT COUNT(*) FROM match_players) appearances`)).rows[0];

    try{
      await lock.query('BEGIN');
      await lock.query(`SET LOCAL lock_timeout = '45s'`);
      await lock.query('LOCK TABLE clubs,players,matches,match_players IN ACCESS EXCLUSIVE MODE');

      await lock.query('DELETE FROM fc26_match_players_archive');
      await lock.query('DELETE FROM fc26_matches_archive');
      await lock.query('DELETE FROM fc26_players_archive');
      await lock.query('DELETE FROM fc26_clubs_archive');
      await lock.query('INSERT INTO fc26_clubs_archive SELECT * FROM clubs');
      await lock.query('INSERT INTO fc26_players_archive SELECT * FROM players');
      await lock.query('INSERT INTO fc26_matches_archive SELECT * FROM matches');
      await lock.query('INSERT INTO fc26_match_players_archive SELECT * FROM match_players');

      await lock.query('DELETE FROM match_players');
      await lock.query('DELETE FROM matches');
      await lock.query('DELETE FROM players');
      await lock.query('DELETE FROM clubs');

      await lock.query(`DELETE FROM meta WHERE
        key LIKE 'cursor:%' OR key LIKE 'mass23:%' OR key LIKE 'priority:%' OR
        key LIKE 'idsweep:%' OR key LIKE 'growth:%' OR key LIKE 'discovery:%'`);
      await lock.query(`INSERT INTO meta(key,value) VALUES($1,'1') ON CONFLICT(key) DO UPDATE SET value='1'`,[MIGRATION_KEY]);
      await lock.query(`INSERT INTO meta(key,value) VALUES('season:current',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[CURRENT]);
      await lock.query('COMMIT');
    }catch(e){
      try{await lock.query('ROLLBACK')}catch{}
      throw e;
    }

    for(const name of ['watched_clubs','growth_queries','club_id_probe','private_harvest23','growth_snapshots']){
      try{
        const exists=(await lock.query('SELECT to_regclass($1) name',[name])).rows[0]?.name;
        if(exists)await lock.query(`DELETE FROM ${name}`);
      }catch(e){console.warn(`[FC27] cleanup ${name}: ${e.message}`)}
    }

    console.log(`[FC27] migration complete: archived FC26 clubs=${num(before?.clubs)} players=${num(before?.players)} matches=${num(before?.matches)} appearances=${num(before?.appearances)}; live tables reset for FC27`);
  }finally{
    try{await lock.query('SELECT pg_advisory_unlock(270027)')}catch{}
    lock.release();
  }
};
Store.prototype.fc26ArchiveSummary=async function(){
  if(this.mode!=='postgres')return{season:'fc26',clubs:0,players:0,matches:0,appearances:0};
  const r=await this.one(`SELECT
    (SELECT COUNT(*) FROM fc26_clubs_archive) clubs,
    (SELECT COUNT(*) FROM fc26_players_archive) players,
    (SELECT COUNT(*) FROM fc26_matches_archive) matches,
    (SELECT COUNT(*) FROM fc26_match_players_archive) appearances`);
  return{season:'fc26',clubs:num(r?.clubs),players:num(r?.players),matches:num(r?.matches),appearances:num(r?.appearances)};
};

Store.prototype.fc26ArchivePlayers=async function(query='',platform='',page=1,limit=50){
  if(this.mode!=='postgres')return{total:0,items:[]};
  const q=norm(query),pat=`%${q}%`,offset=(Math.max(1,page)-1)*limit;
  const total=num((await this.one(`SELECT COUNT(*) c FROM fc26_players_archive WHERE($1='' OR platform=$1)AND($2='' OR name_norm LIKE $3)`,[platform,q,pat]))?.c);
  const items=await this.q(`SELECT platform,player_id,name,club_id,club_name,games,goals,assists,rating,updated_at,raw_json FROM fc26_players_archive WHERE($1='' OR platform=$1)AND($2='' OR name_norm LIKE $3) ORDER BY games DESC,goals DESC,name ASC LIMIT $4 OFFSET $5`,[platform,q,pat,limit,offset]);
  return{total,items};
};

Store.prototype.fc26ArchiveClubs=async function(query='',platform='',page=1,limit=50){
  if(this.mode!=='postgres')return{total:0,items:[]};
  const q=norm(query),pat=`%${q}%`,offset=(Math.max(1,page)-1)*limit;
  const total=num((await this.one(`SELECT COUNT(*) c FROM fc26_clubs_archive WHERE($1='' OR platform=$1)AND($2='' OR name_norm LIKE $3)`,[platform,q,pat]))?.c);
  const items=await this.q(`SELECT platform,club_id,name,skill,wins,draws,losses,games,updated_at FROM fc26_clubs_archive WHERE($1='' OR platform=$1)AND($2='' OR name_norm LIKE $3) ORDER BY games DESC,skill DESC,name ASC LIMIT $4 OFFSET $5`,[platform,q,pat,limit,offset]);
  return{total,items};
};

Store.prototype.fc26ArchiveMatches=async function(platform='',limit=50){
  if(this.mode!=='postgres')return[];
  limit=Math.min(100,Math.max(10,num(limit)||50));
  return this.q(`SELECT platform,match_id,match_type,ts,home_club_id,home_name,home_goals,away_club_id,away_name,away_goals FROM fc26_matches_archive WHERE($1='' OR platform=$1) ORDER BY ts DESC LIMIT $2`,[platform,limit]);
};

console.log(`[FC27] season layer enabled current=${CURRENT_SEASON}`);
