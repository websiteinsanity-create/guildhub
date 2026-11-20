'use strict';
// A recorded roster can still be provisional while voice checks or PIN entries are open.
module.exports=function attendanceFinal(event,now=Date.now(),finalAfterMinutes=0){
 if(!event.attendanceTracked || event.voiceTracking?.active)return false;
 if(event.voiceTracking?.incomplete && !event.autoAttended)return false;
 const start=Date.parse(event.start);if(!Number.isFinite(start))return false;
 let readyAt=start+Math.max(0,Number(finalAfterMinutes)||0)*60000;
 if(event.pin){
  const opens=Date.parse(event.pin.at),window=Number(event.pinWindowMinutes);
  if(!Number.isFinite(opens) || !Number.isFinite(window))return false;
  readyAt=Math.max(readyAt,opens+window*60000);
 }
 return now>readyAt;
};
