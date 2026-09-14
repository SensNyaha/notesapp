import type { Note, TagDefinition } from './planner.ts';

const WORD=/[\p{L}\p{N}]+/gu;
const RU_ENDINGS=[
  'иями','ями','ами','его','ого','ему','ому','ее','ие','ые','ое','ей','ий','ый','ой','ем','им','ым','ом','их','ых','ую','юю','ая','яя','ою','ею',
  'ов','ев','ам','ям','ах','ях','ы','и','ь','й','а','я','у','ю','о','е',
];
const EN_ENDINGS=['ingly','edly','ments','ment','ness','ation','ations','ing','ers','ies','ied','ed','es','s'];

export function normalizeSearchText(value:string){return value.normalize('NFKC').toLocaleLowerCase('ru').replaceAll('ё','е');}
export function searchTokens(value:string){return normalizeSearchText(value).match(WORD)??[];}

function stem(word:string){
  const endings=/[а-я]/u.test(word)?RU_ENDINGS:EN_ENDINGS;
  for(const ending of endings)if(word.length-ending.length>=3&&word.endsWith(ending))return word.slice(0,-ending.length);
  return word;
}

// Bounded Damerau-Levenshtein stops once a row cannot get within the allowed distance.
function editDistance(left:string,right:string,limit:number){
  if(Math.abs(left.length-right.length)>limit)return limit+1;
  let previous=Array.from({length:right.length+1},(_,index)=>index),beforePrevious=previous;
  for(let i=1;i<=left.length;i++){
    const current=[i];let rowBest=i;
    for(let j=1;j<=right.length;j++){
      let value=Math.min(current[j-1]+1,previous[j]+1,previous[j-1]+(left[i-1]===right[j-1]?0:1));
      if(i>1&&j>1&&left[i-1]===right[j-2]&&left[i-2]===right[j-1])value=Math.min(value,beforePrevious[j-2]+1);
      current[j]=value;rowBest=Math.min(rowBest,value);
    }
    if(rowBest>limit)return limit+1;beforePrevious=previous;previous=current;
  }
  return previous[right.length];
}

function termQuality(query:string,word:string){
  if(query===word)return 1;
  if(query.length>=3&&word.includes(query))return word.startsWith(query)?.9:.82;
  const queryStem=stem(query),wordStem=stem(word);
  if(queryStem.length>=3&&queryStem===wordStem)return .8;
  const stemLongest=Math.max(queryStem.length,wordStem.length),stemLimit=stemLongest>=8?2:stemLongest>=5?1:0;
  if(stemLimit&&editDistance(queryStem,wordStem,stemLimit)<=stemLimit)return .64;
  const longest=Math.max(query.length,word.length),limit=longest>=8?2:longest>=5?1:0;
  if(!limit)return 0;const distance=editDistance(query,word,limit);
  return distance<=limit?(distance===1?.7:.56):0;
}

interface SearchField { text:string;weight:number }
export interface SearchableNote { note:Note;tags:TagDefinition[] }

export function noteSearchScore(query:string,{note,tags}:SearchableNote){
  const terms=[...new Set(searchTokens(query))];if(!terms.length)return 0;
  const fields:SearchField[]=[
    {text:note.title,weight:9},
    {text:tags.map(tag=>tag.name).join(' '),weight:7},
    {text:(note.checklist??[]).map(item=>item.text).join(' '),weight:4},
    {text:note.text,weight:2},
  ];
  let score=0,matched=0;
  for(const term of terms){
    let best=0;
    for(const field of fields){
      const words=searchTokens(field.text);let quality=0,hits=0;
      for(const word of words){const current=termQuality(term,word);if(current>0){quality=Math.max(quality,current);hits++;}}
      if(quality)best=Math.max(best,field.weight*quality*(1+Math.min(.25,Math.log2(hits+1)*.08)));
    }
    if(best){matched++;score+=best;}
  }
  if(!matched)return 0;
  const coverage=matched/terms.length;
  score*=.35+.65*coverage;
  const phrase=normalizeSearchText(query).trim().replace(/\s+/g,' ');
  if(phrase.length>=3){
    if(normalizeSearchText(note.title).includes(phrase))score+=12;
    else if(normalizeSearchText(note.text).includes(phrase))score+=4;
  }
  return Math.round(score*1000)/1000;
}
