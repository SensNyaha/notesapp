import { h as e } from 'preact';
import { useState } from 'preact/hooks';
import { UiIcon } from './ui.ts';

export function Onboarding({onDone}:{onDone:()=>void}){
  const [install,setInstall]=useState(false);
  const standalone=window.matchMedia('(display-mode: standalone)').matches||Boolean((navigator as Navigator&{standalone?:boolean}).standalone);
  const benefits=[
    {icon:'notes' as const,title:'Всё в одном месте',text:'Заметки, напоминания, задачи и проекты связаны между собой.'},
    {icon:'wifi-off' as const,title:'Работает офлайн',text:'Продолжайте работу без сети — изменения дождутся синхронизации.'},
    {icon:'lock' as const,title:'E2EE по умолчанию',text:'Содержимое хранилищ шифруется на устройстве и не раскрывается серверу.'},
  ];
  return e('main',{class:'onboarding-screen'},
    e('button',{class:'onboarding-skip text-button',onClick:onDone},'Пропустить'),
    e('section',{class:'onboarding-hero'},
      e('div',{class:'onboarding-mark'},e('img',{src:'/icon.svg',width:70,height:70,alt:''})),
      e('p',{class:'eyebrow'},'Tasks'),
      e('h1',null,'Спокойное пространство для заметок и планов'),
      e('p',{class:'onboarding-lead'},'Быстрая ежедневная работа на iPhone и полноценный workspace на компьютере — с offline-first и сквозным шифрованием.'),
      e('div',{class:'onboarding-benefits'},benefits.map(item=>e('article',{key:item.title},e('span',{class:'benefit-icon'},e(UiIcon,{name:item.icon,size:21})),e('div',null,e('strong',null,item.title),e('span',null,item.text))))),
      e('div',{class:'onboarding-actions'},e('button',{class:'primary onboarding-primary',onClick:onDone},'Войти в аккаунт'),
        !standalone&&e('button',{class:'secondary-button onboarding-install',onClick:()=>setInstall(value=>!value),'aria-expanded':install},'Как установить на iPhone')),
      install&&e('div',{class:'install-help',role:'status'},e('div',{class:'install-help-title'},e(UiIcon,{name:'info',size:18}),e('strong',null,'Установка на iPhone')),
        e('ol',null,e('li',null,'Откройте Tasks в Safari.'),e('li',null,'Нажмите «Поделиться».'),e('li',null,'Выберите «На экран Домой» и подтвердите добавление.')),
        e('p',null,'Push на iPhone доступен из установленной PWA после отдельного разрешения.'))));
}
