import {Store} from './store5.js';
import {norm,num} from './constants.js';

const previousClubAdvanced=Store.prototype.clubAdvanced;

Store.prototype.clubAdvanced=async function(platform,clubId){
  const result=await previousClubAdvanced.call(this,platform,clubId);
  if(!result)return result;

  const rows=await this.q(
    'SELECT * FROM matches WHERE platform=$1 AND(home_club_id=$2 OR away_club_id=$2) ORDER BY ts DESC LIMIT 200',
    [platform,String(clubId)]
  );

  const unique=new Map();
  for(const m of rows){
    const home=String(m.home_club_id)===String(clubId);
    const opponentId=String(home?m.away_club_id:m.home_club_id||'');
    const opponentName=String(home?m.away_name:m.home_name||'').trim();
    if(!opponentName)continue;

    const gf=home?num(m.home_goals):num(m.away_goals);
    const ga=home?num(m.away_goals):num(m.home_goals);
    const state=gf>ga?'V':gf<ga?'D':'N';
    const key=opponentId?`id:${opponentId}`:`name:${norm(opponentName)}`;

    let item=unique.get(key);
    if(!item){
      item={
        name:opponentName,
        id:opponentId,
        score:`${gf}-${ga}`,
        result:state,
        ts:num(m.ts),
        type:m.match_type,
        meetings:0,
        wins:0,
        draws:0,
        losses:0
      };
      unique.set(key,item);
    }
    item.meetings++;
    if(state==='V')item.wins++;
    else if(state==='N')item.draws++;
    else item.losses++;
  }

  result.opponents=[...unique.values()]
    .sort((a,b)=>b.ts-a.ts)
    .slice(0,10);

  return result;
};
