const { Plugin, PluginSettingTab, Setting, Notice, TFile, normalizePath, requestUrl } = require('obsidian');

const VERSION = '1.0.1';
const DEFAULTS = { serverUrl:'', apiUrl:'', deviceId:'', token:'', vaultRoot:'Synced Notes', notes:{}, pending:{}, connectedAt:'', lastSyncAt:'', lastError:'' };

function cleanRoot(v){
  v=String(v||'Synced Notes').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'').trim();
  return normalizePath(v||'Synced Notes');
}
function joinPath(...parts){ return normalizePath(parts.filter(Boolean).join('/')); }
function sleep(ms){ return new Promise(r=>window.setTimeout(r,ms)); }
function toHex(buffer){ return Array.from(new Uint8Array(buffer)).map(b=>b.toString(16).padStart(2,'0')).join(''); }
async function sha256ArrayBuffer(buffer){ return toHex(await crypto.subtle.digest('SHA-256',buffer)); }
async function sha256Text(text){ return sha256ArrayBuffer(new TextEncoder().encode(String(text||'')).buffer); }
function arrayBufferToBase64(buffer){
  const bytes=new Uint8Array(buffer);let binary='';const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
  return btoa(binary);
}
function changeId(){ return 'vs-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,12); }

class VaultSyncHelperPlugin extends Plugin {
  async onload(){
    this.settings=Object.assign({},DEFAULTS,await this.loadData()||{});this.settings.notes=this.settings.notes||{};this.settings.pending=this.settings.pending||{};
    this.syncing=false;this.suppressPaths=new Map();this.debounceTimer=null;this.statusBar=this.addStatusBarItem();this.setStatus(this.isConnected()?'Ready':'Not connected');
    this.addSettingTab(new VaultSyncSettingTab(this.app,this));
    this.addRibbonIcon('refresh-cw','Sync linked notes',()=>this.syncNow(true));
    this.addCommand({id:'sync-now',name:'Sync linked notes now',callback:()=>this.syncNow(true)});
    this.registerObsidianProtocolHandler('vault-sync-helper',async params=>{
      try{await this.connectFromUri(params||{});new Notice('Connection complete. Syncing notes…');await this.syncNow(true);}catch(e){this.fail(e,'Connection failed');}
    });
    this.app.workspace.onLayoutReady(()=>{
      this.registerEvent(this.app.vault.on('modify',file=>this.onVaultModify(file)));
      this.registerEvent(this.app.vault.on('create',file=>this.onVaultModify(file)));
      this.registerEvent(this.app.vault.on('delete',file=>this.onVaultModify(file)));
      this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{this.onVaultModify(file);if(oldPath)this.onPathActivity(oldPath);}));
      if(this.isConnected())window.setTimeout(()=>this.syncNow(false),700);
    });
    this.registerInterval(window.setInterval(()=>{if(this.isConnected()&&!document.hidden&&Object.keys(this.settings.pending||{}).length)this.syncNow(false);},30000));
  }
  onunload(){ if(this.debounceTimer)window.clearTimeout(this.debounceTimer); }
  isConnected(){ return !!(this.settings.serverUrl&&this.settings.apiUrl&&this.settings.deviceId&&this.settings.token); }
  async persist(){ await this.saveData(this.settings); }
  setStatus(text,kind=''){
    if(!this.statusBar)return;this.statusBar.setText('Vault Sync · '+text);this.statusBar.className='vault-sync-status '+(kind?`vault-sync-${kind}`:'');
  }
  fail(err,prefix='Sync failed'){
    const msg=err&&err.message?err.message:String(err||'Unknown error');this.settings.lastError=msg;this.persist();this.setStatus('Error','error');new Notice(`${prefix}: ${msg}`);
  }
  headers(){ return {'Authorization':'Bearer '+this.settings.token,'Content-Type':'application/json'}; }
  async api(action,payload={}){
    const r=await requestUrl({url:this.settings.apiUrl,method:'POST',headers:this.headers(),body:JSON.stringify(Object.assign({action},payload)),throw:false});
    const j=r.json||{};if(r.status<200||r.status>=300||!j.ok){const e=new Error(j.error||`Server returned HTTP ${r.status}`);e.status=r.status;e.retryAfter=Number(j.retry_after||0);throw e;}return j.data;
  }
  async connectFromUri(params){
    const server=String(params.server||'').replace(/\/+$/,'');const pair=String(params.pair||'');if(!/^https:\/\//i.test(server))throw new Error('The server must use HTTPS.');if(!pair)throw new Error('Pairing code is missing.');
    const apiParam=String(params.api||'').trim();let apiUrl='';if(/^https:\/\//i.test(apiParam))apiUrl=apiParam;else if(apiParam.startsWith('/'))apiUrl=server+apiParam;else throw new Error('The pairing link is missing its API endpoint.');if(!apiUrl.startsWith(server+'/'))throw new Error('The API endpoint must use the paired server.');const deviceName=[navigator.platform||'',this.app.vault.getName()].filter(Boolean).join(' · ').slice(0,120);
    const r=await requestUrl({url:apiUrl,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'pair',pair_token:pair,device_name:deviceName,vault_name:this.app.vault.getName(),plugin_version:VERSION}),throw:false});
    const j=r.json||{};if(r.status<200||r.status>=300||!j.ok)throw new Error(j.error||'Pairing failed.');
    const d=j.data||{};this.settings.serverUrl=server;this.settings.apiUrl=d.api_url||apiUrl;this.settings.deviceId=d.device_id||'';this.settings.token=d.device_token||'';if(params.root)this.settings.vaultRoot=cleanRoot(String(params.root));this.settings.connectedAt=new Date().toISOString();this.settings.lastError='';this.settings.notes={};this.settings.pending={};await this.persist();this.setStatus('Connected','ok');
  }
  async disconnect(){
    this.settings=Object.assign({},DEFAULTS,{vaultRoot:this.settings.vaultRoot||'Synced Notes'});await this.persist();this.setStatus('Not connected');new Notice('Vault Sync Helper disconnected from this vault.');
  }
  notePath(meta){ return joinPath(cleanRoot(this.settings.vaultRoot),String(meta.relative_path||'')); }
  async ensureFolder(path){
    const bits=normalizePath(path).split('/').filter(Boolean);let current='';for(const bit of bits){current=current?current+'/'+bit:bit;const exists=this.app.vault.getAbstractFileByPath(current);if(!exists){try{await this.app.vault.createFolder(current);}catch(e){if(!this.app.vault.getAbstractFileByPath(current))throw e;}}}
  }
  async readText(path){ const f=this.app.vault.getAbstractFileByPath(normalizePath(path));return f instanceof TFile?await this.app.vault.read(f):null; }
  async writeText(path,text){
    path=normalizePath(path);await this.ensureFolder(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'');this.suppressPaths.set(path,Date.now()+3000);const f=this.app.vault.getAbstractFileByPath(path);if(f instanceof TFile){const current=await this.app.vault.read(f);if(current!==text)await this.app.vault.modify(f,text);}else await this.app.vault.create(path,text);
  }
  async writeBinary(path,buffer){
    path=normalizePath(path);await this.ensureFolder(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'');this.suppressPaths.set(path,Date.now()+3000);const f=this.app.vault.getAbstractFileByPath(path);if(f instanceof TFile)await this.app.vault.modifyBinary(f,buffer);else await this.app.vault.createBinary(path,buffer);
  }
  trackedByPath(path){ path=normalizePath(path);for(const [id,s] of Object.entries(this.settings.notes||{}))if(normalizePath(s.path||'')===path)return{id,state:s};return null; }
  markPending(noteId){
    if(!noteId)return;this.settings.pending[noteId]={changedAt:Date.now()};this.persist();this.setStatus(`${Object.keys(this.settings.pending).length} pending`,'warn');if(this.debounceTimer)window.clearTimeout(this.debounceTimer);this.debounceTimer=window.setTimeout(()=>this.syncNow(false),1800);
  }
  onPathActivity(path){
    path=normalizePath(path||'');if(!path||!this.isConnected())return;const until=Number(this.suppressPaths.get(path)||0);if(until>Date.now())return;if(until)this.suppressPaths.delete(path);
    const tracked=this.trackedByPath(path);if(tracked){this.markPending(tracked.id);return;}
    for(const [id,state] of Object.entries(this.settings.notes||{})){const md=normalizePath(state.path||'');const dir=md.includes('/')?md.slice(0,md.lastIndexOf('/')):'';const prefix=joinPath(dir,'attachments')+'/';if(path.startsWith(prefix)){this.markPending(id);return;}}
  }
  onVaultModify(file){ if(!file||!file.path)return;this.onPathActivity(file.path); }
  async attachmentLocalState(noteState){
    const mdPath=normalizePath(noteState.path||'');const noteDir=mdPath.includes('/')?mdPath.slice(0,mdPath.lastIndexOf('/')):'';const prefix=joinPath(noteDir,'attachments')+'/';const rows={};
    for(const f of this.app.vault.getFiles()){if(!f.path.startsWith(prefix))continue;const rel=f.path.slice(prefix.length);if(!rel||rel.includes('/'))continue;const buf=await this.app.vault.readBinary(f);rows[rel]={file:f,buffer:buf,sha256:await sha256ArrayBuffer(buf),size:buf.byteLength};}
    return rows;
  }
  async uploadChangedAttachments(sessionId,noteId,state,remoteAttachments){
    const local=await this.attachmentLocalState(state);const remote={};for(const a of remoteAttachments||[])remote[a.name]=a;let uploaded=0;
    for(const [name,row] of Object.entries(local)){if(remote[name]&&String(remote[name].sha256||'')===row.sha256)continue;const d=await this.api('upload_attachment',{session_id:sessionId,note_id:noteId,name,sha256:row.sha256,data_base64:arrayBufferToBase64(row.buffer)});if(d&&d.changed)uploaded++;}
    return uploaded;
  }
  async downloadAttachments(sessionId,noteMeta,noteState){
    const mdPath=normalizePath(noteState.path);const noteDir=mdPath.includes('/')?mdPath.slice(0,mdPath.lastIndexOf('/')):'';for(const a of noteMeta.attachments||[]){const path=joinPath(noteDir,'attachments',a.name);let need=true;const f=this.app.vault.getAbstractFileByPath(path);if(f instanceof TFile){const known=(noteState.attachments||{})[a.name];if(known&&known===a.sha256)need=false;else{const buf=await this.app.vault.readBinary(f);if(await sha256ArrayBuffer(buf)===a.sha256)need=false;}}if(!need)continue;
      const url=this.settings.apiUrl+'?action=attachment&session_id='+encodeURIComponent(sessionId)+'&note_id='+encodeURIComponent(noteMeta.id)+'&name='+encodeURIComponent(a.name);const r=await requestUrl({url,method:'GET',headers:{'Authorization':'Bearer '+this.settings.token},throw:false});if(r.status<200||r.status>=300)throw new Error(`Could not download ${a.name}.`);await this.writeBinary(path,r.arrayBuffer);
    }
    noteState.attachments={};for(const a of noteMeta.attachments||[])noteState.attachments[a.name]=a.sha256||'';
  }
  async pushLocal(sessionId,noteId,state,remoteMeta=null){
    const local=await this.readText(state.path);if(local===null)return null;const uploaded=await this.uploadChangedAttachments(sessionId,noteId,state,(remoteMeta&&remoteMeta.attachments)||state.remoteAttachments||[]);if(local===String(state.baseMarkdown||'')&&uploaded===0){delete this.settings.pending[noteId];return null;}
    const cid=changeId();const result=await this.api('sync_note',{session_id:sessionId,note_id:noteId,markdown:local,base_revision:Number(state.revision||0),base_markdown:String(state.baseMarkdown||''),change_id:cid});
    const newPath=this.notePath(result);if(newPath!==state.path){await this.writeText(newPath,result.markdown||'');state.path=newPath;}else if(String(result.markdown||'')!==local)await this.writeText(state.path,String(result.markdown||''));
    state.revision=Number(result.revision||state.revision||1);state.baseMarkdown=String(result.markdown||'');state.remoteAttachments=result.attachments||[];await this.downloadAttachments(sessionId,result,state);delete this.settings.pending[noteId];if(result.conflict)new Notice(`A sync conflict was preserved in ${result.title||'Note'}.`);return result;
  }
  async applyServerNote(sessionId,note){
    let state=this.settings.notes[note.id]||{revision:0,baseMarkdown:'',attachments:{}};const desired=this.notePath(note);const oldPath=state.path||desired;state.path=oldPath;
    const local=await this.readText(oldPath);const locallyChanged=local!==null&&String(local)!==String(state.baseMarkdown||'');
    if(locallyChanged){this.settings.pending[note.id]={changedAt:Date.now()};state.remoteAttachments=note.attachments||[];this.settings.notes[note.id]=state;await this.persist();const pushed=await this.pushLocal(sessionId,note.id,state,note);if(pushed)return;}
    if(oldPath!==desired&&local!==null){await this.writeText(desired,String(note.markdown||''));state.path=desired;}else{state.path=desired;await this.writeText(desired,String(note.markdown||''));}
    state.revision=Number(note.revision||1);state.baseMarkdown=String(note.markdown||'');state.remoteAttachments=note.attachments||[];await this.downloadAttachments(sessionId,note,state);this.settings.notes[note.id]=state;delete this.settings.pending[note.id];
  }
  async syncNow(userInitiated=false){
    if(!this.isConnected()){if(userInitiated)new Notice('Connect this vault from the Notes Sync page first.');return;}if(this.syncing)return;this.syncing=true;this.setStatus('Syncing…');let sessionId='';
    try{
      const known={};for(const [id,s] of Object.entries(this.settings.notes||{}))known[id]=Number(s.revision||0);
      let begin;for(let attempt=0;attempt<4;attempt++){try{begin=await this.api('sync_begin',{known_revisions:known,device_name:navigator.platform||'Obsidian',vault_name:this.app.vault.getName(),plugin_version:VERSION});break;}catch(e){if(e.status===409&&attempt<3){this.setStatus('Waiting…','warn');await sleep(Math.max(3,e.retryAfter||5)*1000);continue;}throw e;}}
      if(!begin)throw new Error('Could not start the sync session.');sessionId=begin.session_id;const snapshot=begin.snapshot||{};const manifest={};for(const m of snapshot.manifest||[])manifest[m.id]=m;
      for(const note of snapshot.changed||[])await this.applyServerNote(sessionId,note);
      for(const noteId of Object.keys(this.settings.pending||{})){const state=this.settings.notes[noteId];if(!state)continue;await this.pushLocal(sessionId,noteId,state,manifest[noteId]||null);}
      this.settings.lastSyncAt=new Date().toISOString();this.settings.lastError='';await this.persist();await this.api('sync_end',{session_id:sessionId,status:'success'});sessionId='';this.setStatus('Synced','ok');if(userInitiated)new Notice('Linked notes synced.');
    }catch(e){if(sessionId){try{await this.api('sync_end',{session_id:sessionId,status:'error',error:e&&e.message?e.message:String(e)});}catch(_){}}this.settings.lastError=e&&e.message?e.message:String(e);await this.persist();this.setStatus(navigator.onLine===false?'Offline':'Error',navigator.onLine===false?'warn':'error');if(userInitiated||navigator.onLine!==false)new Notice('Vault Sync: '+this.settings.lastError);
    }finally{this.syncing=false;}
  }
}

class VaultSyncSettingTab extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){const {containerEl}=this;containerEl.empty();containerEl.createEl('h2',{text:'Vault Sync Helper'});const p=this.plugin;
    new Setting(containerEl).setName('Connection').setDesc(p.isConnected()?`Connected to ${p.settings.serverUrl}`:'Not connected. Use your portal’s Notes Sync page to connect this vault.');
    new Setting(containerEl).setName('Vault folder').setDesc('Linked notes are stored under this folder in the current vault.').addText(t=>t.setValue(p.settings.vaultRoot||'Synced Notes').onChange(async v=>{p.settings.vaultRoot=cleanRoot(v);await p.persist();}));
    new Setting(containerEl).setName('Sync now').setDesc(p.settings.lastSyncAt?`Last sync: ${p.settings.lastSyncAt}`:'Sync when Obsidian opens or whenever a tracked Note changes.').addButton(b=>b.setButtonText('Sync Now').setCta().onClick(()=>p.syncNow(true)));
    if(p.isConnected())new Setting(containerEl).setName('Disconnect this vault').setDesc('Removes this vault’s device token. Existing Markdown files stay in the vault.').addButton(b=>b.setButtonText('Disconnect').setWarning().onClick(async()=>{await p.disconnect();this.display();}));
    if(p.settings.lastError)containerEl.createEl('p',{text:'Last error: '+p.settings.lastError,cls:'vault-sync-error'});
  }
}

module.exports = VaultSyncHelperPlugin;
