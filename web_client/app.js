(function(){
  "use strict";
  const $ = (id) => document.getElementById(id);
  const state = {config:null, mode:"login", session:null, messages:[], conversations:[], conversationId:null, busy:false};
  const AUTH_KEY = "phoenix.web.session.v1";
  const authScreen=$("auth-screen"), appScreen=$("app-screen"), authForm=$("auth-form");
  function setMessage(node,text,error){node.textContent=text||"";node.style.color=error?"#ff9d9d":"#8edfc9";}
  function setMode(mode){
    state.mode=mode;
    $("login-tab").classList.toggle("active",mode==="login");
    $("signup-tab").classList.toggle("active",mode==="signup");
    $("auth-submit").innerHTML=mode==="login"?'Sign in <span>→</span>':'Create account <span>→</span>';
    $("password").autocomplete=mode==="login"?"current-password":"new-password";
    setMessage($("auth-message"),"",false);
  }
  async function loadConfig(){
    const response=await fetch("/v1/config");
    if(!response.ok) throw new Error("Cloud sign-in is not configured yet. Ask the administrator to configure Supabase in Render.");
    state.config=await response.json();
  }
  function saveSession(session){
    state.session=session;
    if(session) sessionStorage.setItem(AUTH_KEY,JSON.stringify(session));
    else sessionStorage.removeItem(AUTH_KEY);
  }
  function restoreSession(){
    try{const value=sessionStorage.getItem(AUTH_KEY);if(value)state.session=JSON.parse(value);}catch(_){sessionStorage.removeItem(AUTH_KEY);}
  }
  async function authRequest(path,body){
    const response=await fetch(state.config.supabase_url+path,{
      method:"POST",headers:{"apikey":state.config.supabase_publishable_key,"Content-Type":"application/json"},body:JSON.stringify(body)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.msg||data.message||data.error_description||data.error||"Authentication failed.");
    return data;
  }
  async function refreshSession(){
    if(!state.session||!state.session.refresh_token)return false;
    try{
      const next=await authRequest("/auth/v1/token?grant_type=refresh_token",{refresh_token:state.session.refresh_token});
      saveSession(next);return true;
    }catch(_){saveSession(null);return false;}
  }
  async function apiFetch(path,options){
    const opts=options||{};opts.headers=Object.assign({},opts.headers||{});
    if(state.session&&state.session.access_token)opts.headers.Authorization="Bearer "+state.session.access_token;
    let response=await fetch(path,opts);
    if(response.status===401&&state.session&&await refreshSession()){
      opts.headers.Authorization="Bearer "+state.session.access_token;
      response=await fetch(path,opts);
    }
    return response;
  }
  async function submitAuth(event){
    event.preventDefault();
    const email=$("email").value.trim(),password=$("password").value;
    const button=$("auth-submit");button.disabled=true;setMessage($("auth-message"),state.mode==="login"?"Signing in…":"Creating your account…",false);
    try{
      const data=state.mode==="login"
        ? await authRequest("/auth/v1/token?grant_type=password",{email:email,password:password})
        : await authRequest("/auth/v1/signup",{email:email,password:password});
      if(data.access_token){saveSession(data);showApp();}
      else setMessage($("auth-message"),"Account created. Check your email to confirm it, then sign in.",false);
    }catch(error){setMessage($("auth-message"),error.message,true);}
    finally{button.disabled=false;}
  }
  async function checkBackend(){
    try{
      const response=await fetch("/readyz");
      if(response.ok){$("provider-status").textContent="OpenRouter ready";$("connection-label").textContent="Cloud ready";}
      else{$("provider-status").textContent="Server setup needed";$("connection-label").textContent="Setup required";}
    }catch(_){$("provider-status").textContent="Cloud unavailable";$("connection-label").textContent="Offline";}
  }
  function showApp(){
    authScreen.classList.add("hidden");appScreen.classList.remove("hidden");
    const email=state.session.user&&state.session.user.email?state.session.user.email:"Phoenix user";
    $("profile-email").textContent=email;$("settings-identity").textContent=email;
    $("avatar").textContent=email.charAt(0).toUpperCase();
    $("provider-status").textContent="Checking cloud…";$("connection-label").textContent="Checking";
    checkBackend();loadConversations();$("prompt").focus();
  }
  async function signOut(){
    try{if(state.session&&state.session.access_token)await fetch(state.config.supabase_url+"/auth/v1/logout",{method:"POST",headers:{"apikey":state.config.supabase_publishable_key,"Authorization":"Bearer "+state.session.access_token}});}catch(_){}
    saveSession(null);state.messages=[];state.conversations=[];state.conversationId=null;state.busy=false;
    appScreen.classList.add("hidden");authScreen.classList.remove("hidden");$("profile-menu").classList.add("hidden");
    $("messages").replaceChildren();$("conversation-list").replaceChildren();$("welcome").classList.remove("hidden");$("prompt").value="";
  }
  function addMessage(role,content){
    const item=document.createElement("article");item.className="message "+role;
    const avatar=document.createElement("div");avatar.className="message-avatar";avatar.textContent=role==="user"?"V":"✦";
    const body=document.createElement("div");body.className="message-body";
    const label=document.createElement("div");label.className="message-label";label.textContent=role==="user"?"You":"Phoenix";
    const text=document.createElement("div");text.className="message-content";text.textContent=content;
    body.append(label,text);item.append(avatar,body);$("messages").append(item);$("chat-area").scrollTop=$("chat-area").scrollHeight;
    return text;
  }
  function showTyping(){
    const item=document.createElement("article");item.className="message assistant";item.id="typing-indicator";
    const avatar=document.createElement("div");avatar.className="message-avatar";avatar.textContent="✦";
    const body=document.createElement("div");body.className="message-body";
    const label=document.createElement("div");label.className="message-label";label.textContent="Phoenix is thinking";
    const dots=document.createElement("div");dots.className="typing";dots.innerHTML="<span></span><span></span><span></span>";
    body.append(label,dots);item.append(avatar,body);$("messages").append(item);$("chat-area").scrollTop=$("chat-area").scrollHeight;
  }
  async function ensureConversation(firstMessage){
    if(state.conversationId)return state.conversationId;
    const title=firstMessage.replace(/\\s+/g," ").slice(0,72)||"New conversation";
    const response=await apiFetch("/v1/conversations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title:title})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||!data.conversation)throw new Error(data.detail||"Could not create a saved conversation.");
    state.conversationId=data.conversation.id;await loadConversations(false);return state.conversationId;
  }
  async function saveConversationMessage(role,content){
    if(!state.conversationId)return;
    const response=await apiFetch("/v1/conversations/"+encodeURIComponent(state.conversationId)+"/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({role:role,content:content})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data.detail||"Conversation could not be saved.");
    return data.message;
  }
  async function loadConversations(selectLatest){
    try{
      const response=await apiFetch("/v1/conversations?limit=50");
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.detail||"Unable to load conversations.");
      state.conversations=data.conversations||[];renderConversationList();
      if(selectLatest!==false&&state.conversations.length&&!state.conversationId)await openConversation(state.conversations[0].id);
    }catch(error){$("conversation-list").innerHTML='<div class="conversation-empty">Saved chats unavailable right now.</div>';}
  }
  function renderConversationList(){
    const list=$("conversation-list");list.replaceChildren();
    if(!state.conversations.length){const empty=document.createElement("div");empty.className="conversation-empty";empty.textContent="Your conversations will appear here.";list.append(empty);return;}
    state.conversations.forEach(conversation=>{
      const row=document.createElement("div");row.className="conversation-item"+(conversation.id===state.conversationId?" active":"");
      const open=document.createElement("button");open.type="button";open.className="conversation-item";open.style.flex="1";open.style.padding="0";open.textContent="";
      const title=document.createElement("span");title.textContent=conversation.title||"Untitled conversation";open.append(title);
      open.addEventListener("click",()=>openConversation(conversation.id));
      const remove=document.createElement("button");remove.type="button";remove.className="conversation-delete";remove.title="Archive conversation";remove.textContent="×";
      remove.addEventListener("click",async e=>{e.stopPropagation();await archiveConversation(conversation.id);});
      row.append(open,remove);list.append(row);
    });
  }
  async function openConversation(id){
    if(state.busy)return;
    const response=await apiFetch("/v1/conversations/"+encodeURIComponent(id)+"/messages?limit=200");
    const data=await response.json().catch(()=>({}));
    if(!response.ok){addMessage("assistant","I couldn't open that conversation: "+(data.detail||"Unknown error"));return;}
    state.conversationId=id;state.messages=(data.messages||[]).map(item=>({role:item.role,content:item.content}));
    $("messages").replaceChildren();state.messages.forEach(item=>addMessage(item.role,item.content));
    $("welcome").classList.toggle("hidden",state.messages.length>0);renderConversationList();
    $("sidebar").classList.remove("open");
  }
  async function archiveConversation(id){
    const response=await apiFetch("/v1/conversations/"+encodeURIComponent(id),{method:"DELETE"});
    if(!response.ok){addMessage("assistant","I couldn't archive that conversation.");return;}
    if(state.conversationId===id){state.conversationId=null;state.messages=[];$("messages").replaceChildren();$("welcome").classList.remove("hidden");}
    await loadConversations(false);
  }
  async function sendMessage(value){
    const content=(value||"").trim();if(!content||state.busy)return;
    state.busy=true;$("send-button").disabled=true;$("welcome").classList.add("hidden");
    state.messages.push({role:"user",content:content});addMessage("user",content);$("prompt").value="";resizePrompt();showTyping();
    try{
      await ensureConversation(content);
      await saveConversationMessage("user",content);
      const context=state.messages.slice(-40);
      const response=await apiFetch("/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:context,temperature:0.7,max_tokens:1200})});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.detail||data.error?.message||"Phoenix could not complete the request.");
      const answer=data.choices&&data.choices[0]&&data.choices[0].message&&data.choices[0].message.content;
      if(typeof answer!=="string"||!answer.trim())throw new Error("The AI provider returned an empty response.");
      state.messages.push({role:"assistant",content:answer});await saveConversationMessage("assistant",answer);
      $("typing-indicator")?.remove();addMessage("assistant",answer);await loadConversations(false);
    }catch(error){
      $("typing-indicator")?.remove();addMessage("assistant","I couldn't complete that request: "+error.message);
    }finally{state.busy=false;$("send-button").disabled=false;$("prompt").focus();}
  }
  function resizePrompt(){const area=$("prompt");area.style.height="auto";area.style.height=Math.min(area.scrollHeight,160)+"px";}
  function clearChat(){if(state.busy)return;state.messages=[];state.conversationId=null;$("messages").replaceChildren();$("welcome").classList.remove("hidden");renderConversationList();$("prompt").focus();}
  $("login-tab").addEventListener("click",()=>setMode("login"));
  $("signup-tab").addEventListener("click",()=>setMode("signup"));
  authForm.addEventListener("submit",submitAuth);
  $("chat-form").addEventListener("submit",e=>{e.preventDefault();sendMessage($("prompt").value);});
  $("prompt").addEventListener("input",resizePrompt);
  $("prompt").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage($("prompt").value);}});
  $("new-chat").addEventListener("click",clearChat);$("clear-chat").addEventListener("click",clearChat);
  document.querySelectorAll("[data-prompt]").forEach(button=>button.addEventListener("click",()=>sendMessage(button.getAttribute("data-prompt"))));
  $("profile-button").addEventListener("click",()=>$("profile-menu").classList.toggle("hidden"));
  $("signout-button").addEventListener("click",signOut);
  $("settings-button").addEventListener("click",()=>$("settings-modal").classList.remove("hidden"));
  $("close-settings").addEventListener("click",()=>$("settings-modal").classList.add("hidden"));
  $("settings-modal").addEventListener("click",e=>{if(e.target===$("settings-modal"))$("settings-modal").classList.add("hidden");});
  $("open-sidebar").addEventListener("click",()=>$("sidebar").classList.add("open"));
  $("close-sidebar").addEventListener("click",()=>$("sidebar").classList.remove("open"));
  $("devices-link").addEventListener("click",()=>alert("Device pairing will be added in a later integration phase."));
  async function boot(){
    try{await loadConfig();restoreSession();if(state.session&&state.session.access_token){if(Date.now()/1000>Number(state.session.expires_at||0)-60)await refreshSession();if(state.session&&state.session.access_token){const response=await apiFetch("/v1/me");if(response.ok){showApp();return;}saveSession(null);}}}
    catch(error){setMessage($("auth-message"),error.message,true);}
  }
  boot();
})();