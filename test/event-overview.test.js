'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const summarize=require('../event-attendance-summary');
const members=[
 {id:1,owner:'a',role:'Tank',active:true},
 {id:2,owner:'b',role:'Healer',active:true},
 {id:3,owner:'c',role:'DPS',active:true},
 {id:4,owner:'d',role:'DPS',active:true},
 {id:5,owner:'away',role:'DPS',active:true},
 {id:6,owner:'merc',role:'DPS',active:true,mercenary:true},
 {id:7,owner:'inactive',role:'DPS',active:false},
 {id:8,owner:'new',role:'DPS',active:true,joinedAt:'2026-10-26T12:00:00Z'}
];
const leaves=[{ownerKey:'away',status:'approved',from:'2026-10-24',to:'2026-10-26'}];
const fixture=()=>({start:'2026-10-25T18:00:00Z',attendanceTracked:true,attended:[1,3],rsvps:{1:'yes',2:'yes',3:'no'},loaOverride:[]});
const summary=e=>summarize(e,members,leaves,'2026-10-25');
test('saved attendance counts actual presence independently of sign-ups',()=>{
 const r=summary(fixture());assert.equal(r.total,4);assert.equal(r.present,2);assert.equal(r.noShow,1);assert.equal(r.notRecorded,1);assert.equal(r.onLeave,1);assert.deepEqual(r.roles,{Tank:1,DPS:1});assert.equal(r.total,r.present+r.noShow+r.notRecorded);
});
test('never-tracked events do not imply no-shows or saved presence',()=>{
 const e=fixture();e.attendanceTracked=false;const r=summary(e);assert.equal(r.tracked,false);assert.equal(r.present,0);assert.equal(r.noShow,0);assert.equal(r.notRecorded,0);
});
test('voice and PIN sessions retain provisional status until finished',()=>{
 const e=fixture();e.voiceTracking={active:true};assert.equal(summary(e).inProgress,true);e.voiceTracking={active:false,finishedAt:'2026-10-25T18:01:00Z'};assert.equal(summary(e).inProgress,false);assert.equal(summarize(e,members,leaves,'2026-10-25',true).inProgress,true);
});
test('approved leave is excluded unless overridden or actually credited',()=>{
 const e=fixture();e.loaOverride=['away'];assert.equal(summary(e).total,5);assert.equal(summary(e).onLeave,0);e.loaOverride=[];e.attended.push(5);assert.equal(summary(e).present,3);assert.equal(summary(e).total,5);assert.equal(summary(e).onLeave,0);
});
test('manual corrections, duplicate credits and missing member ids are counted accurately',()=>{
 const e=fixture();e.attended=[1,1,2,999,6,7,8];const r=summary(e);assert.equal(r.present,2);assert.equal(r.noShow,0);assert.equal(r.notRecorded,2);e.attended=[];const empty=summary(e);assert.equal(empty.present,0);assert.equal(empty.noShow,2);
});
test('summary exposes counts only, without players or voice sightings',()=>{
 const e=fixture();e.voiceTracking={seen:{privateDiscordId:{name:'Private name',channelId:'secret'}}};const r=summary(e);const serialized=JSON.stringify(r);assert(!serialized.includes('Private'));assert(!serialized.includes('secret'));assert(!serialized.includes('privateDiscordId'));assert(!('attended' in r));
});
