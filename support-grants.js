// Single-process, persistent one-time grants. No plaintext code or password is persisted.
const fs=require('node:fs'),crypto=require('node:crypto');
const USER='SupportAI',KEY='support:SupportAI',CODE_MS=10*60e3,SESSION_MS=2*60*60e3;
module.exports=function(file,clock=()=>Date.now()){
 let state=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{pending:null,session:null},busy=false;
 const attempts=new Map();let globalAttempts=[];
 const error=(status,message)=>Object.assign(Error(message),{status});
 const digest=(code,salt)=>crypto.createHash('sha256').update(salt+code).digest('hex');
 async function commit(next){const tmp=file+'.tmp';await fs.promises.writeFile(tmp,JSON.stringify(next),{mode:0o600});await fs.promises.rename(tmp,file);state=next;}
 async function exclusive(fn){if(busy)throw error(409,'Support access is being updated. Try again.');busy=true;try{return await fn();}finally{busy=false;}}
 const status=()=>({username:USER,codePending:!!state.pending && clock()<state.pending.expiresAt,codeExpiresAt:state.pending && clock()<state.pending.expiresAt?state.pending.expiresAt:null,sessionActive:!!state.session && clock()<state.session.expiresAt,sessionExpiresAt:state.session && clock()<state.session.expiresAt?state.session.expiresAt:null});
 return {
  status,
  valid(user){return user.support===true && user.key===KEY && !!state.session && user.supportGrant===state.session.id && clock()<state.session.expiresAt;},
  generate(){return exclusive(async()=>{const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let code='';for(let i=0;i<12;i++)code+=alphabet[crypto.randomInt(alphabet.length)];const salt=crypto.randomBytes(24).toString('hex');await commit({pending:{hash:digest(code,salt),salt,expiresAt:clock()+CODE_MS},session:null});return{...status(),code};});},
  revoke(){return exclusive(async()=>{await commit({pending:null,session:null});return status();});},
  login(username,code,ip){
   const now=clock();globalAttempts=globalAttempts.filter(t=>now-t<600000);const mine=(attempts.get(ip)||[]).filter(t=>now-t<600000);
   if(globalAttempts.length>=40 || mine.length>=8)throw error(429,'Too many sign-in attempts. Try again later.');
   if(attempts.size>=1000)attempts.clear();attempts.set(ip,[...mine,now]);globalAttempts.push(now);
   return exclusive(async()=>{
    const pending=state.pending,normal=typeof code==='string'?code.trim().toUpperCase():'';
    const actual=digest(normal,pending?.salt || 'unavailable'),expected=pending?.hash || '0'.repeat(64);
    const equal=crypto.timingSafeEqual(Buffer.from(actual,'hex'),Buffer.from(expected,'hex'));
    if(username!==USER || !/^[A-HJ-NP-Z2-9]{12}$/.test(normal) || !pending || clock()>=pending.expiresAt || !equal)throw error(401,'Invalid, expired or already used support code.');
    const session={id:crypto.randomUUID(),expiresAt:clock()+SESSION_MS};
    // Persist consumption before returning a login result, so two requests cannot redeem one code.
    await commit({pending:null,session});attempts.delete(ip);
    return{key:KEY,name:USER,username:USER,role:'officer',support:true,readOnly:true,supportGrant:session.id};
   });
  }
 };
};
