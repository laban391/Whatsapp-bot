'use strict';
const fs = require('fs');
const path = require('path');
const DATA = path.join(__dirname, '..', 'data');
const timers = new WeakMap();
function botKey(sock) {
  const id = String(sock?.user?.id || 'unpaired').split(':')[0].split('@')[0].replace(/\D/g, '') || 'unpaired';
  return id;
}
function configPath(sock) { return path.join(DATA, `autorecordtype-${botKey(sock)}.json`); }
function load(sock) {
  try { return { enabled: false, mode: 'all', duration: 60, infinite: false, ...JSON.parse(fs.readFileSync(configPath(sock), 'utf8')) }; }
  catch { return { enabled: false, mode: 'all', duration: 60, infinite: false }; }
}
function save(sock, cfg) { fs.mkdirSync(DATA, {recursive:true}); fs.writeFileSync(configPath(sock), JSON.stringify(cfg,null,2)); }
function stop(sock, chat) { const map=timers.get(sock); const t=map?.get(chat); if(t){clearInterval(t.interval);clearTimeout(t.timeout);map.delete(chat);} }
async function onMessage(sock, message) {
  if (!message?.key?.remoteJid || message.key.fromMe) return;
  const chat=message.key.remoteJid; if(chat==='status@broadcast'||chat.endsWith('@newsletter')) return;
  const cfg=load(sock); if(!cfg.enabled) return;
  if(cfg.mode==='dms' && chat.endsWith('@g.us')) return;
  if(cfg.mode==='groups' && !chat.endsWith('@g.us')) return;
  let map=timers.get(sock); if(!map){map=new Map();timers.set(sock,map);} stop(sock,chat);
  try {
    if(typeof sock.presenceSubscribe==='function') await sock.presenceSubscribe(chat);
    await sock.sendPresenceUpdate('recording',chat);
    let recording=true;
    const entry={interval:null,timeout:null};
    entry.interval=setInterval(async()=>{try{recording=!recording;await sock.sendPresenceUpdate(recording?'recording':'composing',chat);}catch(e){stop(sock,chat);}},5000);
    if(!cfg.infinite) entry.timeout=setTimeout(async()=>{try{await sock.sendPresenceUpdate('paused',chat);}catch{} stop(sock,chat);},Math.max(5,Number(cfg.duration)||60)*1000);
    map.set(chat,entry);
  } catch(e){console.error('[AUTORECORDTYPE]',e.message);}
}
async function command(sock, chat, message, args) {
  const cfg=load(sock); const a=(args[0]||'status').toLowerCase();
  if(a==='on'||a==='enable'){cfg.enabled=true;save(sock,cfg);}
  else if(a==='off'||a==='disable'){cfg.enabled=false;save(sock,cfg);const map=timers.get(sock);if(map)for(const c of [...map.keys()])stop(sock,c);try{await sock.sendPresenceUpdate('paused',chat);}catch{} }
  else if(a==='mode'&&['all','dms','groups'].includes((args[1]||'').toLowerCase())){cfg.mode=args[1].toLowerCase();save(sock,cfg);}
  else if(a==='duration'){const v=(args[1]||'').toLowerCase();if(v==='infinite')cfg.infinite=true;else{const n=Number(v);if(!Number.isInteger(n)||n<5||n>120){await sock.sendMessage(chat,{text:'Use .autorecordtype duration 5-120 or infinite'},{quoted:message});return;}cfg.duration=n;cfg.infinite=false;}save(sock,cfg);}
  else if(a!=='status'){await sock.sendMessage(chat,{text:'Usage: .autorecordtype on/off | mode all/dms/groups | duration 5-120/infinite'},{quoted:message});return;}
  const current=load(sock);const active=timers.get(sock)?.size||0;
  await sock.sendMessage(chat,{text:`🎙️ *AUTO-RECORD-TYPE*\nStatus: ${current.enabled?'ON':'OFF'}\nMode: ${current.mode}\nDuration: ${current.infinite?'Infinite':current.duration+'s'}\nActive chats: ${active}\n\n.autorecordtype on/off\n.autorecordtype mode all/dms/groups\n.autorecordtype duration 5-120/infinite`},{quoted:message});
}
module.exports={onMessage,command};
