'use strict';
function sessionState(status){return status?.sessionState || status?.diagnostics?.sessionState || (status?.active?'active':'inactive');}
function identity(status){
 if(status?.sessionId)return 'id:'+status.sessionId;
 const channels=(status?.parties || []).map(p=>p.channelId).filter(Boolean).sort();
 return channels.length?'legacy:'+channels.join(','):null;
}
module.exports={identity,sessionState};
