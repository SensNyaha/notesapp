import test from 'node:test';
import assert from 'node:assert/strict';
import { noteSearchScore,normalizeSearchText,searchTokens } from '../src/search.ts';

const item=(note,tags=[])=>({note:{title:'',text:'',...note},tags});

test('local search normalizes Unicode, word endings, substrings and moderate typos',()=>{
  assert.equal(normalizeSearchText('  Ёлка '),'  елка ');
  assert.deepEqual(searchTokens('План: билеты, 2027!'),['план','билеты','2027']);
  const document=item({title:'Планирование командировки',text:'Работа с заметками и покупка билетов'});
  for(const query of ['план','заметка','заметками','командирвка','билтеы'])assert.ok(noteSearchScore(query,document)>0,query);
  assert.equal(noteSearchScore('совершенно отсутствует',document),0);
});

test('all query words rank above a one-word result while every partial result remains visible',()=>{
  const query='план билеты гостиница';
  const complete=item({title:'План поездки',text:'Купить билеты',checklist:[{id:'1',text:'Выбрать гостиницу',done:false}]});
  const partial=item({title:'Гостиница',text:'Адрес'});
  const completeScore=noteSearchScore(query,complete),partialScore=noteSearchScore(query,partial);
  assert.ok(partialScore>0);assert.ok(completeScore>partialScore);
});

test('field weights favor title and tags, and pinning never changes relevance',()=>{
  const body=noteSearchScore('важное',item({text:'важное'}));
  const tag=noteSearchScore('важное',item({},[{id:'1',name:'Важное',color:'#000000',deleted:false,op:'1'}]));
  const title=noteSearchScore('важное',item({title:'Важное'}));
  assert.ok(title>tag&&tag>body);
  assert.equal(noteSearchScore('важное',item({title:'Важное',pinned:true})),title);
});
