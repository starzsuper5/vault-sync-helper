const { Plugin, PluginSettingTab, Setting, Notice, TFile, TFolder, ItemView, Modal, Menu, normalizePath, requestUrl, setIcon } = require('obsidian');

const VERSION = '1.1.0';
const HOME_VIEW_TYPE = 'taxbee-notes-home';
const DIRECTORY_VIEW_TYPE = 'taxbee-notes-directory';
const DEFAULTS = { serverUrl:'', apiUrl:'', deviceId:'', token:'', vaultRoot:'TaxBee Notes', pairServerUrl:'', notes:{}, pending:{}, pendingCreates:{}, connectedAt:'', lastSyncAt:'', lastError:'', homeFolder:'', openHomeOnStartup:true };

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
function normalizeServer(value){
  let v=String(value||'').trim();if(!v)return'';if(!/^https?:\/\//i.test(v))v='https://'+v;v=v.replace(/\/+$/,'');
  if(!/^https:\/\//i.test(v))throw new Error('Portal address must use HTTPS.');return v;
}
function normalizePairCode(value){ return String(value||'').toUpperCase().replace(/[^A-Z2-9]/g,''); }

function fileNameFromTitle(value){
  let s=String(value||'').trim().replace(/[\\/:*?"<>|]/g,' ').replace(/\s+/g,' ').replace(/[. ]+$/g,'');
  return s||'New Note';
}
function previewText(markdown){
  let s=String(markdown||'').replace(/^---\s*[\s\S]*?\n---\s*/,' ');
  s=s.replace(/!\[[^\]]*\]\([^)]*\)/g,' ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1');
  s=s.replace(/```[\s\S]*?```/g,' ').replace(/`([^`]+)`/g,'$1').replace(/^\s{0,3}#{1,6}\s+/gm,'');
  s=s.replace(/[*_~>#-]+/g,' ').replace(/\s+/g,' ').trim();
  return s.length>180?s.slice(0,177)+'…':s;
}
function relativeParent(path,root){
  path=normalizePath(path||'');root=normalizePath(root||'');if(!path.startsWith(root+'/'))return'';
  const rel=path.slice(root.length+1);return rel.includes('/')?rel.slice(0,rel.lastIndexOf('/')):'';
}

class TaxBeePromptModal extends Modal {
  constructor(app,{title,placeholder='',confirm='Create',initial='',onSubmit}){super(app);this.promptTitle=title;this.placeholder=placeholder;this.confirm=confirm;this.initial=initial;this.onSubmit=onSubmit;}
  onOpen(){
    const {contentEl}=this;contentEl.empty();contentEl.addClass('taxbee-prompt');contentEl.createEl('h2',{text:this.promptTitle});
    const input=contentEl.createEl('input',{type:'text',placeholder:this.placeholder});input.value=this.initial||'';
    const actions=contentEl.createDiv({cls:'taxbee-prompt-actions'});const cancel=actions.createEl('button',{text:'Cancel'});const ok=actions.createEl('button',{text:this.confirm,cls:'mod-cta'});
    const submit=async()=>{const value=input.value.trim();if(!value)return;ok.disabled=true;try{await this.onSubmit(value);this.close();}catch(e){new Notice(e&&e.message?e.message:String(e));ok.disabled=false;}};
    cancel.addEventListener('click',()=>this.close());ok.addEventListener('click',submit);input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit();}});window.setTimeout(()=>input.focus(),50);
  }
  onClose(){this.contentEl.empty();}
}

class TaxBeeNotesHomeView extends ItemView {
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.query='';this.renderToken=0;}
  getViewType(){return HOME_VIEW_TYPE;}
  getDisplayText(){return 'TaxBee Notes';}
  getIcon(){return 'sticky-note';}
  async onOpen(){await this.refresh();}
  async refresh(){
    const token=++this.renderToken;const el=this.contentEl;el.empty();el.addClass('taxbee-home');
    const toolbar=el.createDiv({cls:'taxbee-home-toolbar'});
    const folderBtn=toolbar.createEl('button',{cls:'taxbee-folder-button','aria-label':'Directory'});setIcon(folderBtn,'folder');folderBtn.addEventListener('click',()=>this.plugin.openDirectory());
    const search=toolbar.createEl('input',{type:'search',placeholder:'Search notes...',cls:'taxbee-search'});search.value=this.query;
    const newBtn=toolbar.createEl('button',{text:'New',cls:'taxbee-new-button'});newBtn.addEventListener('click',()=>this.plugin.promptNewNote());
    const folderLabel=el.createDiv({cls:'taxbee-folder-label',text:this.plugin.currentFolderLabel()});
    const grid=el.createDiv({cls:'taxbee-note-grid'});
    const renderCards=async()=>{
      const files=this.query.trim()?await this.plugin.searchNoteFiles(this.query):this.plugin.noteFiles('');if(token!==this.renderToken)return;grid.empty();
      if(this.query.trim())folderLabel.setText(files.length?`Search results · ${files.length}`:'Search results');else folderLabel.setText(this.plugin.currentFolderLabel());
      if(!files.length){const empty=grid.createDiv({cls:'taxbee-empty'});empty.createEl('div',{text:this.query.trim()?'No matching notes':'No notes in this directory'});if(!this.query.trim())empty.createEl('small',{text:'Tap New to create a note.'});return;}
      const rows=await Promise.all(files.map(async file=>({file,text:await this.app.vault.cachedRead(file)})));if(token!==this.renderToken)return;
      for(const row of rows){
        const card=grid.createDiv({cls:'taxbee-note-card'});card.tabIndex=0;
        const head=card.createDiv({cls:'taxbee-card-head'});head.createEl('div',{cls:'taxbee-card-title',text:row.file.basename});const open=head.createSpan({cls:'taxbee-card-open'});setIcon(open,'external-link');
        card.createDiv({cls:'taxbee-card-preview',text:previewText(row.text)||'Empty note'});
        const go=()=>this.leaf.openFile(row.file);card.addEventListener('click',go);card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}});
      }
    };
    let timer=null;search.addEventListener('input',()=>{this.query=search.value;if(timer)window.clearTimeout(timer);timer=window.setTimeout(renderCards,100);});
    await renderCards();
  }
}

class TaxBeeDirectoryView extends ItemView {
  constructor(leaf,plugin){super(leaf);this.plugin=plugin;this.expanded=new Set();this.initialized=false;}
  getViewType(){return DIRECTORY_VIEW_TYPE;}
  getDisplayText(){return 'Directory';}
  getIcon(){return 'folder-tree';}
  async onOpen(){await this.refresh();}
  folderPaths(){return this.plugin.folderPaths();}
  expandDefaults(){if(this.initialized)return;for(const p of this.folderPaths())this.expanded.add(p);this.initialized=true;}
  async refresh(){
    this.expandDefaults();const el=this.contentEl;el.empty();el.addClass('taxbee-directory');
    const header=el.createDiv({cls:'taxbee-directory-header'});header.createEl('strong',{text:'Directory'});const more=header.createEl('button',{cls:'taxbee-more','aria-label':'Directory menu'});setIcon(more,'ellipsis');
    more.addEventListener('click',evt=>{const menu=new Menu();menu.addItem(i=>i.setTitle('New note').setIcon('square-pen').onClick(()=>this.plugin.promptNewNote()));menu.addItem(i=>i.setTitle('New folder').setIcon('folder-plus').onClick(()=>this.plugin.promptNewFolder()));menu.addSeparator();menu.addItem(i=>i.setTitle('Expand all').onClick(()=>{for(const p of this.folderPaths())this.expanded.add(p);this.refresh();}));menu.addItem(i=>i.setTitle('Collapse all').onClick(()=>{this.expanded.clear();this.refresh();}));menu.showAtMouseEvent(evt);});
    const tree=el.createDiv({cls:'taxbee-directory-tree'});
    this.renderRow(tree,{label:'Default',rel:'',depth:0,folder:null,hasChildren:false});
    const root=this.plugin.rootFolder();if(root instanceof TFolder){for(const child of root.children.filter(x=>x instanceof TFolder&&!this.plugin.isHiddenFolder(x.path)).sort((a,b)=>a.name.localeCompare(b.name)))this.renderFolder(tree,child,0);}
  }
  renderFolder(parent,folder,depth){
    const root=cleanRoot(this.plugin.settings.vaultRoot);const rel=folder.path.slice(root.length+1);const children=folder.children.filter(x=>x instanceof TFolder&&!this.plugin.isHiddenFolder(x.path)).sort((a,b)=>a.name.localeCompare(b.name));
    this.renderRow(parent,{label:folder.name,rel,depth,folder,hasChildren:children.length>0});if(children.length&&this.expanded.has(rel))for(const child of children)this.renderFolder(parent,child,depth+1);
  }
  renderRow(parent,{label,rel,depth,folder,hasChildren}){
    const row=parent.createDiv({cls:'taxbee-directory-row'+(this.plugin.settings.homeFolder===rel?' is-active':'')});row.style.setProperty('--taxbee-depth',String(depth));
    const toggle=row.createEl('button',{cls:'taxbee-tree-toggle','aria-label':hasChildren?'Expand or collapse':''});if(hasChildren){setIcon(toggle,this.expanded.has(rel)?'chevron-down':'chevron-right');toggle.addEventListener('click',e=>{e.stopPropagation();this.expanded.has(rel)?this.expanded.delete(rel):this.expanded.add(rel);this.refresh();});}else toggle.addClass('is-empty');
    const icon=row.createSpan({cls:'taxbee-directory-icon'});setIcon(icon,'folder');const name=row.createSpan({cls:'taxbee-directory-name',text:label});
    const more=row.createEl('button',{cls:'taxbee-row-more','aria-label':'Folder actions'});setIcon(more,'ellipsis');more.addEventListener('click',evt=>{evt.stopPropagation();const menu=new Menu();menu.addItem(i=>i.setTitle('New note').setIcon('square-pen').onClick(()=>this.plugin.promptNewNote(rel)));if(folder)menu.addItem(i=>i.setTitle('New subfolder').setIcon('folder-plus').onClick(()=>this.plugin.promptNewFolder(rel)));menu.showAtMouseEvent(evt);});
    const choose=()=>this.plugin.selectFolder(rel);name.addEventListener('click',choose);icon.addEventListener('click',choose);row.addEventListener('dblclick',choose);
  }
}


class VaultSyncHelperPlugin extends Plugin {
  async onload(){
    this.settings=Object.assign({},DEFAULTS,await this.loadData()||{});this.settings.notes=this.settings.notes||{};this.settings.pending=this.settings.pending||{};this.settings.pendingCreates=this.settings.pendingCreates||{};this.settings.homeFolder=String(this.settings.homeFolder||'');
    this.syncing=false;this.suppressPaths=new Map();this.debounceTimer=null;this.uiTimer=null;this.statusBar=this.addStatusBarItem();this.setStatus(this.isConnected()?'Ready':'Not connected');
    this.registerView(HOME_VIEW_TYPE,leaf=>new TaxBeeNotesHomeView(leaf,this));this.registerView(DIRECTORY_VIEW_TYPE,leaf=>new TaxBeeDirectoryView(leaf,this));
    this.addSettingTab(new VaultSyncSettingTab(this.app,this));
    this.addRibbonIcon('home','TaxBee Notes',()=>this.activateHome(true));
    this.addRibbonIcon('refresh-cw','Sync linked notes',()=>this.syncNow(true));
    this.addCommand({id:'open-taxbee-notes-home',name:'Open TaxBee Notes home',callback:()=>this.activateHome(true)});
    this.addCommand({id:'sync-now',name:'Sync linked notes now',callback:()=>this.syncNow(true)});
    this.registerObsidianProtocolHandler('vault-sync-helper',async params=>{
      try{await this.connectFromUri(params||{});new Notice('Connection complete. Syncing notes…');await this.syncNow(true);}catch(e){this.fail(e,'Connection failed');}
    });
    this.app.workspace.onLayoutReady(async()=>{
      this.registerEvent(this.app.vault.on('modify',file=>this.onVaultModify(file)));
      this.registerEvent(this.app.vault.on('create',file=>this.onVaultCreate(file)));
      this.registerEvent(this.app.vault.on('delete',file=>this.onVaultDelete(file)));
      this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>this.onVaultRename(file,oldPath)));
      try{await this.ensureFolder(cleanRoot(this.settings.vaultRoot));}catch(_){}
      try{await this.ensureDirectoryView();}catch(_){}
      if(this.settings.openHomeOnStartup!==false)window.setTimeout(()=>this.activateHome(false),120);
      if(this.isConnected())window.setTimeout(async()=>{try{await this.heartbeat();}catch(_){}await this.syncNow(false);},700);
    });
    this.registerInterval(window.setInterval(()=>{if(this.isConnected()&&!document.hidden&&(Object.keys(this.settings.pending||{}).length||Object.keys(this.settings.pendingCreates||{}).length))this.syncNow(false);},30000));
    this.registerInterval(window.setInterval(()=>{if(this.isConnected()&&!document.hidden)this.heartbeat().catch(()=>{});},60000));
  }
  onunload(){ if(this.debounceTimer)window.clearTimeout(this.debounceTimer);if(this.uiTimer)window.clearTimeout(this.uiTimer);this.app.workspace.detachLeavesOfType(HOME_VIEW_TYPE);this.app.workspace.detachLeavesOfType(DIRECTORY_VIEW_TYPE); }
  isConnected(){ return !!(this.settings.serverUrl&&this.settings.apiUrl&&this.settings.deviceId&&this.settings.token); }
  rootFolder(){const f=this.app.vault.getAbstractFileByPath(cleanRoot(this.settings.vaultRoot));return f instanceof TFolder?f:null;}
  isHiddenFolder(path){const root=cleanRoot(this.settings.vaultRoot);const rel=normalizePath(path||'').startsWith(root+'/')?normalizePath(path).slice(root.length+1):'';return rel.split('/').some(x=>x.toLowerCase()==='attachments');}
  folderPaths(){const root=cleanRoot(this.settings.vaultRoot),out=[];for(const f of this.app.vault.getAllLoadedFiles()){if(!(f instanceof TFolder)||f.path===root||!f.path.startsWith(root+'/')||this.isHiddenFolder(f.path))continue;out.push(f.path.slice(root.length+1));}return out.sort((a,b)=>a.localeCompare(b));}
  currentFolderLabel(){const rel=String(this.settings.homeFolder||'');return rel?rel.split('/').pop():'Default';}
  noteFiles(query=''){
    const root=cleanRoot(this.settings.vaultRoot),q=String(query||'').trim().toLowerCase(),selected=String(this.settings.homeFolder||'');
    const files=this.app.vault.getMarkdownFiles().filter(f=>{const p=normalizePath(f.path);if(!p.startsWith(root+'/')||p.toLowerCase().includes('/attachments/'))return false;if(q)return true;return relativeParent(p,root)===selected;});
    const filtered=q?files.filter(f=>{const title=f.basename.toLowerCase();const cache=this.app.metadataCache.getFileCache(f);let searchable=title+' '+f.path.toLowerCase();if(cache&&cache.headings)searchable+=' '+cache.headings.map(h=>h.heading).join(' ').toLowerCase();return searchable.includes(q);}):files;
    return filtered.sort((a,b)=>Number(b.stat?.mtime||0)-Number(a.stat?.mtime||0)||a.basename.localeCompare(b.basename));
  }
  async searchNoteFiles(query){
    const q=String(query||'').trim().toLowerCase();if(!q)return this.noteFiles('');const root=cleanRoot(this.settings.vaultRoot),all=this.app.vault.getMarkdownFiles().filter(f=>f.path.startsWith(root+'/')&&!f.path.toLowerCase().includes('/attachments/'));const out=[];
    for(const f of all){if(f.basename.toLowerCase().includes(q)||f.path.toLowerCase().includes(q)){out.push(f);continue;}try{const body=(await this.app.vault.cachedRead(f)).toLowerCase();if(body.includes(q))out.push(f);}catch(_){}}
    return out.sort((a,b)=>Number(b.stat?.mtime||0)-Number(a.stat?.mtime||0));
  }
  scheduleUiRefresh(){if(this.uiTimer)window.clearTimeout(this.uiTimer);this.uiTimer=window.setTimeout(()=>this.refreshUi(),120);}
  refreshUi(){for(const leaf of this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)){if(leaf.view instanceof TaxBeeNotesHomeView)leaf.view.refresh();}for(const leaf of this.app.workspace.getLeavesOfType(DIRECTORY_VIEW_TYPE)){if(leaf.view instanceof TaxBeeDirectoryView)leaf.view.refresh();}}
  async ensureDirectoryView(){let leaves=this.app.workspace.getLeavesOfType(DIRECTORY_VIEW_TYPE);if(leaves.length)return leaves[0];const leaf=this.app.workspace.getLeftLeaf(false);if(!leaf)return null;await leaf.setViewState({type:DIRECTORY_VIEW_TYPE,active:true});return leaf;}
  async openDirectory(){try{await this.ensureDirectoryView();}catch(_){}try{this.app.commands.executeCommandById('workspace:toggle-left-sidebar');}catch(_){}}
  mainLeaf(){const active=this.app.workspace.activeLeaf;if(active&&!(active.view instanceof TaxBeeDirectoryView))return active;const home=this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)[0];return home||this.app.workspace.getLeaf(true);}
  async activateHome(reveal=true){let leaf=this.app.workspace.getLeavesOfType(HOME_VIEW_TYPE)[0];if(!leaf){leaf=this.mainLeaf();await leaf.setViewState({type:HOME_VIEW_TYPE,active:true});}await this.app.workspace.revealLeaf(leaf);if(leaf.view instanceof TaxBeeNotesHomeView)await leaf.view.refresh();return leaf;}
  async selectFolder(rel){this.settings.homeFolder=String(rel||'');await this.persist();await this.activateHome(true);this.refreshUi();try{this.app.commands.executeCommandById('workspace:toggle-left-sidebar');}catch(_){}}
  promptNewNote(folderRel=null){const rel=folderRel===null?String(this.settings.homeFolder||''):String(folderRel||'');new TaxBeePromptModal(this.app,{title:'New note',placeholder:'Note title',confirm:'Create',onSubmit:title=>this.createNote(rel,title)}).open();}
  promptNewFolder(parentRel=null){const rel=parentRel===null?String(this.settings.homeFolder||''):String(parentRel||'');new TaxBeePromptModal(this.app,{title:'New folder',placeholder:'Folder name',confirm:'Create',onSubmit:name=>this.createFolder(rel,name)}).open();}
  async createFolder(parentRel,name){const root=cleanRoot(this.settings.vaultRoot),safe=fileNameFromTitle(name),rel=parentRel?joinPath(parentRel,safe):safe,path=joinPath(root,rel);await this.ensureFolder(path);this.settings.homeFolder=rel;await this.persist();this.refreshUi();return path;}
  async createNote(folderRel,title){
    const root=cleanRoot(this.settings.vaultRoot),safe=fileNameFromTitle(title),dir=folderRel?joinPath(root,folderRel):root;await this.ensureFolder(dir);let path=joinPath(dir,safe+'.md'),n=2;while(this.app.vault.getAbstractFileByPath(path)){path=joinPath(dir,`${safe} (${n++}).md`);}const file=await this.app.vault.create(path,'');this.scheduleUiRefresh();const leaf=this.mainLeaf();await leaf.openFile(file);return file;
  }
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
  async heartbeat(){ if(!this.isConnected())return null;return this.api('heartbeat',{device_name:navigator.platform||'Obsidian',vault_name:this.app.vault.getName(),plugin_version:VERSION}); }
  async pairDevice(server,apiUrl,pair,root=''){
    server=normalizeServer(server);pair=normalizePairCode(pair);if(!pair)throw new Error('Pairing code is missing.');if(!apiUrl)apiUrl=server+'/vault-sync.php';if(!/^https:\/\//i.test(apiUrl)||!apiUrl.startsWith(server+'/'))throw new Error('The sync endpoint must use the paired portal.');const deviceName=[navigator.platform||'',this.app.vault.getName()].filter(Boolean).join(' · ').slice(0,120);
    const r=await requestUrl({url:apiUrl,method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'pair',pair_token:pair,device_name:deviceName,vault_name:this.app.vault.getName(),plugin_version:VERSION}),throw:false});
    const j=r.json||{};if(r.status<200||r.status>=300||!j.ok)throw new Error(j.error||'Pairing failed.');
    const d=j.data||{};this.settings.serverUrl=server;this.settings.apiUrl=d.api_url||apiUrl;this.settings.deviceId=d.device_id||'';this.settings.token=d.device_token||'';this.settings.pairServerUrl=server;if(root)this.settings.vaultRoot=cleanRoot(String(root));this.settings.connectedAt=new Date().toISOString();this.settings.lastError='';this.settings.notes={};this.settings.pending={};this.settings.pendingCreates={};await this.persist();this.setStatus('Connected','ok');try{await this.heartbeat();}catch(_){}
  }
  async connectWithCode(server,pair){
    server=normalizeServer(server);await this.pairDevice(server,server+'/vault-sync.php',pair,'');
  }
  async connectFromUri(params){
    const server=normalizeServer(String(params.server||''));const pair=String(params.pair||'');const apiParam=String(params.api||'').trim();let apiUrl='';if(/^https:\/\//i.test(apiParam))apiUrl=apiParam;else if(apiParam.startsWith('/'))apiUrl=server+apiParam;else apiUrl=server+'/vault-sync.php';await this.pairDevice(server,apiUrl,pair,String(params.root||''));
  }
  async disconnect(){
    const pairServerUrl=this.settings.serverUrl||this.settings.pairServerUrl||'';
    this.settings=Object.assign({},DEFAULTS,{vaultRoot:this.settings.vaultRoot||'Synced Notes',pairServerUrl});await this.persist();this.setStatus('Not connected');new Notice('Vault Sync Helper disconnected from this vault.');
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
  isSuppressed(path){path=normalizePath(path||'');const until=Number(this.suppressPaths.get(path)||0);if(until>Date.now())return true;if(until)this.suppressPaths.delete(path);return false;}
  newNoteFolderPath(path){
    path=normalizePath(path||'');if(!path||!path.toLowerCase().endsWith('.md'))return null;const root=cleanRoot(this.settings.vaultRoot);
    if(!path.startsWith(root+'/'))return null;
    const rel=path.slice(root.length+1),relLower=rel.toLowerCase();if(!rel||relLower.startsWith('attachments/')||relLower.includes('/attachments/'))return null;let parent=rel.includes('/')?rel.slice(0,rel.lastIndexOf('/')):'';
    if(parent){const fullParent=joinPath(root,parent);for(const st of Object.values(this.settings.notes||{})){const md=normalizePath(st.path||'');const dir=md.includes('/')?md.slice(0,md.lastIndexOf('/')):'';if(dir===fullParent){parent=parent.includes('/')?parent.slice(0,parent.lastIndexOf('/')):'';break;}}}
    return parent;
  }
  queueNewNote(path){
    path=normalizePath(path||'');if(!this.isConnected()||this.trackedByPath(path)||this.isSuppressed(path))return;const folderPath=this.newNoteFolderPath(path);if(folderPath===null)return;const existing=this.settings.pendingCreates[path]||{};this.settings.pendingCreates[path]={changedAt:Date.now(),changeId:existing.changeId||changeId(),folderPath};this.persist();this.setStatus(`${Object.keys(this.settings.pending||{}).length+Object.keys(this.settings.pendingCreates||{}).length} pending`,'warn');if(this.debounceTimer)window.clearTimeout(this.debounceTimer);this.debounceTimer=window.setTimeout(()=>this.syncNow(false),1800);
  }
  async discoverNewNotes(){
    if(!this.isConnected())return 0;const cutoff=Date.parse(this.settings.connectedAt||'')||0;let added=0;for(const f of this.app.vault.getMarkdownFiles()){const path=normalizePath(f.path);if(this.trackedByPath(path)||this.settings.pendingCreates[path]||this.isSuppressed(path))continue;const folderPath=this.newNoteFolderPath(path);if(folderPath===null)continue;if(cutoff&&Number(f.stat?.mtime||0)+1000<cutoff)continue;this.settings.pendingCreates[path]={changedAt:Date.now(),changeId:changeId(),folderPath};added++;}if(added){await this.persist();this.setStatus(`${Object.keys(this.settings.pending||{}).length+Object.keys(this.settings.pendingCreates||{}).length} pending`,'warn');}return added;
  }
  onVaultCreate(file){if(!file||!file.path)return;if(file instanceof TFile&&file.extension==='md')this.queueNewNote(file.path);else this.onPathActivity(file.path);this.scheduleUiRefresh();}
  onVaultDelete(file){if(!file||!file.path)return;const path=normalizePath(file.path);if(this.settings.pendingCreates[path]){delete this.settings.pendingCreates[path];this.persist();this.scheduleUiRefresh();return;}this.onPathActivity(path);this.scheduleUiRefresh();}
  onVaultRename(file,oldPath){const oldNorm=normalizePath(oldPath||'');if(oldNorm&&this.settings.pendingCreates[oldNorm]){const item=this.settings.pendingCreates[oldNorm];delete this.settings.pendingCreates[oldNorm];const newPath=normalizePath(file?.path||'');const folderPath=this.newNoteFolderPath(newPath);if(newPath&&folderPath!==null)this.settings.pendingCreates[newPath]=Object.assign({},item,{changedAt:Date.now(),folderPath});this.persist();return;}if(file&&file.path){const tracked=this.trackedByPath(oldNorm);if(tracked){const newPath=normalizePath(file.path);if(this.newNoteFolderPath(newPath)===null){window.setTimeout(()=>this.syncNow(false),300);return;}tracked.state.path=newPath;this.settings.notes[tracked.id]=tracked.state;this.markPending(tracked.id);return;}this.queueNewNote(file.path);}if(oldNorm)this.onPathActivity(oldNorm);this.scheduleUiRefresh();}
  markPending(noteId){
    if(!noteId)return;this.settings.pending[noteId]={changedAt:Date.now()};this.persist();this.setStatus(`${Object.keys(this.settings.pending).length} pending`,'warn');if(this.debounceTimer)window.clearTimeout(this.debounceTimer);this.debounceTimer=window.setTimeout(()=>this.syncNow(false),1800);
  }
  onPathActivity(path){
    path=normalizePath(path||'');if(!path||!this.isConnected())return;if(this.isSuppressed(path))return;
    const tracked=this.trackedByPath(path);if(tracked){this.markPending(tracked.id);return;}
    for(const [id,state] of Object.entries(this.settings.notes||{})){const md=normalizePath(state.path||'');const dir=md.includes('/')?md.slice(0,md.lastIndexOf('/')):'';const prefix=joinPath(dir,'attachments')+'/';if(path.startsWith(prefix)){this.markPending(id);return;}}
  }
  onVaultModify(file){ if(!file||!file.path)return;this.onPathActivity(file.path);this.scheduleUiRefresh(); }
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
  async createLocalNote(sessionId,path,item){
    path=normalizePath(path);const f=this.app.vault.getAbstractFileByPath(path);if(!(f instanceof TFile)){delete this.settings.pendingCreates[path];return null;}const mappedFolder=this.newNoteFolderPath(path);if(mappedFolder===null){delete this.settings.pendingCreates[path];await this.persist();return null;}const markdown=await this.app.vault.read(f);let title=f.basename.trim();if(!title)throw new Error('A new linked Note needs a title.');const folderPath=item&&typeof item.folderPath==='string'?item.folderPath:mappedFolder;const cid=(item&&item.changeId)||changeId();const result=await this.api('create_note',{session_id:sessionId,title,folder_path:folderPath,markdown,change_id:cid});
    const desired=this.notePath(result);await this.writeText(desired,String(result.markdown||markdown));const state={path:desired,revision:Number(result.revision||1),baseMarkdown:String(result.markdown||markdown),attachments:{},remoteAttachments:result.attachments||[]};this.settings.notes[result.id]=state;delete this.settings.pendingCreates[path];if(desired!==path){this.suppressPaths.set(path,Date.now()+3000);try{const old=this.app.vault.getAbstractFileByPath(path);if(old instanceof TFile)await this.app.vault.delete(old);}catch(_){}}await this.downloadAttachments(sessionId,result,state);await this.persist();new Notice(`Linked Note created: ${result.title||title}`);return result;
  }
  async pushLocal(sessionId,noteId,state,remoteMeta=null){
    if(this.newNoteFolderPath(state.path)===null){delete this.settings.pending[noteId];return null;}const local=await this.readText(state.path);if(local===null)return null;const uploaded=await this.uploadChangedAttachments(sessionId,noteId,state,(remoteMeta&&remoteMeta.attachments)||state.remoteAttachments||[]);if(local===String(state.baseMarkdown||'')&&uploaded===0){delete this.settings.pending[noteId];return null;}
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
      await this.discoverNewNotes();
      const known={};for(const [id,s] of Object.entries(this.settings.notes||{}))known[id]=this.newNoteFolderPath(s.path)===null?0:Number(s.revision||0);
      let begin;for(let attempt=0;attempt<4;attempt++){try{begin=await this.api('sync_begin',{known_revisions:known,device_name:navigator.platform||'Obsidian',vault_name:this.app.vault.getName(),plugin_version:VERSION});break;}catch(e){if(e.status===409&&attempt<3){this.setStatus('Waiting…','warn');await sleep(Math.max(3,e.retryAfter||5)*1000);continue;}throw e;}}
      if(!begin)throw new Error('Could not start the sync session.');sessionId=begin.session_id;const snapshot=begin.snapshot||{};const manifest={};for(const m of snapshot.manifest||[])manifest[m.id]=m;
      for(const note of snapshot.changed||[])await this.applyServerNote(sessionId,note);
      for(const path of Object.keys(this.settings.pendingCreates||{})){const item=this.settings.pendingCreates[path];await this.createLocalNote(sessionId,path,item);}
      for(const noteId of Object.keys(this.settings.pending||{})){const state=this.settings.notes[noteId];if(!state)continue;await this.pushLocal(sessionId,noteId,state,manifest[noteId]||null);}
      this.settings.lastSyncAt=new Date().toISOString();this.settings.lastError='';await this.persist();const pendingCount=Object.keys(this.settings.pending||{}).length+Object.keys(this.settings.pendingCreates||{}).length;await this.api('sync_end',{session_id:sessionId,status:'success',notes_count:Object.keys(this.settings.notes||{}).length,pending_count:pendingCount});sessionId='';this.setStatus('Synced','ok');this.scheduleUiRefresh();if(userInitiated)new Notice('Linked notes synced.');
    }catch(e){if(sessionId){try{const pendingCount=Object.keys(this.settings.pending||{}).length+Object.keys(this.settings.pendingCreates||{}).length;await this.api('sync_end',{session_id:sessionId,status:'error',error:e&&e.message?e.message:String(e),notes_count:Object.keys(this.settings.notes||{}).length,pending_count:pendingCount});}catch(_){}}this.settings.lastError=e&&e.message?e.message:String(e);await this.persist();this.setStatus(navigator.onLine===false?'Offline':'Error',navigator.onLine===false?'warn':'error');if(userInitiated||navigator.onLine!==false)new Notice('Vault Sync: '+this.settings.lastError);
    }finally{this.syncing=false;}
  }
}

class VaultSyncSettingTab extends PluginSettingTab {
  constructor(app,plugin){super(app,plugin);this.plugin=plugin;}
  display(){const {containerEl}=this;containerEl.empty();containerEl.createEl('h2',{text:'Vault Sync Helper'});const p=this.plugin;
    new Setting(containerEl).setName('Connection').setDesc(p.isConnected()?`Connected to ${p.settings.serverUrl}`:'Not connected. Create a pairing code on your portal’s Notes Sync page, then enter it below.');
    if(!p.isConnected()){
      let serverValue=p.settings.pairServerUrl||'',pairValue='';
      new Setting(containerEl).setName('Portal address').setDesc('Enter the HTTPS address shown next to the pairing code.').addText(t=>t.setPlaceholder('https://example.com').setValue(serverValue).onChange(async v=>{serverValue=v.trim();p.settings.pairServerUrl=serverValue;await p.persist();}));
      new Setting(containerEl).setName('Pairing code').setDesc('One-time code. It expires after 10 minutes and can only be used once.').addText(t=>t.setPlaceholder('ABCD-EFGH-JK').onChange(v=>{pairValue=v;})).addButton(b=>b.setButtonText('Connect').setCta().onClick(async()=>{b.setDisabled(true);try{await p.connectWithCode(serverValue,pairValue);new Notice('Connection complete. Syncing notes…');await p.syncNow(true);this.display();}catch(e){p.fail(e,'Connection failed');}finally{b.setDisabled(false);}}));
    }
    new Setting(containerEl).setName('Vault folder').setDesc('Linked notes are stored under this folder. Only new Markdown notes created inside this folder are added to the paired service automatically. Notes anywhere else in the vault stay local.').addText(t=>t.setValue(p.settings.vaultRoot||'TaxBee Notes').onChange(async v=>{p.settings.vaultRoot=cleanRoot(v);await p.ensureFolder(p.settings.vaultRoot);await p.persist();p.scheduleUiRefresh();}));
    new Setting(containerEl).setName('Open TaxBee Notes on startup').setDesc('Open the simple card home when this vault starts.').addToggle(t=>t.setValue(p.settings.openHomeOnStartup!==false).onChange(async v=>{p.settings.openHomeOnStartup=!!v;await p.persist();}));
    new Setting(containerEl).setName('Sync now').setDesc(p.settings.lastSyncAt?`Last sync: ${p.settings.lastSyncAt}`:'Sync when Obsidian opens or whenever a tracked Note changes.').addButton(b=>b.setButtonText('Sync Now').setCta().onClick(()=>p.syncNow(true)));
    if(p.isConnected())new Setting(containerEl).setName('Disconnect this vault').setDesc('Removes this vault’s device token. Existing Markdown files stay in the vault.').addButton(b=>b.setButtonText('Disconnect').setWarning().onClick(async()=>{await p.disconnect();this.display();}));
    if(p.settings.lastError)containerEl.createEl('p',{text:'Last error: '+p.settings.lastError,cls:'vault-sync-error'});
  }
}

module.exports = VaultSyncHelperPlugin;
