export interface ReminderPlan { id:string;state:'active'|'off'|'done';local:string;mode:'neutral'|'custom';text:string }
export const intervals:number[];
export function validZone(zone:unknown):boolean;
export function localTime(ms:number,zone:string):string;
export function zonedTime(local:string,zone:string):number|null;
export function validPlan(p:unknown):p is ReminderPlan;
