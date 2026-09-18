export type ThemePreference='system'|'light'|'dark';
const KEY='tasks-theme-v1';
export function readThemePreference():ThemePreference{
  try{const value=localStorage.getItem(KEY);return value==='light'||value==='dark'?value:'system';}catch{return'system';}
}
export function resolvedTheme(value:ThemePreference=readThemePreference()):'light'|'dark'{
  return value==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):value;
}
export function applyTheme(value:ThemePreference=readThemePreference()){
  document.documentElement.dataset.theme=resolvedTheme(value);
  document.documentElement.dataset.themePreference=value;
}
export function setThemePreference(value:ThemePreference){
  try{localStorage.setItem(KEY,value);}catch{}
  applyTheme(value);
}
