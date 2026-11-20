const {setImmediate:yieldTurn}=require('node:timers/promises');
module.exports=async db=>{
 const parts=['{'];let first=true,start=performance.now();
 for(const key of Object.keys(db)){
  const v=db[key];if(v===undefined || typeof v==='function')continue;
  if(!first)parts.push(',');first=false;parts.push(JSON.stringify(key),':');
  if(Array.isArray(v)){parts.push('[');for(let i=0;i<v.length;i++){if(i)parts.push(',');parts.push(JSON.stringify(v[i])??'null');if(performance.now()-start>=4){await yieldTurn();start=performance.now();}}parts.push(']');}else parts.push(JSON.stringify(v));
  if(performance.now()-start>=4){await yieldTurn();start=performance.now();}
 }
 parts.push('}');return parts.join('');
};
