(function(){
"use strict";
const $=id=>document.getElementById(id), KEY="phoenix.web.conversations.v1";
const state={messages:[],conversations:[],conversationId:null,busy:false};
function load(){try{const v=JSON.parse(localStorage.getItem(KEY)||"[]");return Array.isArray(v)?v:[]}catch(_){return[]}}
function persist(){localStorage.setItem(KEY,JSON.stringify(state.conversations.slice(0,50)))}
function addMessage(role,content){
 const item=document.createElement("article");item.className="message "+role;
 const avatar=document.createElement("div");avatar.className="message-avatar";avatar.textContent=role==="user"?"V":"✦";
 const body=document.createElement("div");body.className="message-body";
 const label=document.createElement("div");label.className="message-label";label.textContent=role==="user"?"You":"Phoenix";
 const text=document.createElement("div");text.className="message-content";text.textContent=content;
 body.append(label,text);item.append(avatar,body);$("messages").append(item);$("chat-area").scrollTop=$("chat-area").scrollHeight;
}
function renderList(){
 const list=$("conversation-list");list.replaceChildren();
 if(!state.conversations.length){const e=document.createElement("div");e.className="conversation-empty";e.textContent="Your conversations will appear here.";list.append(e);return}
 state.conversations.forEach(c=>{
  const row=document.createElement("div");row.className="conversation-item"+(c.id===state.conversationId?" active":"");
  const open=document.createElement("button");open.type="button";open.className="conversation-item";open.style.flex="1";open.style.padding="0";
  const title=document.createElement("span");title.textContent=c.title||"New conversation";open.append(title);open.onclick=()=>openChat(c.id);
  const del=document.createElement("button");del.type="button";del.className="conversation-delete";del.textContent="×";del.title="Delete conversation";
  del.onclick=()=>{state.conversations=state.conversations.filter(x=>x.id!==c.id);if(state.conversationId===c.id)clearChat();persist();renderList()};
  row.append(open,del);list.append(row);
 });
}
function openChat(id){const c=state.conversations.find(x=>x.id===id);if(!c)return;state.conversationId=id;state.messages=c.messages||[];$("messages").replaceChildren();state.messages.forEach(m=>addMessage(m.role,m.content));$("welcome").classList.toggle("hidden",!!state.messages.length);renderList();$("sidebar").classList.remove("open")}
function ensureChat(first){if(state.conversationId)return;state.conversationId=crypto.randomUUID?crypto.randomUUID():String(Date.now());state.conversations.unshift({id:state.conversationId,title:first.replace(/\s+/g," ").slice(0,72)||"New conversation",messages:[],updatedAt:Date.now()})}
function save(role,content){const c=state.conversations.find(x=>x.id===state.conversationId);if(!c)return;c.messages.push({role,content});c.updatedAt=Date.now();state.conversations.sort((x,y)=>y.updatedAt-x.updatedAt);persist();renderList()}
function typing(){const item=document.createElement("article");item.className="message assistant";item.id="typing-indicator";const av=document.createElement("div");av.className="message-avatar";av.textContent="✦";const body=document.createElement("div");body.className="message-body";const label=document.createElement("div");label.className="message-label";label.textContent="Phoenix is thinking";const dots=document.createElement("div");dots.className="typing";dots.innerHTML="<span></span><span></span><span></span>";body.append(label,dots);item.append(av,body);$("messages").append(item)}
async function check(){try{const r=await fetch("/readyz");if(!r.ok)throw 0;$("provider-status").textContent="OpenRouter ready";$("connection-label").textContent="Cloud ready"}catch(_){$("provider-status").textContent="Cloud unavailable";$("connection-label").textContent="Offline"}}
async function send(value){
 const content=(value||"").trim();if(!content||state.busy)return;state.busy=true;$("send-button").disabled=true;$("welcome").classList.add("hidden");ensureChat(content);state.messages.push({role:"user",content});save("user",content);addMessage("user",content);$("prompt").value="";resize();typing();
 try{
  const r=await fetch("/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:state.messages.slice(-40),temperature:.7,max_tokens:1200})});
  const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.detail||d.error?.message||"Phoenix could not complete the request.");
  const answer=d.choices?.[0]?.message?.content;if(typeof answer!=="string"||!answer.trim())throw Error("The AI provider returned an empty response.");
  state.messages.push({role:"assistant",content:answer});save("assistant",answer);$("typing-indicator")?.remove();addMessage("assistant",answer);
 }catch(e){$("typing-indicator")?.remove();addMessage("assistant","I couldn't complete that request: "+e.message)}
 finally{state.busy=false;$("send-button").disabled=false;$("prompt").focus()}
}
function resize(){const x=$("prompt");x.style.height="auto";x.style.height=Math.min(x.scrollHeight,160)+"px"}
function clearChat(){if(state.busy)return;state.messages=[];state.conversationId=null;$("messages").replaceChildren();$("welcome").classList.remove("hidden");renderList();$("prompt").focus()}
$("chat-form").addEventListener("submit",e=>{e.preventDefault();send($("prompt").value)});
$("prompt").addEventListener("input",resize);$("prompt").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send($("prompt").value)}});
$("new-chat").onclick=clearChat;$("clear-chat").onclick=clearChat;
document.querySelectorAll("[data-prompt]").forEach(b=>b.onclick=()=>send(b.getAttribute("data-prompt")));
$("settings-button").onclick=()=>$("settings-modal").classList.remove("hidden");$("close-settings").onclick=()=>$("settings-modal").classList.add("hidden");
$("settings-modal").onclick=e=>{if(e.target===$("settings-modal"))$("settings-modal").classList.add("hidden")};
$("open-sidebar").onclick=()=>$("sidebar").classList.add("open");$("close-sidebar").onclick=()=>$("sidebar").classList.remove("open");
$("devices-link").onclick=()=>alert("Device pairing will be added in a later integration phase.");
state.conversations=load();renderList();if(state.conversations.length)openChat(state.conversations[0].id);check();
})();