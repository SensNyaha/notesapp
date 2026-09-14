export type ReminderRepeat={type:'once'}|{type:'daily'}|{type:'weekly';days:number[]}|{type:'interval';days:number}|{type:'monthly';day:number;shortMonth:'last'|'skip'};
export type ReminderEnd={type:'never'}|{type:'date';date:string}|{type:'count';count:number};
export interface ReminderPlan { id:string;state:'active'|'off'|'done';local:string;mode:'neutral'|'custom'|'title';text:string;repeat?:ReminderRepeat;end?:ReminderEnd;allDay?:boolean;important?:boolean }
export const intervals:number[];
export function validZone(zone:unknown):boolean;
export function localTime(ms:number,zone:string):string;
export function zonedTime(local:string,zone:string):number|null;
export function validPlan(p:unknown):p is ReminderPlan;
export function normalizePlan(p:ReminderPlan):ReminderPlan&{repeat:ReminderRepeat;end:ReminderEnd;allDay:boolean;important:boolean};
export function nextOccurrenceLocal(plan:ReminderPlan,current:string,sequence:number):string|null;
