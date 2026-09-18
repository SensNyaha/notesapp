import test from 'node:test';
import assert from 'node:assert/strict';
import { addScheduleDays,cascadeSchedule,criticalTaskIds,dependencyConflicts,normalizeDependencies,validateDependencyGraph } from '../src/gantt.ts';

test('weekdays calendar skips weekends in both directions',()=>{
  assert.equal(addScheduleDays('2026-09-18',1,'weekdays'),'2026-09-21');
  assert.equal(addScheduleDays('2026-09-21',-1,'weekdays'),'2026-09-18');
  assert.equal(addScheduleDays('2026-09-18',3,'calendar'),'2026-09-21');
});

test('dependency validation rejects duplicates, self-links and cycles',()=>{
  assert.throws(()=>normalizeDependencies([{taskId:'a',type:'FS',lagDays:0}], 'a'),/самой себя/);
  assert.throws(()=>normalizeDependencies([{taskId:'a',type:'FS',lagDays:0},{taskId:'a',type:'SS',lagDays:0}]),/дважды/);
  assert.throws(()=>validateDependencyGraph([
    {id:'a',title:'A',dependencies:[{taskId:'b',type:'FS',lagDays:0}]},
    {id:'b',title:'B',dependencies:[{taskId:'a',type:'FS',lagDays:0}]},
  ]),/цикл/);
});

test('FS cascade moves the dependent chain and preserves ranges',()=>{
  const tasks=[
    {id:'a',title:'A',startDate:'2026-09-14',endDate:'2026-09-16'},
    {id:'b',title:'B',startDate:'2026-09-17',endDate:'2026-09-18',dependencies:[{taskId:'a',type:'FS',lagDays:0}]},
    {id:'c',title:'C',startDate:'2026-09-21',endDate:'2026-09-22',dependencies:[{taskId:'b',type:'FS',lagDays:0}]},
  ];
  const impact=cascadeSchedule(tasks,'a','2026-09-17','2026-09-21','weekdays');
  assert.deepEqual(impact.changes.map(x=>[x.id,x.startDate,x.endDate]),[
    ['a','2026-09-17','2026-09-21'],['b','2026-09-22','2026-09-23'],['c','2026-09-24','2026-09-25'],
  ]);
  assert.equal(impact.conflicts.length,0);
});

test('all dependency types report conflicts with their relevant endpoint',()=>{
  const predecessor={id:'a',title:'A',startDate:'2026-09-10',endDate:'2026-09-12'};
  const successors=[
    {id:'fs',title:'FS',startDate:'2026-09-12',endDate:'2026-09-14',dependencies:[{taskId:'a',type:'FS',lagDays:0}]},
    {id:'ss',title:'SS',startDate:'2026-09-09',endDate:'2026-09-14',dependencies:[{taskId:'a',type:'SS',lagDays:0}]},
    {id:'ff',title:'FF',startDate:'2026-09-09',endDate:'2026-09-11',dependencies:[{taskId:'a',type:'FF',lagDays:0}]},
    {id:'sf',title:'SF',startDate:'2026-09-08',endDate:'2026-09-09',dependencies:[{taskId:'a',type:'SF',lagDays:0}]},
  ];
  assert.deepEqual(new Set(dependencyConflicts([predecessor,...successors],'calendar').map(x=>x.taskId)),new Set(['fs','ss','ff','sf']));
});

test('critical path selects longest dependency chain',()=>{
  const ids=criticalTaskIds([
    {id:'a',title:'A',startDate:'2026-09-01',endDate:'2026-09-03'},
    {id:'b',title:'B',startDate:'2026-09-04',endDate:'2026-09-10',dependencies:[{taskId:'a',type:'FS',lagDays:0}]},
    {id:'c',title:'C',startDate:'2026-09-04',endDate:'2026-09-04',dependencies:[{taskId:'a',type:'FS',lagDays:0}]},
  ],'calendar');
  assert.deepEqual(ids,new Set(['a','b']));
});
