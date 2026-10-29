const {monitorEventLoopDelay}=require('node:perf_hooks');
module.exports=function(){
 const recent=[],lag=monitorEventLoopDelay({resolution:20});lag.enable();
 let total=0,errors=0;
 return {
 record(method,route,status,ms){total++;if(status>=500)errors++;recent.push({at:new Date().toISOString(),method,route,status,ms:Math.round(ms*10)/10});if(recent.length>200)recent.shift();},
 snapshot(db,version){return{at:new Date().toISOString(),version,uptimeSeconds:Math.floor(process.uptime()),memoryMiB:{rss:Math.round(process.memoryUsage().rss/1048576),heap:Math.round(process.memoryUsage().heapUsed/1048576)},eventLoopMs:{mean:Number.isFinite(lag.mean)?Math.round(lag.mean/1e5)/10:0,max:Math.round(lag.max/1e5)/10},api:{total,serverErrors:errors,recent:[...recent].reverse()},counts:{members:db.members.length,events:db.events.length},tracks:db.events.filter(e=>e.voiceTracking?.active || e.voiceTracking?.incomplete).map(e=>({id:e.id,title:e.title,active:!!e.voiceTracking.active,incomplete:!!e.voiceTracking.incomplete,checksDone:e.voiceTracking.checksDone || 0,checksTotal:3,runId:e.voiceTracking.runId || null,sessionBinding:e.voiceTracking.sessionBinding || null,recorded:e.attended?.length || 0})),limitations:['Metrics cover this GuildHub process since its last restart.','API timings end when the response is sent; they are not browser load times.','Event-loop maximum covers the process lifetime.','Docker logs, Discord gateway logs and audio latency are not collected.']};}
 };
};
