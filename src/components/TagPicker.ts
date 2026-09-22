import { h as e } from 'preact';
import { useState } from 'preact/hooks';
import type { TagDefinition } from '../planner.ts';
import { UiIcon } from './ui.ts';

export function TagPicker({tags,selectedIds,onChange,onManage,mode='popover',placement='below',label='По тегам',showIcon=false,heading,layout='default',untagged}:{
  tags:TagDefinition[];selectedIds:string[];onChange:(ids:string[])=>void;onManage:()=>void;
  mode?:'inline'|'popover';placement?:'above'|'below';label?:string;showIcon?:boolean;heading?:string;layout?:'default'|'editor';
  untagged?:{selected:boolean;onChange:(selected:boolean)=>void};
}){
  const [query,setQuery]=useState('');
  const normalized=query.trim().toLocaleLowerCase('ru');
  const visible=tags.filter(tag=>tag.name.toLocaleLowerCase('ru').includes(normalized));
  const selected=selectedIds.map(id=>tags.find(tag=>tag.id===id)).filter((tag):tag is TagDefinition=>Boolean(tag));
  const selectedCount=selected.length+(untagged?.selected?1:0);
  const toggle=(id:string,checked:boolean)=>onChange(checked?[...selectedIds,id]:selectedIds.filter(current=>current!==id));
  return e('div',{class:'unified-tag-control'+(layout==='editor'?' note-edit-tags':'')},
    heading&&e('h2',null,heading),
    e('details',{class:`unified-tag-picker ${mode} ${placement}`},
      e('summary',{class:layout==='editor'?'secondary-button':'filter-chip unified-tag-trigger'+(selectedCount?' selected':'')},showIcon&&e(UiIcon,{name:'tag',size:17}),e('span',null,label),selectedCount>0&&e('span',{class:'filter-count'},String(selectedCount))),
      e('div',{class:'unified-tag-panel'},
        e('label',{class:'unified-tag-search'},e('span',{class:'sr-only'},'Найти тег'),e('span',{class:'search-input-wrap'},e(UiIcon,{name:'search',size:16}),e('input',{type:'search',value:query,placeholder:'Найти тег',onInput:(event:Event)=>setQuery((event.target as HTMLInputElement).value)}))),
        e('div',{class:'unified-tag-options'},untagged&&e('label',{class:'unified-tag-option unified-untagged-option'},
          e('input',{type:'checkbox',checked:untagged.selected,onChange:(event:Event)=>untagged.onChange((event.target as HTMLInputElement).checked)}),
          e('span',null,'Без тегов')),
        visible.map(tag=>e('label',{class:'unified-tag-option',key:tag.id},
          e('input',{type:'checkbox',checked:selectedIds.includes(tag.id),onChange:(event:Event)=>toggle(tag.id,(event.target as HTMLInputElement).checked)}),
          e('span',{class:'tag-chip',style:{'--tag-color':tag.color}},tag.name))),
          !visible.length&&e('p',{class:'empty-mini'},'Подходящих тегов нет.')),
        e('button',{type:'button',class:'tertiary-button unified-manage-tags',onClick:onManage},e(UiIcon,{name:'settings',size:17}),'Редактировать список'))),
    selected.length>0&&e('div',{class:'unified-selected-tags','aria-label':'Выбранные теги'},selected.map(tag=>e('button',{type:'button',class:'tag-chip selected',style:{'--tag-color':tag.color},key:tag.id,onClick:()=>toggle(tag.id,false),'aria-label':'Убрать тег '+tag.name,title:'Убрать тег'},tag.name))));
}
