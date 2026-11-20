document.getElementById('support-login').addEventListener('submit',async event=>{
 event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),error=document.getElementById('support-error');button.disabled=true;error.textContent='';
 try{const response=await fetch('/api/support/login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'SupportAI',code:form.elements.code.value})});const result=await response.json();if(!response.ok)throw Error(result.error || 'Sign-in failed.');localStorage.removeItem('gh_token');location.assign('/#/diagnostics');}catch(e){error.textContent=e.message;}finally{form.elements.code.value='';button.disabled=false;}
});
