import { h as e } from 'preact';
import { useState } from 'preact/hooks';

export function Onboarding({onDone}:{onDone:()=>void}){
  const [install,setInstall]=useState(false);
  const standalone=window.matchMedia('(display-mode: standalone)').matches||Boolean((navigator as Navigator&{standalone?:boolean}).standalone);
  return e('main',{class:'onboarding-screen'},
    e('button',{class:'onboarding-skip',onClick:onDone},'Пропустить'),
    e('section',{class:'onboarding-hero'},
      e('div',{class:'onboarding-mark'},e('img',{src:'/icon.svg',width:72,height:72,alt:''})),
      e('p',{class:'eyebrow'},'TASKS'),e('h1',null,'Заметки, задачи и проекты — в одном месте'),
      e('p',{class:'onboarding-lead'},'Работайте офлайн, синхронизируйте устройства и храните содержимое E2EE-зашифрованным.'),
      e('div',{class:'onboarding-benefits'},
        e('div',null,e('strong',null,'Локальная работа'),e('span',null,'Черновики и открытые хранилища доступны без сети.')),
        e('div',null,e('strong',null,'E2EE'),e('span',null,'Сервер не получает открытый текст заметок и задач.')),
        e('div',null,e('strong',null,'Напоминания и проекты'),e('span',null,'Сегодня, повторения, зависимости и Гант работают вместе.'))),
      e('button',{class:'primary onboarding-primary',onClick:onDone},'Войти в аккаунт'),
      !standalone&&e('button',{class:'onboarding-install',onClick:()=>setInstall(value=>!value),'aria-expanded':install},'Установить на iPhone'),
      install&&e('div',{class:'install-help',role:'status'},e('strong',null,'Установка на iPhone'),e('ol',null,
        e('li',null,'Откройте этот сайт в Safari.'),e('li',null,'Нажмите «Поделиться».'),e('li',null,'Выберите «На экран Домой» и подтвердите добавление.')),
        e('p',null,'Push-уведомления на iPhone используются из установленной PWA и требуют отдельного разрешения.'))));
}
