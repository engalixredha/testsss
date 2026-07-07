const App = {

  // ---- Core state ----
  model: new CircuitModel(),
  selection: new SelectionManager(),
  history: null,
  renderer: null,
  clipboard: null,
  views: new Map(), // componentId -> DOM node

  // ---- Interaction state ----
  mode: 'idle', // idle | panning | dragging-components | box-select | wiring | dragging-new
  dragStart: null,
  dragOrigins: null,
  activeWireDrag: null, // {fromComp, fromPin, from:{x,y}, to:{x,y}}
  boxSelectStart: null,
  spaceHeld: false,
  pendingNewComponentType: null,
  // Click-to-wire: set when user clicks a pin without dragging, then waits for a second pin click
  pendingWirePin: null, // {compId, pinId, side} | null
  // Multi-click wire drawing state
  activeWireDraw: null, // {fromComp, fromPin, fromSide, waypoints:[{x,y}...]} | null
  _hoverWireSeg: null,  // {wireId, segmentIndex} | null — segment currently highlighted under the cursor

  // =====================================================================
  // BOOTSTRAP
  // =====================================================================
  init(){
    this.el = {
      viewport: document.getElementById('canvas-viewport'),
      grid: document.getElementById('grid-canvas'),
      wireCanvas: document.getElementById('wire-canvas'),
      overlay: document.getElementById('overlay-canvas'),
      world: document.getElementById('world'),
      compLayer: document.getElementById('component-layer'),
      selectionBox: document.getElementById('selection-box'),
      propsContent: document.getElementById('properties-content'),
      propsModal: document.getElementById('props-modal'),
      ctxMenu: document.getElementById('context-menu'),
      ttPanel: document.getElementById('tt-panel'),
      ttSetupOverlay: document.getElementById('tt-setup-overlay'),
      ttRenameOverlay: document.getElementById('tt-rename-overlay'),
      kmPanel: document.getElementById('km-panel'),
      kmSetupOverlay: document.getElementById('km-setup-overlay'),
    };
    this.renderer = new CanvasRenderer(this.el.viewport, this.el.grid, this.el.wireCanvas, this.el.overlay, this.el.world);
    this.history = new HistoryManager(()=>this._serializeSnapshot(), (snap)=>this._restoreSnapshot(snap));
    // Every undo checkpoint (component add/move/delete, wire add/delete,
    // property edits, ...) is a "real" change worth persisting right away
    // rather than waiting up to 4s for the periodic autosave loop.
    const _origCommit = this.history.commit.bind(this.history);
    this.history.commit = (...args)=>{ _origCommit(...args); this._autosaveSoon(); };

    // Bind truth-table / K-map tooling first so their panel templates,
    // arrays, and containers exist before _loadInitialState() potentially
    // restores saved tables/K-maps from autosave.
    this._bindTruthTableMaker();
    this._bindKMapTool();
    this._bindCircuitToBoolExprTool();
    this._bindSimplifyCircuitTool();
    this._bindSimplifyExprTool();
    this._bindSopPosTool();
    this._bindKMapToCircuitTool();
    this._bindKMapTruthTableTool();
    this._bindTruthTableToCircuitTool();
    this._loadInitialState();
    this._bindDesignTabsBar();
    this._dtRenderTabs();
    // First resize after state is restored — viewport is fully laid out by now
    // (DOMContentLoaded fires after layout), so getBoundingClientRect() is correct.
    this.renderer.resize();
    // Keep the canvas glued to its container's *actual* rendered size at all
    // times — not just on window resize. The design-tabs bar, elements bar,
    // and kits bar all change #canvas-viewport's height by toggling a CSS
    // class (grid-template-rows), which is a layout change the old
    // window-'resize'-only listener never saw, so the <canvas> elements kept
    // their stale pixel dimensions and the container's plain background
    // showed through the gap until a full page refresh re-ran resize().
    // ResizeObserver watches the element itself, so it fires for every one
    // of those cases (and any future one) with no extra wiring per-toggle.
    if(window.ResizeObserver){
      this._viewportResizeObserver = new ResizeObserver(()=>{
        this.renderer.resize();
        this.renderer.drawWires(this.model, (c,p,s)=>this._pinScreenPos(c,p,s), this.activeWireDrag);
      });
      this._viewportResizeObserver.observe(this.el.viewport);
    }
    // Truth-table / K-map panels are restored only now, after resize — they
    // measure the viewport and freeze their own natural width, so doing
    // this any earlier (before layout settles) could freeze a panel at the
    // wrong size and leave it effectively invisible.
    if(this._pendingInitialPanelData){
      this._restorePanelsFromData(this._pendingInitialPanelData);
      this._pendingInitialPanelData = null;
    }
    this._bindToolbox();
    this._bindTopBar();
    this._bindCanvasEvents();
    this._bindKeyboard();
    this._bindWindow();

    this.history.commit(); // baseline snapshot so first undo has somewhere to go
    this.runSimulation();
    this._refreshAll(); // draw wires immediately on load — without this, wires
                         // stayed blank until the first click marked the canvas dirty
    this._startAutosaveLoop();
    this._tick();
  },

  _viewState(){ return { pan:this.renderer.pan, zoom:this.renderer.zoom, gridSize:this.renderer.gridSize, wireWidth:this.renderer.wireWidth }; },

  /** Truth-table and K-map panels are permanent parts of the design now
   *  (not throwaway floating windows), so every snapshot — undo/redo,
   *  autosave, and saved .arlc files alike — carries them along with the
   *  circuit instead of letting them vanish on reload. */
  _serializeSnapshot(){
    const snap = this.model.serialize(this._viewState());
    snap.truthTables = (this._ttPanels||[]).map(t=>({
      io: t.io, names: t.names, tableName: t.tableName, worldAnchor: t.worldAnchor
    }));
    snap.kmaps = (this._kmPanels||[]).map(p=>({
      io: p.io, outIdx: p.outIdx, worldAnchor: p.worldAnchor
    }));
    return snap;
  },

  _loadInitialState(){
    const auto = PersistenceManager.loadAutosave();
    if(auto && Array.isArray(auto.tabs) && auto.tabs.length){
      // New multi-design autosave format: an array of tabs, each holding its
      // own full snapshot (components/wires/view/panels), plus which one
      // was active when the page was last closed.
      this._dtTabs = auto.tabs.map(t=>({
        id: t.id || Utils.uid('tab'),
        name: t.name || 'Design',
        filename: t.filename || null,
        snapshot: (t.snapshot && t.snapshot.components) ? t.snapshot : this._dtMakeBlankSnapshot(),
        undoStack: [], redoStack: []
      }));
      this._dtCounter = typeof auto.counter === 'number' ? auto.counter : (this._dtTabs.length + 1);
      const activeTab = this._dtTabs.find(t=> t.id === auto.activeId) || this._dtTabs[0];
      this._dtActiveId = activeTab.id;
      this._applySnapshotData(activeTab.snapshot);
      this._pendingInitialPanelData = activeTab.snapshot;
      this._currentFilename = activeTab.filename || null;
    } else if(auto && auto.components){
      // Legacy single-design autosave from before multi-design tabs existed
      // — migrate it into a single "Design 1" tab rather than discarding it.
      this._applySnapshotData(auto);
      this._pendingInitialPanelData = auto;
      const id = Utils.uid('tab');
      this._dtTabs = [{ id, name:'Design 1', filename:null, snapshot: auto, undoStack:[], redoStack:[] }];
      this._dtActiveId = id;
      this._dtCounter = 2;
    } else {
      // Nothing saved yet — start fresh with one blank tab.
      const id = Utils.uid('tab');
      this._dtTabs = [{ id, name:'Design 1', filename:null, snapshot: this._dtMakeBlankSnapshot(), undoStack:[], redoStack:[] }];
      this._dtActiveId = id;
      this._dtCounter = 2;
    }
  },

  // =====================================================================
  // DESIGN TABS  (multiple open designs, switchable via tabs above the
  // status bar — same idea as sheet tabs in a spreadsheet app). Each tab
  // holds a full snapshot in the same shape _serializeSnapshot() produces
  // (components, wires, view, truth tables, K-maps). Switching tabs is
  // just capture-current → _restoreSnapshot(other), reusing all the
  // existing snapshot machinery. Undo/redo history is kept per tab in
  // memory only (not persisted to autosave, to keep it lightweight).
  // =====================================================================
  _dtMakeBlankSnapshot(){ return { components:[], wires:[], truthTables:[], kmaps:[] }; },

  /** Writes the live canvas state back into the currently-active tab's
   *  slot in _dtTabs — call before switching away from it or before
   *  autosaving, so the in-memory tab array never goes stale. */
  _dtCaptureActiveTab(){
    const tab = this._dtTabs.find(t=> t.id === this._dtActiveId);
    if(!tab) return;
    tab.snapshot = this._serializeSnapshot();
    tab.undoStack = this.history.undoStack;
    tab.redoStack = this.history.redoStack;
    tab.filename = this._currentFilename || null;
  },

  _dtSwitchTo(id){
    if(id === this._dtActiveId) return;
    this._dtCaptureActiveTab();
    const tab = this._dtTabs.find(t=> t.id === id);
    if(!tab) return;
    this._dtActiveId = id;
    this.history.undoStack = tab.undoStack || [];
    this.history.redoStack = tab.redoStack || [];
    this._currentFilename = tab.filename || null;
    this._restoreSnapshot(tab.snapshot || this._dtMakeBlankSnapshot());
    if(this.history.undoStack.length === 0) this.history.commit();
    this._dtRenderTabs();
    this._dtAutosaveAll();
  },

  _dtAddTab(){
    const id = Utils.uid('tab');
    const tab = { id, name: `Design ${this._dtCounter++}`, filename:null, snapshot: this._dtMakeBlankSnapshot(), undoStack:[], redoStack:[] };
    this._dtTabs.push(tab);
    this._dtSwitchTo(id);
    if(this._dtRevealBriefly) this._dtRevealBriefly(3000);
  },

  _dtCloseTab(id){
    if(this._dtTabs.length <= 1) return; // always keep at least one design open
    const idx = this._dtTabs.findIndex(t=> t.id === id);
    if(idx === -1) return;
    const wasActive = id === this._dtActiveId;
    this._dtTabs.splice(idx, 1);
    if(wasActive){
      // Land on the neighboring tab — prefer the one to the left, like
      // most browsers/editors do when you close the active tab.
      const next = this._dtTabs[idx - 1] || this._dtTabs[0];
      this._dtActiveId = next.id;
      this.history.undoStack = next.undoStack || [];
      this.history.redoStack = next.redoStack || [];
      this._currentFilename = next.filename || null;
      this._restoreSnapshot(next.snapshot || this._dtMakeBlankSnapshot());
      if(this.history.undoStack.length === 0) this.history.commit();
    }
    this._dtRenderTabs();
    this._dtAutosaveAll();
  },

  _dtRenameTab(id, name){
    const tab = this._dtTabs.find(t=> t.id === id);
    if(!tab) return;
    tab.name = (name || '').trim().slice(0, 40) || tab.name;
    this._dtRenderTabs();
    this._dtAutosaveAll();
  },

  /** Clones the given design (or the active one) into a brand-new tab,
   *  deep-copying its snapshot so the two designs are fully independent
   *  from that point on — editing one never touches the other. Inserted
   *  immediately to the right of the source tab and switched to. */
  _dtDuplicateTab(id){
    const srcId = id || this._dtActiveId;
    if(srcId === this._dtActiveId) this._dtCaptureActiveTab();
    const src = this._dtTabs.find(t=> t.id === srcId);
    if(!src) return;
    const newId = Utils.uid('tab');
    const clone = {
      id: newId,
      name: `${src.name} copy`.slice(0, 40),
      filename: null, // a duplicate is a new, unsaved design — not tied to the source's file
      snapshot: JSON.parse(JSON.stringify(src.snapshot || this._dtMakeBlankSnapshot())),
      undoStack: [], redoStack: []
    };
    const srcIdx = this._dtTabs.findIndex(t=> t.id === srcId);
    this._dtTabs.splice(srcIdx + 1, 0, clone);
    this._dtSwitchTo(newId);
    if(this._dtRevealBriefly) this._dtRevealBriefly(3000);
  },

  /** Closes every tab except the one given, always leaving at least that
   *  one open. Used by the context menu's "Close Others" action. */
  _dtCloseOthers(keepId){
    const keep = this._dtTabs.find(t=> t.id === keepId);
    if(!keep) return;
    this._dtTabs = [keep];
    this._dtActiveId = keep.id;
    this.history.undoStack = keep.undoStack || [];
    this.history.redoStack = keep.redoStack || [];
    this._currentFilename = keep.filename || null;
    this._restoreSnapshot(keep.snapshot || this._dtMakeBlankSnapshot());
    if(this.history.undoStack.length === 0) this.history.commit();
    this._dtRenderTabs();
    this._dtAutosaveAll();
  },

  /** Moves the tab with id `dragId` to sit just before/after `overId`
   *  (side determined by `after`), reorders the underlying array, and
   *  re-renders. Pure array reorder — no snapshot data changes hands. */
  _dtReorder(dragId, overId, after){
    if(dragId === overId) return;
    const from = this._dtTabs.findIndex(t=> t.id === dragId);
    if(from === -1) return;
    const [moved] = this._dtTabs.splice(from, 1);
    let to = this._dtTabs.findIndex(t=> t.id === overId);
    if(to === -1){ this._dtTabs.push(moved); }
    else{
      if(after) to += 1;
      this._dtTabs.splice(to, 0, moved);
    }
    this._dtRenderTabs();
    this._dtAutosaveAll();
  },

  _dtRenderTabs(){
    const list = document.getElementById('design-tabs-list');
    if(!list) return;
    list.innerHTML = '';
    for(const tab of this._dtTabs){
      const el = document.createElement('div');
      el.className = 'design-tab' + (tab.id === this._dtActiveId ? ' active' : '');
      el.dataset.tabId = tab.id;
      el.draggable = true;
      el.title = 'Drag to reorder · double-click to rename · right-click for more';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'design-tab-name';
      nameSpan.textContent = tab.name;
      nameSpan.title = tab.name;
      el.appendChild(nameSpan);
      if(this._dtTabs.length > 1){
        const closeBtn = document.createElement('span');
        closeBtn.className = 'design-tab-close';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close design';
        closeBtn.addEventListener('click', (e)=>{ e.stopPropagation(); this._dtCloseTab(tab.id); });
        el.appendChild(closeBtn);
      }
      el.addEventListener('click', ()=>{ this._dtSwitchTo(tab.id); });
      el.addEventListener('dblclick', (e)=>{
        e.stopPropagation();
        this._dtOpenRenameDialog(tab.id);
      });
      el.addEventListener('contextmenu', (e)=>{
        e.preventDefault();
        this._dtShowContextMenu(e.clientX, e.clientY, tab.id);
      });
      // --- Drag-to-reorder (native HTML5 DnD) ---
      el.addEventListener('dragstart', (e)=>{
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', tab.id);
        this._dtDragId = tab.id;
        requestAnimationFrame(()=> el.classList.add('dt-dragging'));
      });
      el.addEventListener('dragend', ()=>{
        el.classList.remove('dt-dragging');
        this._dtDragId = null;
        list.querySelectorAll('.design-tab').forEach(t=> t.classList.remove('dt-drag-over-left','dt-drag-over-right'));
      });
      el.addEventListener('dragover', (e)=>{
        if(!this._dtDragId || this._dtDragId === tab.id) return;
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        el.classList.toggle('dt-drag-over-left', !after);
        el.classList.toggle('dt-drag-over-right', after);
      });
      el.addEventListener('dragleave', ()=>{ el.classList.remove('dt-drag-over-left','dt-drag-over-right'); });
      el.addEventListener('drop', (e)=>{
        e.preventDefault();
        const dragId = e.dataTransfer.getData('text/plain') || this._dtDragId;
        if(!dragId) return;
        const rect = el.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        el.classList.remove('dt-drag-over-left','dt-drag-over-right');
        this._dtReorder(dragId, tab.id, after);
      });
      list.appendChild(el);
    }
    // Keep the active tab scrolled into view (e.g. after adding a new one).
    const activeEl = list.querySelector('.design-tab.active');
    if(activeEl) activeEl.scrollIntoView({ block:'nearest', inline:'nearest' });
  },

  /** Small right-click menu for a design tab: Duplicate / Close Others /
   *  Close, styled to match the app's existing top-menu dropdowns. Closes
   *  itself on outside click, Escape, or scroll. */
  _dtShowContextMenu(x, y, tabId){
    this._dtCloseContextMenu();
    const tab = this._dtTabs.find(t=> t.id === tabId);
    if(!tab) return;
    const menu = document.createElement('div');
    menu.className = 'dt-ctx-menu';
    const items = [
      { label:'Duplicate Design', action:()=> this._dtDuplicateTab(tabId) },
      { label:'Rename', action:()=> this._dtOpenRenameDialog(tabId) },
    ];
    if(this._dtTabs.length > 1){
      items.push({ label:'Close Others', action:()=> this._dtCloseOthers(tabId) });
      items.push({ label:'Close', danger:true, action:()=> this._dtCloseTab(tabId) });
    }
    for(const it of items){
      const row = document.createElement('div');
      row.className = 'dropdown-item' + (it.danger ? ' danger' : '');
      row.textContent = it.label;
      row.addEventListener('click', ()=>{ it.action(); this._dtCloseContextMenu(); });
      menu.appendChild(row);
    }
    document.body.appendChild(menu);
    // Position after measuring, clamped to the viewport so it never runs
    // off the right/bottom edge near the corners of the window.
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
    this._dtCtxMenuEl = menu;
    const closeOnOutside = (e)=>{ if(!menu.contains(e.target)) this._dtCloseContextMenu(); };
    const closeOnEscape = (e)=>{ if(e.key === 'Escape') this._dtCloseContextMenu(); };
    setTimeout(()=>{
      document.addEventListener('mousedown', closeOnOutside, { once:true });
      window.addEventListener('scroll', ()=> this._dtCloseContextMenu(), { once:true, capture:true });
      window.addEventListener('keydown', closeOnEscape, { once:true });
    }, 0);
  },
  _dtCloseContextMenu(){
    if(this._dtCtxMenuEl){ this._dtCtxMenuEl.remove(); this._dtCtxMenuEl = null; }
  },

  /** Opens the app-drawn Rename Design modal for the given tab, pre-filled
   *  with its current name. Replaces the old contenteditable-in-tab
   *  approach, which rendered using the browser's own native text-caret/
   *  selection chrome instead of a control the app draws itself. */
  _dtOpenRenameDialog(tabId){
    const tab = this._dtTabs.find(t=> t.id === tabId);
    if(!tab) return;
    const overlay = document.getElementById('dt-rename-overlay');
    const input   = document.getElementById('dt-rename-input');
    if(!overlay || !input) return;
    this._dtCloseContextMenu();
    input.value = tab.name;
    overlay.style.display = 'flex';
    input.focus();
    input.select();
    this._dtRenameTargetId = tabId;
  },
  _dtBindRenameDialog(){
    const overlay = document.getElementById('dt-rename-overlay');
    const input   = document.getElementById('dt-rename-input');
    const confirmBtn = document.getElementById('dt-rename-confirm');
    const cancelBtn  = document.getElementById('dt-rename-cancel');
    if(!overlay || !input || !confirmBtn || !cancelBtn) return;
    const close = ()=>{ overlay.style.display = 'none'; this._dtRenameTargetId = null; };
    const confirm = ()=>{
      if(this._dtRenameTargetId) this._dtRenameTab(this._dtRenameTargetId, input.value);
      close();
    };
    confirmBtn.addEventListener('click', confirm);
    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e)=>{ if(e.target === overlay) close(); });
    input.addEventListener('keydown', (e)=>{
      if(e.key === 'Enter'){ e.preventDefault(); confirm(); }
      if(e.key === 'Escape'){ e.preventDefault(); close(); }
    });
  },

  _bindDesignTabsBar(){
    const addBtn = document.getElementById('design-tab-add');
    if(addBtn) addBtn.addEventListener('click', ()=> this._dtAddTab());
    this._dtBindAutoHide();
    this._dtBindPinToggle();
    this._dtBindKeyboard();
    this._dtBindRenameDialog();
  },

  /** Non-conflicting shortcuts for cycling/creating designs. Ctrl+Tab and
   *  Ctrl+W are reserved by the browser itself for its own tabs and can't
   *  be reliably overridden from page JS, so this uses Ctrl+Alt combos
   *  instead, matching the "New"/"Delete Design" items already in the
   *  Files menu. */
  _dtBindKeyboard(){
    window.addEventListener('keydown', (e)=>{
      const isTextInput = e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA' || e.target.isContentEditable;
      if(isTextInput) return;
      if(!(e.ctrlKey || e.metaKey) || !e.altKey) return;
      const key = e.key.toLowerCase();
      if(key === 'arrowright' || key === 'arrowleft'){
        e.preventDefault();
        const idx = this._dtTabs.findIndex(t=> t.id === this._dtActiveId);
        if(idx === -1) return;
        const dir = key === 'arrowright' ? 1 : -1;
        const next = this._dtTabs[(idx + dir + this._dtTabs.length) % this._dtTabs.length];
        this._dtSwitchTo(next.id);
      } else if(key === 'n'){
        e.preventDefault();
        this._dtAddTab();
      } else if(key === 'd'){
        e.preventDefault();
        this._dtDuplicateTab(this._dtActiveId);
      }
    });
  },

  /** The design tabs bar stays out of the way while the workspace is idle
   *  or being actively edited, and reveals itself purely by proximity —
   *  no button/handle to click:
   *   1. Hovering the mouse near the bottom edge (or over the bar once
   *      it's showing) reveals it; moving away hides it again shortly after.
   *   2. Tapping near the bottom edge does the same on touch, since there's
   *      no hover concept there; tapping elsewhere on the page hides it.
   *  A "Design Tabs Bar" entry in the View menu (see _dtBindPinToggle)
   *  lets the user pin it permanently open ("Always Show") instead, which
   *  suspends all of the above hover/tap logic. */
  _dtBindAutoHide(){
    const appEl = document.getElementById('app');
    const tabsBar = document.getElementById('design-tabs-bar');
    const statusBar = document.getElementById('status-bar');
    if(!appEl || !tabsBar || !statusBar) return;
    appEl.classList.add('tabs-collapsed');
    let hideTimer = null;
    let revealed = false;
    const clearHide = ()=> clearTimeout(hideTimer);
    const reveal = ()=>{
      clearHide();
      if(revealed) return;
      revealed = true;
      appEl.classList.remove('tabs-collapsed');
    };
    const collapse = ()=>{
      clearHide();
      revealed = false;
      if(appEl.classList.contains('tabs-pinned')) return; // pinned: never collapse
      appEl.classList.add('tabs-collapsed');
    };
    const scheduleHide = (delay)=>{
      if(appEl.classList.contains('tabs-pinned')) return; // pinned mode ignores the hover-driven timer
      clearHide();
      hideTimer = setTimeout(collapse, delay);
    };
    const HOT_ZONE_PX = 44; // distance from the bottom edge that counts as "near"
    window.addEventListener('mousemove', (e)=>{
      if(appEl.classList.contains('tabs-pinned') || e.buttons) return; // ignore drags; pinned mode owns the state
      const nearBottom = (window.innerHeight - e.clientY) <= HOT_ZONE_PX;
      const overBar = revealed && tabsBar.getBoundingClientRect().top <= e.clientY;
      if(nearBottom || overBar) reveal();
      else if(revealed) scheduleHide(400);
    });
    window.addEventListener('mouseleave', ()=>{ if(revealed) scheduleHide(200); });
    window.addEventListener('touchstart', (e)=>{
      if(appEl.classList.contains('tabs-pinned')) return;
      const t = e.touches[0];
      if(!t) return;
      const nearBottom = (window.innerHeight - t.clientY) <= HOT_ZONE_PX;
      if(nearBottom) reveal();
      else if(revealed && !tabsBar.contains(e.target)) collapse();
    }, { passive:true });
    // Lets other actions (e.g. adding a new design) flash the bar open for
    // a few seconds even when the cursor isn't anywhere near it — it then
    // auto-hides again unless the user is hovering or has it pinned.
    this._dtRevealBriefly = (ms)=>{
      if(appEl.classList.contains('tabs-pinned')) return;
      reveal();
      scheduleHide(ms || 3000);
    };
  },

  /** "Design Tabs Bar" entry in the View menu — lets the user pin the bar
   *  permanently open ("Always Show") instead of the default hover-to-reveal
   *  behavior ("Show on Hover"). Toggling just flips the #app.tabs-pinned
   *  class; _dtBindAutoHide's reveal/collapse logic already respects it. */
  _dtBindPinToggle(){
    const appEl = document.getElementById('app');
    const item = document.getElementById('view-toggle-design-tabs');
    const check = document.getElementById('view-design-tabs-check');
    const label = document.getElementById('view-design-tabs-label');
    if(!appEl || !item) return;
    const sync = ()=>{
      const pinned = appEl.classList.contains('tabs-pinned');
      if(check) check.style.visibility = pinned ? 'visible' : 'hidden';
      if(label) label.textContent = pinned ? 'Design Tabs Bar (Always Show)' : 'Design Tabs Bar (Show on Hover)';
      if(pinned) appEl.classList.remove('tabs-collapsed');
    };
    item.addEventListener('click', ()=>{
      appEl.classList.toggle('tabs-pinned');
      sync();
    });
    sync();
  },

  /** Persists every open design (not just the active one) so tabs survive
   *  a refresh. Undo/redo history intentionally stays in-memory only. */
  _dtAutosaveAll(){
    this._dtCaptureActiveTab();
    const payload = {
      version: 2,
      activeId: this._dtActiveId,
      counter: this._dtCounter,
      tabs: this._dtTabs.map(t=> ({ id:t.id, name:t.name, filename:t.filename||null, snapshot:t.snapshot }))
    };
    PersistenceManager.autosave(payload);
  },

  // =====================================================================
  // SNAPSHOT / RESTORE  (shared by undo-redo, autosave-load, file-open)
  // =====================================================================
  _applySnapshotData(data){
    // Clear existing views
    for(const node of this.views.values()) node.remove();
    this.views.clear();
    // Remove any switch bank overlay panels
    if(this._switchBanks){ this._switchBanks.forEach(e=>e.bank.remove()); this._switchBanks=[]; }
    // Remove any existing truth-table / K-map panels — they're about to be
    // rebuilt from this snapshot's data (or simply absent, if this design
    // never had any), same as components/wires.
    if(this._ttPanels){ for(const t of [...this._ttPanels]) this._ttClosePanel(t); }
    if(this._kmPanels){ for(const p of [...this._kmPanels]) this._kmClosePanel(p); }
    this.model = CircuitModel.deserialize(data);
    // Migration: old saves stored 'SW' or 'SWITCH' as the default switch label.
    // The new default is '' (empty). Strip any label that matches the old defaults
    // so they don't appear as user-set labels on load.
    for(const c of this.model.components.values()){
      if(c.type === 'SWITCH' && (c.label === 'SW' || c.label === 'SWITCH')) c.label = '';
    }
    if(data.view){
      this.renderer.pan = data.view.pan || {x:0,y:0};
      this.renderer.zoom = data.view.zoom || 1;
      this.renderer.gridSize = data.view.gridSize || 20;
      WireRouter.GRID = this.renderer.gridSize;
      if(typeof data.view.wireWidth === 'number'){
        this.renderer.wireWidth = data.view.wireWidth;
        this._updateWireWidthReadout();
      }
    }
    for(const c of this.model.components.values()){
      this.views.set(c.id, ComponentView.create(c, this.el.world));
    }

    // Reconstruct bank panels from bankGroup ids saved on each component
    // (SWITCH, LED, PROBE, or VARIABLE — any bankable type). Without this,
    // banks appear as disconnected individual elements after save/load,
    // undo/redo, or any other snapshot restore.
    const bankMap = new Map(); // bankGroupId → [component, ...]
    for(const c of this.model.components.values()){
      if(BankableTypes.has(c.type) && c.bankGroup){
        if(!bankMap.has(c.bankGroup)) bankMap.set(c.bankGroup, []);
        bankMap.get(c.bankGroup).push(c);
      }
    }
    if(!this._switchBanks) this._switchBanks = [];
    for(const [, members] of bankMap){
      if(members.length < 2) continue;
      members.sort((a,b)=> a.y - b.y);
      const def = GateLibrary[members[0].type];
      const startX = members[0].x;
      const startY = members[0].y;
      const totalH = members.length * def.h;
      const maxW = Math.max(def.w, ...members.map(m=>m.w));
      const bank = document.createElement('div');
      bank.className = 'switch-bank';
      bank.style.left   = (startX - 2) + 'px';
      bank.style.top    = (startY - 2) + 'px';
      bank.style.width  = (maxW + 4) + 'px';
      bank.style.height = (totalH + 4) + 'px';
      // Insert before the first member node so bank renders behind the switches
      const firstNode = this.views.get(members[0].id);
      if(firstNode && firstNode.parentNode === this.el.world){
        this.el.world.insertBefore(bank, firstNode);
      } else {
        this.el.world.appendChild(bank);
      }
      members.forEach((c, i)=>{
        const node = this.views.get(c.id);
        if(node) node.classList.add('in-switch-bank');
        if(i < members.length - 1){
          const div = document.createElement('div');
          div.className = 'switch-bank-divider';
          div.style.top = (i * def.h + def.h - 1) + 'px';
          bank.appendChild(div);
        }
      });
      this._switchBanks.push({ bank, ids: members.map(c=>c.id), x: startX, y: startY, w: def.w, h: totalH });
    }
    // Truth-table / K-map panels are rebuilt separately, via
    // _restorePanelsFromData() — see call sites. Restoring them here
    // unconditionally was the source of an intermittent bug: on the very
    // first load (_loadInitialState, before renderer.resize() has run),
    // the viewport hadn't been measured yet, so a freshly-restored panel's
    // natural width could get frozen at 0px — invisible, but only on that
    // specific timing, which is why it didn't reproduce every time.

    this.selection.clear();
    this.renderer.draw();
  },
  /** Rebuilds truth-table / K-map panels from saved snapshot data. Kept
   *  separate from _applySnapshotData so callers can control exactly when
   *  it runs relative to renderer.resize() — panel creation measures the
   *  viewport and its own natural size, so it needs accurate layout. */
  _restorePanelsFromData(data){
    if(data.truthTables){
      for(const t of data.truthTables){
        try{ this._ttRestorePanel(t); }catch(e){ console.warn('Could not restore a truth table', e); }
      }
    }
    if(data.kmaps){
      for(const k of data.kmaps){
        try{ this._kmRestorePanel(k); }catch(e){ console.warn('Could not restore a K-map', e); }
      }
    }
  },
  _restoreSnapshot(snap){ this._applySnapshotData(snap); this._restorePanelsFromData(snap); this.runSimulation(); this._refreshAll(); },

  // =====================================================================
  // SIMULATION + RENDER REFRESH
  // =====================================================================
  runSimulation(){
    SimulationEngine.evaluate(this.model);
    this._ttUpdateHighlight();
  },
  /** Changes the input-pin count of an expandable gate instance (AND/OR/
   *  NAND/NOR/XOR/XNOR), clamped to [GATE_MIN_INPUTS, GATE_MAX_INPUTS].
   *  Any wires connected to pins that no longer exist after shrinking are
   *  removed (a dangling wire to a deleted pin makes no sense), then the
   *  component's DOM node is rebuilt from scratch since pin count/position
   *  and body height changed. */
  setInputCount(compId, newCount){
    const c = this.model.getComponent(compId);
    if(!c || !ExpandableGates.has(c.type)) return;
    const clamped = Utils.clamp(newCount, GATE_MIN_INPUTS, GATE_MAX_INPUTS);
    if(clamped === (c.inputCount || GateLibrary[c.type].inputs.length)) return;
    c.inputCount = clamped;
    c._defCache = null; // force def to resynthesize inputs for the new count
    const validIds = new Set([...c.def.inputs.map(p=>p.id), ...c.def.outputs.map(p=>p.id)]);
    for(const [wid, w] of [...this.model.wires]){
      if((w.toComp === c.id && !validIds.has(w.toPin)) ||
         (w.fromComp === c.id && !validIds.has(w.fromPin))) this.model.wires.delete(wid);
    }
    const oldNode = this.views.get(c.id);
    if(oldNode) oldNode.remove();
    this.views.set(c.id, ComponentView.create(c, this.el.world));
    c._selected = this.selection.selectedComponents.has(c.id);
    if(this.views.get(c.id)) ComponentView.sync(c, this.views.get(c.id));
    this.markDirty();
    this.history.commit();
  },
  /** Rotates a single component by `delta` degrees (±90), independent of
   *  the current selection. Used by the properties-panel rotation +/-
   *  buttons; multi-select rotation still goes through rotateSelection(). */
  rotateComponent(compId, delta){
    const c = this.model.getComponent(compId);
    if(!c) return;
    c.rotation = ((c.rotation + delta) % 360 + 360) % 360;
    const node = this.views.get(c.id);
    if(node) ComponentView.sync(c, node);
    this.markDirty();
    this.history.commit();
  },
  /** Swaps a gate instance to a different gate type from the properties
   *  panel (e.g. AND -> NAND, or NOT -> BUFFER). Only allowed between
   *  types in the same pin-arity family (both single-input, or both
   *  expandable multi-input) so every existing wire — which references a
   *  pin id, not a gate type — stays connected exactly where it was.
   *  A still-default label is carried over to the new type's default;
   *  a custom label is left untouched. The DOM node is rebuilt from
   *  scratch since the gate's shape/symbol changed. */
  changeGateType(compId, newType){
    const c = this.model.getComponent(compId);
    if(!c) return;
    const oldDef = GateLibrary[c.type], newDef = GateLibrary[newType];
    if(!oldDef || !newDef || oldDef.category!=='gate' || newDef.category!=='gate') return;
    if(newType === c.type) return;
    if(ExpandableGates.has(c.type) !== ExpandableGates.has(newType)) return;
    if(c.label === oldDef.label) c.label = newDef.label;
    c.type = newType;
    c._defCache = null;
    const oldNode = this.views.get(c.id);
    if(oldNode) oldNode.remove();
    this.views.set(c.id, ComponentView.create(c, this.el.world));
    c._selected = this.selection.selectedComponents.has(c.id);
    if(this.views.get(c.id)) ComponentView.sync(c, this.views.get(c.id));
    this.runSimulation();
    this.markDirty();
    this.history.commit();
  },
  /** All (otherComp, otherPin) endpoints of wires touching (compId, pinId),
   *  regardless of which side of the wire it happens to be stored on
   *  (wires carry no electrical from/to meaning — see CircuitModel.addWire). */
  _gatherPinWires(compId, pinId){
    const others = [];
    for(const w of this.model.wires.values()){
      if(w.fromComp===compId && w.fromPin===pinId) others.push({comp:w.toComp, pin:w.toPin});
      else if(w.toComp===compId && w.toPin===pinId) others.push({comp:w.fromComp, pin:w.fromPin});
    }
    return others;
  },
  /** Replaces a single gate component `c` with an equivalent subcircuit
   *  built entirely out of `target` ('NAND' or 'NOR') gates, preserving
   *  every external wire connection. New component ids are added to
   *  `selectedOut` (a Set) so the caller can select the freshly-built
   *  gates once the whole batch is done. Returns true if a replacement
   *  was made. */
  _replaceGateWithUniversal(c, target, selectedOut){
    const oldDef = c.def;
    const built = UniversalConverter.build(c.type, oldDef.inputs.length, target);
    if(!built || built.nodes.length===0) return false;

    // Snapshot what was wired to this gate's pins before removing it.
    const inputSources = oldDef.inputs.map(p => this._gatherPinWires(c.id, p.id));
    const outputTargets = oldDef.outputs.length ? this._gatherPinWires(c.id, oldDef.outputs[0].id) : [];

    const oldNode = this.views.get(c.id);
    if(oldNode) oldNode.remove();
    this.views.delete(c.id);
    this.model.removeComponent(c.id); // cascades: drops every wire touching c

    // Lay the new gates out in "columns" by dependency depth — a gate
    // built purely from the replaced gate's original inputs (a leaf)
    // sits in column 0; anything that consumes another synthetic gate's
    // output sits one column further right than the deepest gate it
    // depends on. This reads left-to-right the way these circuits are
    // drawn by hand (e.g. two leaf NANDs feeding a combining NAND), and
    // keeps every wire between synthetic gates short and mostly straight
    // instead of criss-crossing.
    //
    // Each gate's row is the average y of whatever it's built from
    // (already finalized, since columns are resolved left-to-right),
    // then nudged apart from its column-mates just enough to keep a full
    // spacingY gap — so a gate combining two others lands vertically
    // centered between them, and gates that don't share ancestry don't
    // overlap. The whole layout is then recentered on the original
    // gate's position. Orientation is carried over unchanged.
    const spacingX = 170, spacingY = 110;
    const nodeCount = built.nodes.length;
    const depth = new Array(nodeCount).fill(0);
    for(let idx=0; idx<nodeCount; idx++){
      let d = 0;
      for(const ref of built.nodes[idx].in){
        if(ref.node !== undefined) d = Math.max(d, depth[ref.node] + 1);
      }
      depth[idx] = d;
    }
    const maxDepth = depth.reduce((a,b)=>Math.max(a,b), 0);
    const finalY = new Array(nodeCount).fill(0);
    for(let d=0; d<=maxDepth; d++){
      const colIdxs = [];
      for(let idx=0; idx<nodeCount; idx++) if(depth[idx]===d) colIdxs.push(idx);
      const raw = colIdxs.map(idx=>{
        const refsY = built.nodes[idx].in.filter(r=>r.node!==undefined).map(r=>finalY[r.node]);
        return refsY.length ? refsY.reduce((a,b)=>a+b,0)/refsY.length : 0;
      });
      const order = colIdxs.map((idx,i)=>({idx, raw: raw[i]})).sort((a,b)=>a.raw-b.raw);
      let prev = -Infinity;
      for(const item of order){
        let y = item.raw;
        if(prev !== -Infinity && y < prev + spacingY) y = prev + spacingY;
        finalY[item.idx] = y;
        prev = y;
      }
    }
    const midY = (Math.min(...finalY) + Math.max(...finalY)) / 2;
    const newIds = built.nodes.map((node, idx)=>{
      const nc = new CircuitComponent(node.type, c.x + depth[idx]*spacingX, c.y + (finalY[idx]-midY), Utils.uid('c'));
      nc.rotation = c.rotation;
      if(node.in.length !== GateLibrary[node.type].inputs.length){
        nc.inputCount = Utils.clamp(node.in.length, GATE_MIN_INPUTS, GATE_MAX_INPUTS);
      }
      this.model.addComponent(nc);
      this.views.set(nc.id, ComponentView.create(nc, this.el.world));
      selectedOut.add(nc.id);
      return nc.id;
    });

    // Every gate type used across these builders (AND/OR/NAND/NOR/NOT)
    // shares the same output pin id ('out'), so this stays a constant —
    // but it's looked up per-node's own type rather than assumed to equal
    // `target`, since builds can now mix gate types (e.g. AND + NOT).
    const outPinIdFor = idx => GateLibrary[built.nodes[idx].type].outputs[0].id;

    // Wire every synthetic gate's inputs: a {node:j} ref becomes a wire
    // from gate j's output; a {ext:i} ref becomes one wire per original
    // driver of the replaced gate's i-th input pin (fan-out is fine — an
    // output pin already supports any number of outgoing wires).
    built.nodes.forEach((node, idx)=>{
      const destId = newIds[idx];
      const destDef = this.model.getComponent(destId).def;
      node.in.forEach((ref, k)=>{
        const destPin = destDef.inputs[k].id;
        if(ref.node !== undefined){
          this.model.addWire(new CircuitWire(newIds[ref.node], outPinIdFor(ref.node), destId, destPin));
        } else {
          for(const src of inputSources[ref.ext]){
            this.model.addWire(new CircuitWire(src.comp, src.pin, destId, destPin));
          }
        }
      });
    });

    // Reconnect whatever the original gate's output used to drive.
    const finalSrc = built.outRef.node !== undefined
      ? { comp: newIds[built.outRef.node], pin: outPinIdFor(built.outRef.node) }
      : (inputSources[built.outRef.ext][0] || null);
    if(finalSrc){
      for(const dst of outputTargets){
        this.model.addWire(new CircuitWire(finalSrc.comp, finalSrc.pin, dst.comp, dst.pin));
      }
    }
    return true;
  },
  /** Converts every 'gate'-category component in the current selection to
   *  an equivalent subcircuit built entirely from `target` ('NAND' or
   *  'NOR') gates. Non-gate components in the selection (switches, LEDs,
   *  variables, etc.) are left untouched. Returns the number of gates
   *  converted. */
  convertSelectionToUniversal(target){
    const ids = [...this.selection.selectedComponents];
    const gateIds = ids.filter(id=>{
      const c = this.model.getComponent(id);
      const def = c && GateLibrary[c.type];
      return def && def.category==='gate' && UniversalConverter.isEligible(c.type, target);
    });
    if(gateIds.length===0) return 0;
    const newSelected = new Set();
    for(const id of gateIds){
      const c = this.model.getComponent(id);
      if(c) this._replaceGateWithUniversal(c, target, newSelected);
    }
    this.selection.selectedComponents = newSelected;
    this.selection.selectedWires.clear();
    this.runSimulation();
    this._refreshAll();
    this.history.commit();
    return gateIds.length;
  },

  // =====================================================================
  // BOOLEAN EXPRESSION TO CIRCUIT
  // =====================================================================
  openBoolExprTool(prefillExpr, knownVars){
    const overlay = document.getElementById('boolexpr-overlay');
    const input = document.getElementById('boolexpr-input');
    const errBox = document.getElementById('boolexpr-error');
    const cancelBtn = document.getElementById('boolexpr-cancel');
    const genBtn = document.getElementById('boolexpr-generate');
    const padWrap = document.getElementById('boolexpr-pad');
    const toggleBtn = document.getElementById('boolexpr-toggle-pad');
    const toggleIcon = document.getElementById('boolexpr-toggle-icon');
    const toggleLabel = document.getElementById('boolexpr-toggle-label');
    const fnWrap = document.getElementById('boolexpr-pad-fn');
    const lettersWrap = document.getElementById('boolexpr-pad-letters');
    const bottomWrap = document.getElementById('boolexpr-pad-bottom');
    this._boolExprKnownVars = knownVars || null;
    errBox.style.display = 'none';
    input.value = prefillExpr || '';
    document.querySelector('input[name="boolexpr-output-type"][value="LED"]').checked = true;
    overlay.style.display = 'flex';
    setTimeout(()=>input.focus(), 30);

    const insertAtCursor = (text)=>{
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const caret = start + text.length;
      input.focus();
      input.setSelectionRange(caret, caret);
    };
    const makeKey = (label, cls, onClick)=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'boolexpr-key ' + cls;
      btn.textContent = label;
      btn.onclick = onClick;
      return btn;
    };
    // Gate keys show the math symbol as the main face, with the gate's
    // name underneath as a small, pale-gray subtitle (e.g. "∧" / "AND").
    const makeGateKey = (symbol, name, insert, onClick)=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'boolexpr-key boolexpr-key-fn';
      btn.title = name;
      const sym = document.createElement('span');
      sym.className = 'boolexpr-key-symbol';
      sym.textContent = symbol;
      const nm = document.createElement('span');
      nm.className = 'boolexpr-key-name';
      nm.textContent = name;
      btn.appendChild(sym);
      btn.appendChild(nm);
      btn.onclick = onClick || (()=> insertAtCursor(insert));
      return btn;
    };

    // Operator row: each key shows the math symbol, with the gate's name
    // as a small caption underneath.
    fnWrap.innerHTML = '';
    [
      ['×','AND'], ['+','OR'], ["×'",'NAND'], ["+'",'NOR'],
      ['⊕','XOR'], ["⊕'",'XNOR'], ["'",'NOT'],
    ].forEach(([symbol, name])=>{
      fnWrap.appendChild(makeGateKey(symbol, name, symbol));
    });

    // Light gray letter grid — A–Z covers every single-letter variable
    // name; multi-letter names still work fine typed via keyboard.
    lettersWrap.innerHTML = '';
    for(let i=0; i<26; i++){
      const letter = String.fromCharCode(65+i);
      lettersWrap.appendChild(makeKey(letter, 'boolexpr-key-letter', ()=> insertAtCursor(letter)));
    }

    // Bottom row: parens/quote/digits (blue-gray) plus clear/backspace (red)
    bottomWrap.innerHTML = '';
    [['(','boolexpr-key-sym'], [')','boolexpr-key-sym'], ["'",'boolexpr-key-sym'],
     ['0','boolexpr-key-digit'], ['1','boolexpr-key-digit']].forEach(([label, cls])=>{
      bottomWrap.appendChild(makeKey(label, cls, ()=> insertAtCursor(label)));
    });
    bottomWrap.appendChild(makeKey('⌫', 'boolexpr-key-util', ()=>{
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      if(start===end && start>0) input.value = input.value.slice(0,start-1) + input.value.slice(start);
      else input.value = input.value.slice(0,start) + input.value.slice(end);
      const caret = start===end ? Math.max(0,start-1) : start;
      input.focus();
      input.setSelectionRange(caret, caret);
    }));
    bottomWrap.appendChild(makeKey('C', 'boolexpr-key-util', ()=>{ input.value = ''; input.focus(); }));

    // Collapse/expand the calculator body — a keyboard-only user can close
    // it and just type straight into the LCD-style input above.
    let padOpen = true;
    const applyPadState = ()=>{
      padWrap.style.display = padOpen ? 'block' : 'none';
      toggleIcon.style.transform = padOpen ? 'rotate(0deg)' : 'rotate(-180deg)';
      toggleLabel.textContent = padOpen ? 'Hide keypad' : 'Show keypad';
    };
    applyPadState();
    toggleBtn.onclick = ()=>{
      padOpen = !padOpen;
      applyPadState();
      if(!padOpen) input.focus();
    };

    const close = ()=>{ overlay.style.display = 'none'; };
    const showError = (msg)=>{ errBox.textContent = msg; errBox.style.display = 'block'; };
    cancelBtn.onclick = close;
    overlay.onclick = (e)=>{ if(e.target===overlay) close(); };
    const submit = ()=>{
      const expr = input.value.trim();
      if(!expr){ showError('Enter a boolean expression first.'); return; }
      const outputType = document.querySelector('input[name="boolexpr-output-type"]:checked').value;
      const result = this._buildCircuitFromBoolExpr(expr, outputType, this._boolExprKnownVars);
      if(!result.ok){ showError(result.error); return; }
      close();
    };
    genBtn.onclick = submit;
    input.onkeydown = (e)=>{
      if(e.key==='Enter'){ e.preventDefault(); submit(); }
      else if(e.key==='Escape'){ e.preventDefault(); close(); }
    };
  },
  // =====================================================================
  // CIRCUIT TO BOOLEAN EXPRESSION
  // The reverse tool: reads whichever circuit is selected (or the whole
  // sheet, if nothing is selected), brute-forces its truth table via the
  // exact same _ttCollectIO()/_ttCompute() the Truth Table Maker and
  // K-map tool already use (so any gate mix — including universal-only
  // builds — is handled correctly), then reads a Boolean expression back
  // out of that table with the same Quine–McCluskey minimizer the K-map
  // tool uses (KMapEngine.minimize).
  // =====================================================================
  openCircuitToBoolExprTool(){
    const io = this._ttCollectIO();
    this._ceIO = io;
    const body = document.getElementById('circexpr-body');
    const subtitle = document.getElementById('circexpr-subtitle');
    const genBtn = document.getElementById('circexpr-generate');
    body.innerHTML = '';
    document.getElementById('circexpr-error').style.display = 'none';
    document.getElementById('circexpr-loading').style.display = 'none';
    document.getElementById('circexpr-results').style.display = 'none';
    document.getElementById('circexpr-setup-form').style.display = 'flex';
    const MAX_INPUTS = 12;
    if(io.inputs.length === 0){
      subtitle.textContent = io.scoped
        ? 'No VARIABLE elements found in your current selection. Select the circuit you want analyzed (including its variables), or click empty canvas to use the whole sheet.'
        : 'No VARIABLE elements found on the canvas. A circuit needs at least one input variable to derive an expression.';
      genBtn.style.display = 'none';
    } else if(io.inputs.length > MAX_INPUTS){
      subtitle.textContent = `This circuit has ${io.inputs.length} input variables — that's too many to brute-force a truth table from (max ${MAX_INPUTS}). Select a smaller sub-circuit first.`;
      genBtn.style.display = 'none';
    } else if(io.outputs.length === 0){
      subtitle.textContent = io.scoped
        ? 'No LED or Probe outputs found in your current selection. Make sure the selected circuit includes its output(s).'
        : 'No LED or Probe outputs found on the canvas. Add at least one output to analyze.';
      genBtn.style.display = 'none';
    } else {
      subtitle.textContent = (io.scoped ? `Selected circuit — inputs: ${io.inputs.map(i=>i.label).join(', ')}.` : `Inputs detected: ${io.inputs.map(i=>i.label).join(', ')}.`) + ' Choose the output(s) to derive an expression for:';
      genBtn.style.display = 'inline-block';
      io.outputs.forEach((o, idx)=>{
        const row = document.createElement('label');
        row.className = 'circexpr-output-row';
        row.innerHTML = `<input type="checkbox" class="circexpr-output-pick" value="${idx}" checked>
          <span>${this._ttEscape(o.defaultName)} <span style="color:#8a93a1; font-weight:600;">(${o.type})</span></span>`;
        body.appendChild(row);
      });
    }
    document.getElementById('circexpr-overlay').style.display = 'flex';
  },
  _bindCircuitToBoolExprTool(){
    const overlay = document.getElementById('circexpr-overlay');
    const close = ()=>{ overlay.style.display = 'none'; };
    document.getElementById('circexpr-cancel').onclick = close;
    document.getElementById('circexpr-results-close').onclick = close;
    document.getElementById('circexpr-error-close').onclick = close;
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
    document.getElementById('circexpr-dialog').addEventListener('click', (e)=> e.stopPropagation());
    document.getElementById('circexpr-generate').onclick = ()=>{
      const io = this._ceIO;
      if(!io) return;
      const picked = [...document.querySelectorAll('.circexpr-output-pick:checked')];
      const outIdxs = picked.map(cb=> parseInt(cb.value, 10));
      if(outIdxs.length === 0) return;
      this._ceRunGeneration(io, outIdxs);
    };
  },
  // =====================================================================
  // SIMPLIFY CIRCUIT
  // Reduces a selected sub-circuit (or the whole sheet, if nothing is
  // selected) to the minimal equivalent gate network. Shares the exact
  // same IO-detection (_ttCollectIO), truth-table brute-force
  // (_ttCompute), and Quine-McCluskey minimization (_ceAnalyzeOutput) as
  // Circuit to Boolean Expression -- the difference is what happens with
  // the result: instead of showing text, this deletes every non-VARIABLE/
  // LED/PROBE component in scope and rebuilds only the internal gates
  // from the simplified expression, wiring back into the *same* VARIABLE
  // and LED/Probe components rather than creating new ones (see
  // _scRunSimplify). Multiple outputs are simplified independently, same
  // as every other tool here -- no attempt is made to share gates between
  // two outputs' logic cones.
  // =====================================================================
  openSimplifyCircuitTool(){
    // Any snapshot left over from a previous run that was neither confirmed
    // nor cancelled (shouldn't normally happen) is discarded -- starting a
    // fresh run should never let a stale snapshot restore later.
    this._scPendingSnapshot = null;
    document.getElementById('simplifycirc-dialog').style.width = '420px';
    const io = this._ttCollectIO();
    this._scIO = io;
    const body = document.getElementById('simplifycirc-body');
    const subtitle = document.getElementById('simplifycirc-subtitle');
    const genBtn = document.getElementById('simplifycirc-generate');
    body.innerHTML = '';
    document.getElementById('simplifycirc-error').style.display = 'none';
    document.getElementById('simplifycirc-loading').style.display = 'none';
    document.getElementById('simplifycirc-results').style.display = 'none';
    document.getElementById('simplifycirc-setup-form').style.display = 'flex';
    const MAX_INPUTS = 12;
    if(io.inputs.length === 0){
      subtitle.textContent = io.scoped
        ? 'No VARIABLE elements found in your current selection. Select the circuit you want simplified (including its variables), or click empty canvas to use the whole sheet.'
        : 'No VARIABLE elements found on the canvas. A circuit needs at least one input variable to simplify.';
      genBtn.style.display = 'none';
    } else if(io.inputs.length > MAX_INPUTS){
      subtitle.textContent = `This circuit has ${io.inputs.length} input variables -- that's too many to brute-force a truth table from (max ${MAX_INPUTS}). Select a smaller sub-circuit first.`;
      genBtn.style.display = 'none';
    } else if(io.outputs.length === 0){
      subtitle.textContent = io.scoped
        ? 'No LED or Probe outputs found in your current selection. Make sure the selected circuit includes its output(s).'
        : 'No LED or Probe outputs found on the canvas. Add at least one output to simplify.';
      genBtn.style.display = 'none';
    } else {
      subtitle.textContent = (io.scoped ? `Selected circuit -- inputs: ${io.inputs.map(i=>i.label).join(', ')}.` : `Inputs detected: ${io.inputs.map(i=>i.label).join(', ')}.`) + ' Choose the output(s) to simplify:';
      genBtn.style.display = 'inline-block';
      io.outputs.forEach((o, idx)=>{
        const row = document.createElement('label');
        row.className = 'circexpr-output-row';
        row.innerHTML = `<input type="checkbox" class="simplifycirc-output-pick" value="${idx}" checked>
          <span>${this._ttEscape(o.defaultName)} <span style="color:#8a93a1; font-weight:600;">(${o.type})</span></span>`;
        body.appendChild(row);
      });
    }
    document.getElementById('simplifycirc-overlay').style.display = 'flex';
  },
  _bindSimplifyCircuitTool(){
    const overlay = document.getElementById('simplifycirc-overlay');
    const dialog = document.getElementById('simplifycirc-dialog');
    const close = ()=>{ overlay.style.display = 'none'; dialog.style.width = '420px'; };
    document.getElementById('simplifycirc-cancel').onclick = close;
    document.getElementById('simplifycirc-error-close').onclick = close;
    // Results panel: "Cancel" restores the pre-rebuild snapshot (the rebuild
    // already happened live on canvas so the preview has something real to
    // show -- cancelling just undoes it without ever touching history).
    // "Confirm" simply commits the already-applied state to history.
    const doCancel = ()=>{
      if(this._scPendingSnapshot){
        this._restoreSnapshot(this._scPendingSnapshot);
        this._scPendingSnapshot = null;
      }
      close();
    };
    const doConfirm = ()=>{
      this.history.commit();
      this._scPendingSnapshot = null;
      close();
    };
    document.getElementById('simplifycirc-results-cancel').onclick = doCancel;
    document.getElementById('simplifycirc-results-confirm').onclick = doConfirm;
    overlay.addEventListener('click', (e)=>{
      if(e.target !== overlay) return;
      const resultsShown = document.getElementById('simplifycirc-results').style.display !== 'none';
      if(resultsShown) doCancel(); else close();
    });
    dialog.addEventListener('click', (e)=> e.stopPropagation());
    document.getElementById('simplifycirc-generate').onclick = ()=>{
      const io = this._scIO;
      if(!io) return;
      const picked = [...document.querySelectorAll('.simplifycirc-output-pick:checked')];
      const outIdxs = picked.map(cb=> parseInt(cb.value, 10));
      if(outIdxs.length === 0) return;
      this._scRunSimplify(io, outIdxs);
    };
  },
  /** Does the actual work: brute-forces the truth table, minimizes each
   *  chosen output with _ceAnalyzeOutput, deletes the old internal gates
   *  in scope, then rebuilds each output's logic cone as a fresh minimal
   *  gate network -- wiring straight into the *existing* VARIABLE and
   *  LED/Probe components (never recreating them) so the rest of the
   *  design (labels, other wiring, panels referencing them) stays intact.
  /** Routed length (world-px) of a single wire, computed with the exact same
   *  grid-based Dijkstra router + obstacle set the live canvas uses to draw
   *  wires (WireRouter.route / _obstacles / _pinObstacles) -- so this is the
   *  real length the wire would actually be drawn at, not a straight-line
   *  guess. `model` supplies both the wire's endpoints and every other
   *  component treated as a routing obstacle, so pass whichever model
   *  reflects the state being measured (the pre-rebuild snapshot model for
   *  "before", the live model for "after"). */
  _scRoutedWireLength(model, wire){
    const fromStub = WireRouter._resolveStub(wire.fromComp, wire.fromPin, model);
    const toStub   = WireRouter._resolveStub(wire.toComp,   wire.toPin,   model);
    if(!fromStub || !toStub) return 0;
    const obs = WireRouter._obstacles(model, wire.fromComp, wire.toComp)
      .concat(WireRouter._pinObstacles(model, wire.fromComp, wire.fromPin, wire.toComp, wire.toPin));
    let worldPts;
    if(wire.waypoints && wire.waypoints.length >= 2){
      const wps = wire.waypoints.map(p=>({x:p.x, y:p.y}));
      wps[0] = fromStub.stubPos; wps[wps.length-1] = toStub.stubPos;
      worldPts = [];
      for(let i=0; i<wps.length-1; i++){
        const seg = WireRouter.route(wps[i], wps[i+1], obs);
        if(i===0) worldPts.push(...seg); else worldPts.push(...seg.slice(1));
      }
    } else {
      worldPts = WireRouter.route(fromStub.stubPos, toStub.stubPos, obs);
    }
    let total = 0;
    const addSeg = (a,b)=>{ total += Math.hypot(b.x-a.x, b.y-a.y); };
    addSeg(fromStub.pinPos, worldPts[0]);
    for(let i=0; i<worldPts.length-1; i++) addSeg(worldPts[i], worldPts[i+1]);
    addSeg(worldPts[worldPts.length-1], toStub.pinPos);
    return total;
  },
  /** Renders a count-based "before -> after" tile (Gates / Connections):
   *  exact integers on both sides plus a percentage-change line. */
  _scStatBlock(label, before, after){
    const delta = before - after;
    const pct = before>0 ? Math.round((delta/before)*100) : 0;
    let deltaText, cls;
    if(delta > 0){ deltaText = `↓ ${pct}% fewer`; cls = 'down'; }
    else if(delta < 0){ deltaText = `↑ ${Math.abs(pct)}% more`; cls = 'flat'; }
    else { deltaText = 'no change'; cls = 'flat'; }
    return `<div class="sc-stat">
      <div class="sc-stat-label">${label}</div>
      <div class="sc-stat-nums"><span class="sc-stat-before">${before}</span><span class="sc-stat-arrow">&rarr;</span><span class="sc-stat-after">${after}</span></div>
      <div class="sc-stat-delta ${cls}">${deltaText}</div>
    </div>`;
  },
  /** Renders the wiring-length tile as a percentage only -- no raw
   *  pixel/length numbers, since those aren't meaningful to look at, just
   *  how much shorter (or longer) the new routed wiring is overall. */
  _scWiringStatBlock(before, after){
    let pct = 0, deltaText, cls, big;
    if(before > 0.001){
      pct = Math.round(((before-after)/before)*100);
    }
    if(pct > 0){ big = `${pct}%`; deltaText = 'shorter'; cls = 'down'; }
    else if(pct < 0){ big = `${Math.abs(pct)}%`; deltaText = 'longer'; cls = 'flat'; }
    else { big = '0%'; deltaText = 'about the same'; cls = 'flat'; }
    return `<div class="sc-stat">
      <div class="sc-stat-label">Wiring</div>
      <div class="sc-stat-nums"><span class="sc-stat-after" style="font-size:20px;">${big}</span></div>
      <div class="sc-stat-delta ${cls}">${deltaText}</div>
    </div>`;
  },
  /** Renders one output's rebuilt logic cone into a real PNG using
   *  ExportEngine._buildCanvas -- the exact same component-drawing code the
   *  main canvas and the app's own image export use -- so gates, pins, LED
   *  glow, variable boxes, etc. look 100% like the live workspace instead
   *  of a schematic approximation. Builds a throwaway CircuitModel holding
   *  only this output's components/wires (same live objects, not clones,
   *  so current simulated values are reflected exactly) and renders that
   *  in isolation, cropped tightly to its own bounds. */
  async _scRenderPreviewImage(compIds, wireObjs){
    const subModel = new CircuitModel();
    compIds.forEach(id=>{ const c = this.model.getComponent(id); if(c) subModel.addComponent(c); });
    wireObjs.forEach(w=> subModel.addWire(w));
    if(subModel.components.size === 0) return '<div style="font-size:11.5px; color:#8a93a1;">Nothing to preview.</div>';
    const cvs = await ExportEngine._buildCanvas(subModel, 2, {
      showLabels: true, showPins: true, showGrid: false,
      wireColor: true, switchMode: 'state', transparent: false
    });
    return `<img class="sc-preview-img" src="${cvs.toDataURL('image/png')}" alt="Simplified circuit preview">`;
  },
  _scRunSimplify(io, outIdxs){
    document.getElementById('simplifycirc-setup-form').style.display = 'none';
    document.getElementById('simplifycirc-error').style.display = 'none';
    document.getElementById('simplifycirc-loading').style.display = 'flex';
    setTimeout(async ()=>{
      try{
        // Snapshot *before* anything is touched -- this is what "Cancel &
        // Restore Original" in the results panel restores. history.commit()
        // is deliberately NOT called here; it only happens if the user
        // confirms, so a cancelled run leaves no trace in the undo stack.
        const beforeSnapshot = this._serializeSnapshot();
        this._scPendingSnapshot = beforeSnapshot;

        const rows = this._ttCompute(io);
        const n = io.inputs.length;
        const labels = io.inputs.map(i=> i.label);
        const spacingX = 170, spacingY = 110;

        const selected = this.selection && this.selection.selectedComponents;
        const scoped = selected && selected.size > 0 ? selected : null;
        const scopeComps = [...this.model.components.values()].filter(c=> !scoped || scoped.has(c.id));

        const toDelete = scopeComps.filter(c=> c.type!=='VARIABLE' && c.type!=='LED' && c.type!=='PROBE');
        const beforeCount = toDelete.length;

        // Before-stats for wiring/connections are measured against an
        // independent model deserialized from beforeSnapshot (rather than
        // the live model, which is about to be mutated) using the exact
        // same router the canvas uses, so the numbers reflect real routed
        // wire length, not a straight-line guess.
        const toDeleteIds = new Set(toDelete.map(c=> c.id));
        const beforeModel = CircuitModel.deserialize(beforeSnapshot);
        let beforeWireCount = 0, beforeWireLength = 0;
        for(const w of beforeModel.wires.values()){
          if(toDeleteIds.has(w.fromComp) || toDeleteIds.has(w.toComp)){
            beforeWireCount++;
            beforeWireLength += this._scRoutedWireLength(beforeModel, w);
          }
        }

        for(const c of toDelete){
          this.model.removeComponent(c.id);
          const node = this.views.get(c.id);
          if(node){ node.remove(); this.views.delete(c.id); }
        }

        const varIdByLabel = new Map();
        for(const c of this.model.components.values()){
          if(c.type !== 'VARIABLE') continue;
          const lbl = (c.label||'').trim().toUpperCase();
          if(!varIdByLabel.has(lbl)) varIdByLabel.set(lbl, c.id);
        }

        const newSelected = new Set();
        let afterCount = 0;
        let skipped = 0;
        const previewOutputs = [];   // one rendered-preview entry per rebuilt output

        outIdxs.forEach(outIdx=>{
          const outInfo = io.outputs[outIdx];
          const outComp = this.model.getComponent(outInfo.id);
          if(!outComp){ skipped++; return; }

          const values = new Array(1 << n).fill(0);
          rows.forEach(row=>{
            const mask = KMapEngine.bitsToMask(row.bits);
            values[mask] = row.outs[outIdx];
          });
          const { simplified } = this._ceAnalyzeOutput(n, labels, values);

          let built;
          try{
            const ast = BoolExprParser.parse(simplified, labels);
            built = BoolExprParser.toNodes(ast);
          }catch(e){ skipped++; return; }
          const { nodes, outRef, varNames } = built;

          const varIds = varNames.map(name=> varIdByLabel.get(name.trim().toUpperCase()));
          if(varIds.some(id=> !id)){ skipped++; return; }

          const depth = new Array(nodes.length).fill(0);
          for(let idx=0; idx<nodes.length; idx++){
            let d = 0;
            for(const ref of nodes[idx].in){ if(ref.node !== undefined) d = Math.max(d, depth[ref.node]+1); }
            depth[idx] = d;
          }
          const maxDepth = nodes.length ? depth.reduce((a,b)=>Math.max(a,b), 0) : 0;

          const varY = varNames.map(name=>{
            const vc = this.model.getComponent(varIdByLabel.get(name.trim().toUpperCase()));
            return vc ? vc.y : outComp.y;
          });
          const usesConst = new Set();
          nodes.forEach(nd=> nd.in.forEach(ref=>{ if(ref.const!==undefined) usesConst.add(ref.const); }));
          if(outRef.const !== undefined) usesConst.add(outRef.const);
          const constOrder = [...usesConst].sort();
          const constY = {};
          constOrder.forEach((v,i)=> constY[v] = i*spacingY);

          const yOf = (ref)=>{
            if(ref.node !== undefined) return finalY[ref.node];
            if(ref.var !== undefined) return varY[ref.var];
            return constY[ref.const];
          };
          const finalY = new Array(nodes.length).fill(0);
          for(let d=0; d<=maxDepth; d++){
            const colIdxs = [];
            for(let idx=0; idx<nodes.length; idx++) if(depth[idx]===d) colIdxs.push(idx);
            const raw = colIdxs.map(idx=>{
              const refsY = nodes[idx].in.map(yOf);
              return refsY.length ? refsY.reduce((a,b)=>a+b,0)/refsY.length : 0;
            });
            const order = colIdxs.map((idx,i)=>({idx, raw: raw[i]})).sort((a,b)=>a.raw-b.raw);
            let prev = -Infinity;
            for(const item of order){
              let y = item.raw;
              if(prev !== -Infinity && y < prev + spacingY) y = prev + spacingY;
              finalY[item.idx] = y;
              prev = y;
            }
          }

          const gateBaseX = outComp.x - (maxDepth+1)*spacingX;
          const outRefY = yOf(outRef);
          const yShift = outComp.y - outRefY;

          const plannedRects = [];
          constOrder.forEach(v=>{
            const def = GateLibrary[v===1 ? 'HIGH' : 'LOW'];
            plannedRects.push({ x: gateBaseX - spacingX, y: constY[v]+yShift, w: def.w, h: def.h });
          });
          nodes.forEach((node, idx)=>{
            const def = GateLibrary[node.type];
            plannedRects.push({ x: gateBaseX + depth[idx]*spacingX, y: finalY[idx]+yShift, w: def.w, h: def.h });
          });
          let dx = 0, dy = 0;
          if(plannedRects.length){
            const placement = this._findFreeBlockOffset(plannedRects);
            if(placement.ok){ dx = placement.dx; dy = placement.dy; }
          }

          const constIds = {};
          constOrder.forEach(v=>{
            const c = new CircuitComponent(v===1 ? 'HIGH' : 'LOW', gateBaseX-spacingX+dx, constY[v]+yShift+dy);
            this.model.addComponent(c);
            this.views.set(c.id, ComponentView.create(c, this.el.world));
            newSelected.add(c.id);
            constIds[v] = c.id;
          });

          const srcOf = (ref)=>{
            if(ref.node !== undefined) return { comp: newIds[ref.node], pin: GateLibrary[nodes[ref.node].type].outputs[0].id };
            if(ref.var !== undefined) return { comp: varIds[ref.var], pin: 'out' };
            return { comp: constIds[ref.const], pin: 'out' };
          };
          const newIds = nodes.map((node, idx)=>{
            const c = new CircuitComponent(node.type, gateBaseX+depth[idx]*spacingX+dx, finalY[idx]+yShift+dy);
            this.model.addComponent(c);
            this.views.set(c.id, ComponentView.create(c, this.el.world));
            newSelected.add(c.id);
            return c.id;
          });
          const outputWireObjs = [];
          nodes.forEach((node, idx)=>{
            const destId = newIds[idx];
            const destDef = this.model.getComponent(destId).def;
            node.in.forEach((ref, k)=>{
              const src = srcOf(ref);
              const w = this.model.addWire(new CircuitWire(src.comp, src.pin, destId, destDef.inputs[k].id));
              if(w) outputWireObjs.push(w);
            });
          });
          const finalSrc = srcOf(outRef);
          const finalWire = this.model.addWire(new CircuitWire(finalSrc.comp, finalSrc.pin, outComp.id, 'a'));
          if(finalWire) outputWireObjs.push(finalWire);

          varIds.forEach(id=> newSelected.add(id));
          newSelected.add(outComp.id);
          afterCount += nodes.length + constOrder.length;

          // Collect this output's rebuilt cone -- the exact same live
          // component/wire objects just created above (not copies), for the
          // real-renderer preview image + router-based wire-length stats.
          const outputCompIds = [
            ...constOrder.map(v=> constIds[v]),
            ...varIds,
            ...newIds,
            outComp.id
          ];
          previewOutputs.push({ label: outInfo.defaultName || outComp.label || `Output ${outIdx+1}`, compIds: outputCompIds, wires: outputWireObjs });
        });

        this.selection.selectedComponents = newSelected;
        this.selection.selectedWires.clear();
        this.runSimulation();
        this._refreshAll();
        // NOTE: no history.commit() here -- the rebuild is live on canvas
        // (so the preview below reflects reality) but stays uncommitted
        // until the user clicks "Confirm" in the results panel. "Cancel"
        // instead restores this._scPendingSnapshot, undoing it entirely.

        let afterWireCount = 0, afterWireLength = 0;
        previewOutputs.forEach(po=> po.wires.forEach(w=>{
          afterWireCount++;
          afterWireLength += this._scRoutedWireLength(this.model, w);
        }));

        const previewImages = await Promise.all(
          previewOutputs.map(po=> this._scRenderPreviewImage(po.compIds, po.wires))
        );

        const resultsBody = document.getElementById('simplifycirc-results-body');
        resultsBody.innerHTML = `
          <div class="sc-stats-grid">
            ${this._scStatBlock('Gates', beforeCount, afterCount)}
            ${this._scStatBlock('Connections', beforeWireCount, afterWireCount)}
            ${this._scWiringStatBlock(beforeWireLength, afterWireLength)}
          </div>
          ${previewOutputs.map((po, i)=> `
            <div class="sc-preview-card">
              <div class="sc-preview-title">${this._ttEscape(po.label)}</div>
              ${previewImages[i]}
            </div>
          `).join('')}
          ${skipped ? `<div style="font-size:11.5px; color:#c0392b; font-weight:700;">${skipped} output${skipped===1?'':'s'} couldn't be rebuilt and were left disconnected -- Cancel below to restore the original circuit and try again.</div>` : ''}
        `;
        document.getElementById('simplifycirc-dialog').style.width = '560px';
        document.getElementById('simplifycirc-loading').style.display = 'none';
        document.getElementById('simplifycirc-results').style.display = 'flex';
      }catch(err){
        // Roll back anything that was already applied before the error --
        // the user should never be left with a half-rebuilt circuit.
        if(this._scPendingSnapshot){
          try{ this._restoreSnapshot(this._scPendingSnapshot); }catch(e2){}
          this._scPendingSnapshot = null;
        }
        document.getElementById('simplifycirc-loading').style.display = 'none';
        document.getElementById('simplifycirc-setup-form').style.display = 'flex';
        document.getElementById('simplifycirc-error').style.display = 'flex';
        document.getElementById('simplifycirc-error-msg').textContent = 'Unexpected error: ' + err.message;
      }
    }, 450 + Math.random()*250);
  },
  // =====================================================================
  // SIMPLIFY BOOLEAN EXPRESSION
  // Standalone algebra tool — no circuit involved. The typed expression
  // is parsed with the same BoolExprParser used everywhere else, then
  // evaluated directly (via _evalBoolAst) over every combination of its
  // variables to build a truth table in memory, which _ceAnalyzeOutput
  // (already used by the Circuit-to-Expression tool) reduces with the
  // same Quine–McCluskey + XOR-pairing pipeline as the K-map tool.
  // =====================================================================
  openSimplifyExprTool(){
    const overlay = document.getElementById('simplify-overlay');
    const input = document.getElementById('simp-input');
    const errBox = document.getElementById('simp-error');
    const padWrap = document.getElementById('simp-pad');
    const toggleBtn = document.getElementById('simp-toggle-pad');
    const toggleIcon = document.getElementById('simp-toggle-icon');
    const toggleLabel = document.getElementById('simp-toggle-label');
    const fnWrap = document.getElementById('simp-pad-fn');
    const lettersWrap = document.getElementById('simp-pad-letters');
    const bottomWrap = document.getElementById('simp-pad-bottom');

    document.getElementById('simp-form').style.display = 'flex';
    document.getElementById('simp-loading').style.display = 'none';
    document.getElementById('simp-results').style.display = 'none';
    document.getElementById('simp-error-panel').style.display = 'none';
    errBox.style.display = 'none';
    input.value = '';
    overlay.style.display = 'flex';
    setTimeout(()=>input.focus(), 30);

    const insertAtCursor = (text)=>{
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const caret = start + text.length;
      input.focus();
      input.setSelectionRange(caret, caret);
    };
    const makeKey = (label, cls, onClick)=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'boolexpr-key ' + cls;
      btn.textContent = label;
      btn.onclick = onClick;
      return btn;
    };
    const makeGateKey = (symbol, name, insert)=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'boolexpr-key boolexpr-key-fn';
      btn.title = name;
      const sym = document.createElement('span');
      sym.className = 'boolexpr-key-symbol';
      sym.textContent = symbol;
      const nm = document.createElement('span');
      nm.className = 'boolexpr-key-name';
      nm.textContent = name;
      btn.appendChild(sym);
      btn.appendChild(nm);
      btn.onclick = ()=> insertAtCursor(insert);
      return btn;
    };

    fnWrap.innerHTML = '';
    [
      ['×','AND'], ['+','OR'], ["×'",'NAND'], ["+'",'NOR'],
      ['⊕','XOR'], ["⊕'",'XNOR'], ["'",'NOT'],
    ].forEach(([symbol, name])=>{
      fnWrap.appendChild(makeGateKey(symbol, name, symbol));
    });

    lettersWrap.innerHTML = '';
    for(let i=0; i<26; i++){
      const letter = String.fromCharCode(65+i);
      lettersWrap.appendChild(makeKey(letter, 'boolexpr-key-letter', ()=> insertAtCursor(letter)));
    }

    bottomWrap.innerHTML = '';
    [['(','boolexpr-key-sym'], [')','boolexpr-key-sym'], ["'",'boolexpr-key-sym'],
     ['0','boolexpr-key-digit'], ['1','boolexpr-key-digit']].forEach(([label, cls])=>{
      bottomWrap.appendChild(makeKey(label, cls, ()=> insertAtCursor(label)));
    });
    bottomWrap.appendChild(makeKey('⌫', 'boolexpr-key-util', ()=>{
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      if(start===end && start>0) input.value = input.value.slice(0,start-1) + input.value.slice(start);
      else input.value = input.value.slice(0,start) + input.value.slice(end);
      const caret = start===end ? Math.max(0,start-1) : start;
      input.focus();
      input.setSelectionRange(caret, caret);
    }));
    bottomWrap.appendChild(makeKey('C', 'boolexpr-key-util', ()=>{ input.value = ''; input.focus(); }));

    let padOpen = true;
    const applyPadState = ()=>{
      padWrap.style.display = padOpen ? 'block' : 'none';
      toggleIcon.style.transform = padOpen ? 'rotate(0deg)' : 'rotate(-180deg)';
      toggleLabel.textContent = padOpen ? 'Hide keypad' : 'Show keypad';
    };
    applyPadState();
    toggleBtn.onclick = ()=>{
      padOpen = !padOpen;
      applyPadState();
      if(!padOpen) input.focus();
    };

    const showError = (msg)=>{ errBox.textContent = msg; errBox.style.display = 'block'; };
    const submit = ()=>{
      const expr = input.value.trim();
      if(!expr){ showError('Enter a boolean expression first.'); return; }
      errBox.style.display = 'none';
      this._simplifyRun(expr);
    };
    document.getElementById('simp-generate').onclick = submit;
    input.onkeydown = (e)=>{
      if(e.key==='Enter'){ e.preventDefault(); submit(); }
      else if(e.key==='Escape'){ e.preventDefault(); document.getElementById('simplify-overlay').style.display = 'none'; }
    };
  },
  _bindSimplifyExprTool(){
    const overlay = document.getElementById('simplify-overlay');
    const close = ()=>{ overlay.style.display = 'none'; };
    const backToForm = ()=>{
      document.getElementById('simp-results').style.display = 'none';
      document.getElementById('simp-error-panel').style.display = 'none';
      document.getElementById('simp-form').style.display = 'flex';
      setTimeout(()=>document.getElementById('simp-input').focus(), 30);
    };
    document.getElementById('simp-cancel').onclick = close;
    document.getElementById('simp-results-close').onclick = close;
    document.getElementById('simp-results-back').onclick = backToForm;
    document.getElementById('simp-error-back').onclick = backToForm;
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
    document.getElementById('simplify-dialog').addEventListener('click', (e)=> e.stopPropagation());
  },
  /** Directly evaluates a BoolExprParser AST node against a variable
   *  assignment (name -> 0/1), without ever touching the canvas/model —
   *  used to brute-force a truth table straight from typed text so the
   *  Simplify tool works even when nothing has been built yet. */
  _evalBoolAst(node, assign){
    switch(node.op){
      case 'VAR': return assign[node.name] ? 1 : 0;
      case 'CONST': return node.value ? 1 : 0;
      case 'NOT': return this._evalBoolAst(node.a, assign) ? 0 : 1;
      case 'AND': return (this._evalBoolAst(node.a, assign) && this._evalBoolAst(node.b, assign)) ? 1 : 0;
      case 'NAND': return (this._evalBoolAst(node.a, assign) && this._evalBoolAst(node.b, assign)) ? 0 : 1;
      case 'OR': return (this._evalBoolAst(node.a, assign) || this._evalBoolAst(node.b, assign)) ? 1 : 0;
      case 'NOR': return (this._evalBoolAst(node.a, assign) || this._evalBoolAst(node.b, assign)) ? 0 : 1;
      case 'XOR': return (this._evalBoolAst(node.a, assign) ^ this._evalBoolAst(node.b, assign)) ? 1 : 0;
      case 'XNOR': return (this._evalBoolAst(node.a, assign) ^ this._evalBoolAst(node.b, assign)) ? 0 : 1;
      default: throw new Error('Unknown expression node "' + node.op + '".');
    }
  },
  _simplifyRun(expr){
    document.getElementById('simp-form').style.display = 'none';
    document.getElementById('simp-error-panel').style.display = 'none';
    document.getElementById('simp-loading').style.display = 'flex';
    setTimeout(()=>{
      try{
        const ast = BoolExprParser.parse(expr);
        const varNames = BoolExprParser.toNodes(ast).varNames;
        const n = varNames.length;
        const MAX_INPUTS = 12;
        if(n > MAX_INPUTS){
          throw new Error(`This expression has ${n} variables — that's too many to brute-force a truth table from (max ${MAX_INPUTS}).`);
        }
        let canonical, simplified;
        if(n === 0){
          const v = this._evalBoolAst(ast, {});
          canonical = String(v); simplified = String(v);
        } else {
          const total = 1 << n;
          const values = new Array(total);
          for(let m=0; m<total; m++){
            const bits = KMapEngine.toBits(m, n);
            const assign = {};
            varNames.forEach((name,i)=>{ assign[name] = bits[i]; });
            values[m] = this._evalBoolAst(ast, assign);
          }
          ({ canonical, simplified } = this._ceAnalyzeOutput(n, varNames, values));
        }
        const body = document.getElementById('simp-results-body');
        body.innerHTML = '';
        const showCanon = canonical !== simplified;
        const card = document.createElement('div');
        card.className = 'circexpr-result-card';
        card.innerHTML = `
          <div class="circexpr-result-label">Simplified expression</div>
          <div class="circexpr-result-expr">${this._ttEscape(simplified)}</div>
          ${showCanon ? `<div class="circexpr-result-label">Sum of minterms (original form)</div><div class="circexpr-result-canon">${this._ttEscape(canonical)}</div>` : ''}
          <div class="circexpr-result-actions">
            <button class="circexpr-btn simp-copy-btn">Copy</button>
            <button class="circexpr-btn simp-build-btn">Plot circuit</button>
          </div>`;
        const copyBtn = card.querySelector('.simp-copy-btn');
        copyBtn.onclick = ()=>{
          this._ceCopyText(simplified);
          copyBtn.textContent = 'Copied';
          copyBtn.classList.add('copied');
          setTimeout(()=>{ copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1200);
        };
        card.querySelector('.simp-build-btn').onclick = ()=>{
          document.getElementById('simplify-overlay').style.display = 'none';
          this.openBoolExprTool(simplified, n>0 ? varNames : null);
        };
        body.appendChild(card);
        document.getElementById('simp-loading').style.display = 'none';
        document.getElementById('simp-results').style.display = 'flex';
      }catch(err){
        document.getElementById('simp-loading').style.display = 'none';
        document.getElementById('simp-error-panel').style.display = 'flex';
        document.getElementById('simp-error-panel-msg').textContent = err.message || 'Could not parse that expression.';
      }
    }, 350 + Math.random()*200);
  },
  // =====================================================================
  // SOP <-> POS CONVERTER
  // Same brute-force-truth-table approach as Simplify Boolean Expression
  // (parse -> _evalBoolAst over every combination -> KMapEngine), but
  // reports both the Sum-of-Products side (_ceAnalyzeOutput) and the
  // Product-of-Sums side (_cePosAnalyzeOutput) for the typed expression,
  // whichever form it was originally written in.
  // =====================================================================
  openSopPosTool(){
    const overlay = document.getElementById('sop-pos-overlay');
    const input = document.getElementById('sp-input');
    const errBox = document.getElementById('sp-error');
    const padWrap = document.getElementById('sp-pad');
    const toggleBtn = document.getElementById('sp-toggle-pad');
    const toggleIcon = document.getElementById('sp-toggle-icon');
    const toggleLabel = document.getElementById('sp-toggle-label');
    const fnWrap = document.getElementById('sp-pad-fn');
    const lettersWrap = document.getElementById('sp-pad-letters');
    const bottomWrap = document.getElementById('sp-pad-bottom');

    document.getElementById('sp-form').style.display = 'flex';
    document.getElementById('sp-loading').style.display = 'none';
    document.getElementById('sp-results').style.display = 'none';
    document.getElementById('sp-error-panel').style.display = 'none';
    errBox.style.display = 'none';
    input.value = '';
    overlay.style.display = 'flex';
    setTimeout(()=>input.focus(), 30);

    const insertAtCursor = (text)=>{
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const caret = start + text.length;
      input.focus();
      input.setSelectionRange(caret, caret);
    };
    const makeKey = (label, cls, onClick)=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'boolexpr-key ' + cls;
      btn.textContent = label;
      btn.onclick = onClick;
      return btn;
    };
    const makeGateKey = (symbol, name, insert)=>{
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'boolexpr-key boolexpr-key-fn';
      btn.title = name;
      const sym = document.createElement('span');
      sym.className = 'boolexpr-key-symbol';
      sym.textContent = symbol;
      const nm = document.createElement('span');
      nm.className = 'boolexpr-key-name';
      nm.textContent = name;
      btn.appendChild(sym);
      btn.appendChild(nm);
      btn.onclick = ()=> insertAtCursor(insert);
      return btn;
    };

    fnWrap.innerHTML = '';
    [
      ['×','AND'], ['+','OR'], ["×'",'NAND'], ["+'",'NOR'],
      ['⊕','XOR'], ["⊕'",'XNOR'], ["'",'NOT'],
    ].forEach(([symbol, name])=>{
      fnWrap.appendChild(makeGateKey(symbol, name, symbol));
    });

    lettersWrap.innerHTML = '';
    for(let i=0; i<26; i++){
      const letter = String.fromCharCode(65+i);
      lettersWrap.appendChild(makeKey(letter, 'boolexpr-key-letter', ()=> insertAtCursor(letter)));
    }

    bottomWrap.innerHTML = '';
    [['(','boolexpr-key-sym'], [')','boolexpr-key-sym'], ["'",'boolexpr-key-sym'],
     ['0','boolexpr-key-digit'], ['1','boolexpr-key-digit']].forEach(([label, cls])=>{
      bottomWrap.appendChild(makeKey(label, cls, ()=> insertAtCursor(label)));
    });
    bottomWrap.appendChild(makeKey('⌫', 'boolexpr-key-util', ()=>{
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      if(start===end && start>0) input.value = input.value.slice(0,start-1) + input.value.slice(start);
      else input.value = input.value.slice(0,start) + input.value.slice(end);
      const caret = start===end ? Math.max(0,start-1) : start;
      input.focus();
      input.setSelectionRange(caret, caret);
    }));
    bottomWrap.appendChild(makeKey('C', 'boolexpr-key-util', ()=>{ input.value = ''; input.focus(); }));

    let padOpen = true;
    const applyPadState = ()=>{
      padWrap.style.display = padOpen ? 'block' : 'none';
      toggleIcon.style.transform = padOpen ? 'rotate(0deg)' : 'rotate(-180deg)';
      toggleLabel.textContent = padOpen ? 'Hide keypad' : 'Show keypad';
    };
    applyPadState();
    toggleBtn.onclick = ()=>{
      padOpen = !padOpen;
      applyPadState();
      if(!padOpen) input.focus();
    };

    const showError = (msg)=>{ errBox.textContent = msg; errBox.style.display = 'block'; };
    const submit = ()=>{
      const expr = input.value.trim();
      if(!expr){ showError('Enter a boolean expression first.'); return; }
      errBox.style.display = 'none';
      this._sopPosRun(expr);
    };
    document.getElementById('sp-generate').onclick = submit;
    input.onkeydown = (e)=>{
      if(e.key==='Enter'){ e.preventDefault(); submit(); }
      else if(e.key==='Escape'){ e.preventDefault(); document.getElementById('sop-pos-overlay').style.display = 'none'; }
    };
  },
  _bindSopPosTool(){
    const overlay = document.getElementById('sop-pos-overlay');
    const close = ()=>{ overlay.style.display = 'none'; };
    const backToForm = ()=>{
      document.getElementById('sp-results').style.display = 'none';
      document.getElementById('sp-error-panel').style.display = 'none';
      document.getElementById('sp-form').style.display = 'flex';
      setTimeout(()=>document.getElementById('sp-input').focus(), 30);
    };
    document.getElementById('sp-cancel').onclick = close;
    document.getElementById('sp-results-close').onclick = close;
    document.getElementById('sp-results-back').onclick = backToForm;
    document.getElementById('sp-error-back').onclick = backToForm;
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
    document.getElementById('sop-pos-dialog').addEventListener('click', (e)=> e.stopPropagation());
  },
  /** Builds one result card (label + expression + optional canonical line
   *  + Copy/Build actions) for either the SOP or POS side of the SOP<->POS
   *  converter's results panel. */
  _spMakeCard(sectionLabel, canonForm, canonLabel, simplified, varNames, n){
    const card = document.createElement('div');
    card.className = 'circexpr-result-card';
    const showCanon = canonForm !== simplified;
    card.innerHTML = `
      <div class="circexpr-result-name">${this._ttEscape(sectionLabel)}</div>
      <div class="circexpr-result-label">Minimized</div>
      <div class="circexpr-result-expr">${this._ttEscape(simplified)}</div>
      ${showCanon ? `<div class="circexpr-result-label">${this._ttEscape(canonLabel)}</div><div class="circexpr-result-canon">${this._ttEscape(canonForm)}</div>` : ''}
      <div class="circexpr-result-actions">
        <button class="circexpr-btn sp-copy-btn">Copy</button>
        <button class="circexpr-btn sp-build-btn">Plot circuit</button>
      </div>`;
    const copyBtn = card.querySelector('.sp-copy-btn');
    copyBtn.onclick = ()=>{
      this._ceCopyText(simplified);
      copyBtn.textContent = 'Copied';
      copyBtn.classList.add('copied');
      setTimeout(()=>{ copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1200);
    };
    card.querySelector('.sp-build-btn').onclick = ()=>{
      document.getElementById('sop-pos-overlay').style.display = 'none';
      this.openBoolExprTool(simplified, n>0 ? varNames : null);
    };
    return card;
  },
  _sopPosRun(expr){
    document.getElementById('sp-form').style.display = 'none';
    document.getElementById('sp-error-panel').style.display = 'none';
    document.getElementById('sp-loading').style.display = 'flex';
    setTimeout(()=>{
      try{
        const ast = BoolExprParser.parse(expr);
        const varNames = BoolExprParser.toNodes(ast).varNames;
        const n = varNames.length;
        const MAX_INPUTS = 12;
        if(n > MAX_INPUTS){
          throw new Error(`This expression has ${n} variables — that's too many to brute-force a truth table from (max ${MAX_INPUTS}).`);
        }
        let sop, pos;
        if(n === 0){
          const v = String(this._evalBoolAst(ast, {}));
          sop = { canonical: v, simplified: v };
          pos = { canonicalPOS: v, simplifiedPOS: v };
        } else {
          const total = 1 << n;
          const values = new Array(total);
          for(let m=0; m<total; m++){
            const bits = KMapEngine.toBits(m, n);
            const assign = {};
            varNames.forEach((name,i)=>{ assign[name] = bits[i]; });
            values[m] = this._evalBoolAst(ast, assign);
          }
          sop = this._ceAnalyzeOutput(n, varNames, values);
          pos = this._cePosAnalyzeOutput(n, varNames, values);
        }
        const body = document.getElementById('sp-results-body');
        body.innerHTML = '';
        body.appendChild(this._spMakeCard('Sum of Products (SOP)', sop.canonical, 'Sum of minterms (canonical SOP)', sop.simplified, varNames, n));
        body.appendChild(this._spMakeCard('Product of Sums (POS)', pos.canonicalPOS, 'Product of maxterms (canonical POS)', pos.simplifiedPOS, varNames, n));
        document.getElementById('sp-loading').style.display = 'none';
        document.getElementById('sp-results').style.display = 'flex';
      }catch(err){
        document.getElementById('sp-loading').style.display = 'none';
        document.getElementById('sp-error-panel').style.display = 'flex';
        document.getElementById('sp-error-panel-msg').textContent = err.message || 'Could not parse that expression.';
      }
    }, 350 + Math.random()*200);
  },
  /** Cycles a K-map/truth-table cell value: 0 -> 1 -> X (null, don't-care)
   *  -> back to 0. Shared by the K-map-to-Circuit and Truth-Table-to-
   *  Circuit tools. */
  _boolCycleValue(v){ return v===0 ? 1 : (v===1 ? null : 0); },
  /** Validates a list of variable names typed into either manual-entry
   *  tool: every name must be non-empty, start with a letter/underscore
   *  and contain only letters/digits/underscores after that (so it round-
   *  trips cleanly through BoolExprParser as a single identifier), and no
   *  two names may collide case-insensitively. Returns {ok:true} or
   *  {ok:false, error}. */
  _boolValidateVarNames(names){
    const seen = new Set();
    for(const name of names){
      if(!name) return { ok:false, error:'Every variable needs a name.' };
      if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return { ok:false, error:`"${name}" isn't a valid variable name — use letters, digits, or underscores, starting with a letter.` };
      const key = name.toUpperCase();
      if(seen.has(key)) return { ok:false, error:`Variable name "${name}" is used more than once.` };
      seen.add(key);
    }
    return { ok:true };
  },
  /** Builds `count` small text inputs (class `inputClass`) inside
   *  `container`, pre-filled with default letter names A, B, C… (reused
   *  as fallback names past Z: A2, B2, …). Preserves any names the user
   *  already typed for the indices that still exist when the count
   *  changes. */
  _boolRenderNameInputs(container, count, inputClass){
    const prior = [...container.querySelectorAll('input')].map(i=> i.value);
    container.innerHTML = '';
    for(let i=0;i<count;i++){
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'tt-row-input ' + inputClass;
      input.maxLength = 12;
      const letter = String.fromCharCode(65 + (i % 26));
      const suffix = i >= 26 ? String(Math.floor(i/26)+1) : '';
      input.value = prior[i] || (letter + suffix);
      container.appendChild(input);
    }
  },

  // ---- K-MAP TO CIRCUIT ----
  openKMapToCircuitTool(){
    document.getElementById('km2c-setup-error').style.display = 'none';
    document.getElementById('km2c-grid-panel').style.display = 'none';
    document.getElementById('km2c-setup').style.display = 'flex';
    const countSel = document.getElementById('km2c-varcount');
    countSel.value = '3';
    this._boolRenderNameInputs(document.getElementById('km2c-varnames'), 3, 'km2c-name-input');
    document.getElementById('km2c-overlay').style.display = 'flex';
  },
  _bindKMapToCircuitTool(){
    const overlay = document.getElementById('km2c-overlay');
    const close = ()=>{ overlay.style.display = 'none'; };
    document.getElementById('km2c-setup-cancel').onclick = close;
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
    document.getElementById('km2c-dialog').addEventListener('click', (e)=> e.stopPropagation());

    document.getElementById('km2c-varcount').onchange = (e)=>{
      this._boolRenderNameInputs(document.getElementById('km2c-varnames'), parseInt(e.target.value,10), 'km2c-name-input');
    };

    document.getElementById('km2c-setup-next').onclick = ()=>{
      const errBox = document.getElementById('km2c-setup-error');
      errBox.style.display = 'none';
      const names = [...document.querySelectorAll('.km2c-name-input')].map(i=> i.value.trim());
      const check = this._boolValidateVarNames(names);
      if(!check.ok){ errBox.textContent = check.error; errBox.style.display = 'block'; return; }
      const outputType = document.querySelector('input[name="km2c-output-type"]:checked').value;
      this._km2cState = { names, outputType, values: new Array(1 << names.length).fill(0) };
      this._km2cRenderGrid();
      document.getElementById('km2c-setup').style.display = 'none';
      document.getElementById('km2c-grid-panel').style.display = 'flex';
    };
    document.getElementById('km2c-grid-back').onclick = ()=>{
      document.getElementById('km2c-grid-panel').style.display = 'none';
      document.getElementById('km2c-setup').style.display = 'flex';
    };
    document.getElementById('km2c-grid-generate').onclick = ()=>{
      const errBox = document.getElementById('km2c-grid-error');
      errBox.style.display = 'none';
      const { names, outputType, values } = this._km2cState;
      const n = names.length;
      const { simplified } = this._ceAnalyzeOutput(n, names, values);
      const result = this._buildCircuitFromBoolExpr(simplified, outputType, names);
      if(!result.ok){ errBox.textContent = result.error; errBox.style.display = 'block'; return; }
      close();
    };
  },
  _km2cRenderGrid(){
    const { names, values } = this._km2cState;
    const n = names.length;
    const grid = KMapEngine.buildGrid(n, names, values);
    const ra = grid.rowLabels.join(''), ca = grid.colLabels.join('');
    let html = `<table class="km-table" style="border-collapse:collapse;"><thead><tr>`;
    html += `<th class="km-cell" style="background:#0a1d33;vertical-align:middle;"><span class="km-axis-label" style="color:#9fd8ff;font-size:9.5px;">${this._ttEscape(ra)}\\${this._ttEscape(ca)}</span></th>`;
    grid.colHeaderLabels.forEach(c=> html += `<th class="km-cell" style="background:#123e91;color:#cfe2ff;">${c}</th>`);
    html += '</tr></thead><tbody>';
    for(let r=0;r<grid.rows;r++){
      html += `<tr><th class="km-cell" style="background:#0f2a4a;color:#f5f8fc;">${grid.rowHeaderLabels[r]}</th>`;
      for(let c=0;c<grid.cols;c++){
        const cell = grid.cells.find(cc=> cc.r===r && cc.c===c);
        const v = cell.value;
        const txt = v===null ? 'X' : v;
        const valColor = v===1?'#0f2a4a':(v===0?'#8a93a1':'#c4892f');
        html += `<td class="km-cell km2c-cell-editable" data-mask="${cell.mask}">
          <span class="km-cell-mt">${cell.mask}</span>
          <span class="km-cell-val" style="color:${valColor};">${txt}</span>
        </td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('km2c-grid-wrap').innerHTML = html;
    document.querySelectorAll('#km2c-grid-wrap td[data-mask]').forEach(td=>{
      td.onclick = ()=>{
        const mask = parseInt(td.dataset.mask, 10);
        this._km2cState.values[mask] = this._boolCycleValue(this._km2cState.values[mask]);
        this._km2cRenderGrid();
      };
    });
    this._km2cUpdatePreview();
  },
  _km2cUpdatePreview(){
    const { names, values } = this._km2cState;
    const { simplified } = this._ceAnalyzeOutput(names.length, names, values);
    document.getElementById('km2c-preview').textContent = simplified;
  },

  // ---- K-MAP <-> TRUTH TABLE ----
  openKMapTruthTableTool(){
    document.getElementById('kmtt-setup-error').style.display = 'none';
    document.getElementById('kmtt-view-panel').style.display = 'none';
    document.getElementById('kmtt-setup').style.display = 'flex';
    document.getElementById('kmtt-varcount').value = '3';
    this._boolRenderNameInputs(document.getElementById('kmtt-varnames'), 3, 'kmtt-name-input');
    // Reset any manual resize (drag corner) or expand-toggle sizing from a
    // previous session back to the default box before showing it again.
    const dialog = document.getElementById('kmtt-dialog');
    dialog.style.width = this._KMTT_DEFAULT_W;
    dialog.style.height = this._KMTT_DEFAULT_H;
    this._kmttExpanded = false;
    const expandBtn = document.getElementById('kmtt-expand-toggle');
    if(expandBtn) expandBtn.textContent = '⤢ Expand';
    document.getElementById('kmtt-overlay').style.display = 'flex';
  },
  _KMTT_DEFAULT_W: '560px',
  _KMTT_DEFAULT_H: '600px',
  _bindKMapTruthTableTool(){
    const overlay = document.getElementById('kmtt-overlay');
    const dialog = document.getElementById('kmtt-dialog');
    const close = ()=>{ overlay.style.display = 'none'; };
    document.getElementById('kmtt-setup-cancel').onclick = close;
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
    dialog.addEventListener('click', (e)=> e.stopPropagation());

    const expandBtn = document.getElementById('kmtt-expand-toggle');
    expandBtn.onclick = ()=>{
      this._kmttExpanded = !this._kmttExpanded;
      if(this._kmttExpanded){
        dialog.style.width = '94vw';
        dialog.style.height = '94vh';
        expandBtn.textContent = '⤡ Collapse';
      } else {
        dialog.style.width = this._KMTT_DEFAULT_W;
        dialog.style.height = this._KMTT_DEFAULT_H;
        expandBtn.textContent = '⤢ Expand';
      }
    };

    document.getElementById('kmtt-varcount').onchange = (e)=>{
      this._boolRenderNameInputs(document.getElementById('kmtt-varnames'), parseInt(e.target.value,10), 'kmtt-name-input');
    };

    document.getElementById('kmtt-setup-next').onclick = ()=>{
      const errBox = document.getElementById('kmtt-setup-error');
      errBox.style.display = 'none';
      const names = [...document.querySelectorAll('.kmtt-name-input')].map(i=> i.value.trim());
      const check = this._boolValidateVarNames(names);
      if(!check.ok){ errBox.textContent = check.error; errBox.style.display = 'block'; return; }
      const outputType = document.querySelector('input[name="kmtt-output-type"]:checked').value;
      this._kmttState = { names, outputType, values: new Array(1 << names.length).fill(0) };
      this._kmttRenderAll();
      document.getElementById('kmtt-setup').style.display = 'none';
      document.getElementById('kmtt-view-panel').style.display = 'flex';
    };
    document.getElementById('kmtt-view-back').onclick = ()=>{
      document.getElementById('kmtt-view-panel').style.display = 'none';
      document.getElementById('kmtt-setup').style.display = 'flex';
    };
    document.getElementById('kmtt-view-build').onclick = ()=>{
      const errBox = document.getElementById('kmtt-view-error');
      errBox.style.display = 'none';
      const { names, outputType, values } = this._kmttState;
      const n = names.length;
      const { simplified } = this._ceAnalyzeOutput(n, names, values);
      const result = this._buildCircuitFromBoolExpr(simplified, outputType, names);
      if(!result.ok){ errBox.textContent = result.error; errBox.style.display = 'block'; return; }
      close();
    };
  },
  /** Sets one cell's value (by input mask) and re-renders both the K-map
   *  and truth-table views from the single shared state, keeping them in
   *  permanent sync — used by both views' click handlers. */
  _kmttSetValue(mask, value){
    this._kmttState.values[mask] = value;
    this._kmttRenderAll();
  },
  _kmttRenderAll(){
    this._kmttRenderGrid();
    this._kmttRenderTable();
    this._kmttUpdatePreview();
  },
  _kmttRenderGrid(){
    const { names, values } = this._kmttState;
    const n = names.length;
    const grid = KMapEngine.buildGrid(n, names, values);
    const ra = grid.rowLabels.join(''), ca = grid.colLabels.join('');
    let html = `<table class="km-table" style="border-collapse:collapse;"><thead><tr>`;
    html += `<th class="km-cell" style="background:#0a1d33;vertical-align:middle;"><span class="km-axis-label" style="color:#9fd8ff;font-size:9.5px;">${this._ttEscape(ra)}\\${this._ttEscape(ca)}</span></th>`;
    grid.colHeaderLabels.forEach(c=> html += `<th class="km-cell" style="background:#123e91;color:#cfe2ff;">${c}</th>`);
    html += '</tr></thead><tbody>';
    for(let r=0;r<grid.rows;r++){
      html += `<tr><th class="km-cell" style="background:#0f2a4a;color:#f5f8fc;">${grid.rowHeaderLabels[r]}</th>`;
      for(let c=0;c<grid.cols;c++){
        const cell = grid.cells.find(cc=> cc.r===r && cc.c===c);
        const v = cell.value;
        const txt = v===null ? 'X' : v;
        const valColor = v===1?'#0f2a4a':(v===0?'#8a93a1':'#c4892f');
        html += `<td class="km-cell km2c-cell-editable" data-mask="${cell.mask}">
          <span class="km-cell-mt">${cell.mask}</span>
          <span class="km-cell-val" style="color:${valColor};">${txt}</span>
        </td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('kmtt-grid-wrap').innerHTML = html;
    document.querySelectorAll('#kmtt-grid-wrap td[data-mask]').forEach(td=>{
      td.onclick = ()=>{
        const mask = parseInt(td.dataset.mask, 10);
        this._kmttSetValue(mask, this._boolCycleValue(this._kmttState.values[mask]));
      };
    });
  },
  _kmttRenderTable(){
    const { names, values } = this._kmttState;
    const n = names.length;
    const total = 1 << n;
    let html = `<table class="tt2c-row-table"><thead><tr>`;
    names.forEach(name=> html += `<th>${this._ttEscape(name)}</th>`);
    html += `<th>Out</th></tr></thead><tbody>`;
    for(let m=0;m<total;m++){
      const bits = KMapEngine.toBits(m, n);
      html += '<tr>';
      bits.forEach(b=> html += `<td>${b}</td>`);
      const v = values[m];
      const txt = v===null ? 'X' : v;
      const valColor = v===1?'#0f2a4a':(v===0?'#8a93a1':'#c4892f');
      html += `<td class="tt2c-out-col km2c-cell-editable" data-mask="${m}" style="color:${valColor};">${txt}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('kmtt-table-wrap').innerHTML = html;
    document.querySelectorAll('#kmtt-table-wrap td[data-mask]').forEach(td=>{
      td.onclick = ()=>{
        const mask = parseInt(td.dataset.mask, 10);
        this._kmttSetValue(mask, this._boolCycleValue(this._kmttState.values[mask]));
      };
    });
  },
  _kmttUpdatePreview(){
    const { names, values } = this._kmttState;
    const { simplified } = this._ceAnalyzeOutput(names.length, names, values);
    document.getElementById('kmtt-preview').textContent = simplified;
  },

  // ---- TRUTH TABLE TO CIRCUIT ----
  openTruthTableToCircuitTool(){
    document.getElementById('tt2c-setup-error').style.display = 'none';
    document.getElementById('tt2c-table-panel').style.display = 'none';
    document.getElementById('tt2c-setup').style.display = 'flex';
    document.getElementById('tt2c-varcount').value = '3';
    this._boolRenderNameInputs(document.getElementById('tt2c-varnames'), 3, 'tt2c-name-input');
    document.getElementById('tt2c-overlay').style.display = 'flex';
  },
  _bindTruthTableToCircuitTool(){
    const overlay = document.getElementById('tt2c-overlay');
    const close = ()=>{ overlay.style.display = 'none'; };
    document.getElementById('tt2c-setup-cancel').onclick = close;
    overlay.addEventListener('click', (e)=>{ if(e.target===overlay) close(); });
    document.getElementById('tt2c-dialog').addEventListener('click', (e)=> e.stopPropagation());

    document.getElementById('tt2c-varcount').onchange = (e)=>{
      this._boolRenderNameInputs(document.getElementById('tt2c-varnames'), parseInt(e.target.value,10), 'tt2c-name-input');
    };

    document.getElementById('tt2c-setup-next').onclick = ()=>{
      const errBox = document.getElementById('tt2c-setup-error');
      errBox.style.display = 'none';
      const names = [...document.querySelectorAll('.tt2c-name-input')].map(i=> i.value.trim());
      const check = this._boolValidateVarNames(names);
      if(!check.ok){ errBox.textContent = check.error; errBox.style.display = 'block'; return; }
      const outputType = document.querySelector('input[name="tt2c-output-type"]:checked').value;
      this._tt2cState = { names, outputType, values: new Array(1 << names.length).fill(0) };
      this._tt2cRenderTable();
      document.getElementById('tt2c-setup').style.display = 'none';
      document.getElementById('tt2c-table-panel').style.display = 'flex';
    };
    document.getElementById('tt2c-table-back').onclick = ()=>{
      document.getElementById('tt2c-table-panel').style.display = 'none';
      document.getElementById('tt2c-setup').style.display = 'flex';
    };
    document.getElementById('tt2c-table-generate').onclick = ()=>{
      const errBox = document.getElementById('tt2c-table-error');
      errBox.style.display = 'none';
      const { names, outputType, values } = this._tt2cState;
      const n = names.length;
      const { simplified } = this._ceAnalyzeOutput(n, names, values);
      const result = this._buildCircuitFromBoolExpr(simplified, outputType, names);
      if(!result.ok){ errBox.textContent = result.error; errBox.style.display = 'block'; return; }
      overlay.style.display = 'none';
    };
  },
  _tt2cRenderTable(){
    const { names, values } = this._tt2cState;
    const n = names.length;
    const total = 1 << n;
    let html = `<table class="tt2c-row-table"><thead><tr>`;
    names.forEach(name=> html += `<th>${this._ttEscape(name)}</th>`);
    html += `<th>Out</th></tr></thead><tbody>`;
    for(let m=0;m<total;m++){
      const bits = KMapEngine.toBits(m, n);
      html += '<tr>';
      bits.forEach(b=> html += `<td>${b}</td>`);
      const v = values[m];
      const txt = v===null ? 'X' : v;
      const valColor = v===1?'#0f2a4a':(v===0?'#8a93a1':'#c4892f');
      html += `<td class="tt2c-out-col km2c-cell-editable" data-mask="${m}" style="color:${valColor};">${txt}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    document.getElementById('tt2c-table-wrap').innerHTML = html;
    document.querySelectorAll('#tt2c-table-wrap td[data-mask]').forEach(td=>{
      td.onclick = ()=>{
        const mask = parseInt(td.dataset.mask, 10);
        this._tt2cState.values[mask] = this._boolCycleValue(this._tt2cState.values[mask]);
        this._tt2cRenderTable();
      };
    });
    this._tt2cUpdatePreview();
  },
  _tt2cUpdatePreview(){
    const { names, values } = this._tt2cState;
    const { simplified } = this._ceAnalyzeOutput(names.length, names, values);
    document.getElementById('tt2c-preview').textContent = simplified;
  },

  /** Pure Boolean-logic helper: given n input variables, their labels, and
   *  a fully-defined values array (length 2^n, every entry 0 or 1 — a real
   *  circuit has no don't-cares), returns both the canonical sum-of-
   *  minterms expression and the Quine–McCluskey-minimized one (with a
   *  pass over the result looking for pairs of terms that collapse into a
   *  single XOR/XNOR — see KMapEngine.xorReduce). Bypasses KMapEngine.
   *  analyze()'s 2–6 variable restriction (that limit is about what a
   *  K-map *grid* can lay out, not about minimization itself), and handles
   *  the 0-input (constant circuit) case KMapEngine doesn't. Terms use
   *  mathematical juxtaposition for AND (e.g. "AC'D") and ⊕/⊕' for XOR/
   *  XNOR, so the result can be pasted straight back into the Boolean
   *  Expression to Circuit tool and reproduce the same circuit — see
   *  BoolExprParser.tokenize's `knownVars` handling for how that round
   *  trip stays unambiguous. */
  _ceAnalyzeOutput(n, labels, values){
    if(n === 0) return { canonical: String(values[0]), simplified: String(values[0]) };
    const total = values.length;
    const onesIdx = [];
    for(let m=0;m<total;m++) if(values[m]===1) onesIdx.push(m);
    let canonical;
    if(onesIdx.length === 0) canonical = '0';
    else if(onesIdx.length === total) canonical = '1';
    else canonical = onesIdx.map(m=> KMapEngine.patternToTerm(KMapEngine.toBits(m,n).join(''), labels)).join(' + ');
    const minimized = KMapEngine.minimize(n, values);
    let simplified;
    if(minimized.allZero) simplified = '0';
    else if(minimized.allOnes) simplified = '1';
    else{
      const terms = KMapEngine.xorReduce(n, minimized.essential);
      simplified = terms.map(t=> KMapEngine.termToText(t, labels)).join(' + ');
    }
    return { canonical, simplified };
  },
  /** Product-of-Sums counterpart to _ceAnalyzeOutput. Canonical POS is the
   *  literal product of maxterms (one full-width sum term per 0-row).
   *  Minimized POS comes from minimizing the *complement* of the function
   *  (swap 0s/1s, keep don't-cares) with the same Quine-McCluskey pass,
   *  then De Morgan-ing each resulting AND prime implicant into an OR sum
   *  term via patternToSumTerm — NOT(t1 OR t2 OR ...) = NOT(t1) AND
   *  NOT(t2) AND ..., and NOT of an AND term is an OR of flipped
   *  literals. Each multi-literal sum factor is parenthesized since the
   *  factors are then implicitly multiplied (AND) by juxtaposition. */
  _cePosAnalyzeOutput(n, labels, values){
    if(n === 0) return { canonicalPOS: String(values[0]), simplifiedPOS: String(values[0]) };
    const total = values.length;
    const zerosIdx = [];
    for(let m=0;m<total;m++) if(values[m]===0) zerosIdx.push(m);
    const wrap = (sumTerm)=> sumTerm.includes('+') ? '('+sumTerm+')' : sumTerm;
    let canonicalPOS;
    if(zerosIdx.length === 0) canonicalPOS = '1';
    else if(zerosIdx.length === total) canonicalPOS = '0';
    else canonicalPOS = zerosIdx.map(m=> wrap(KMapEngine.patternToSumTerm(KMapEngine.toBits(m,n).join(''), labels))).join('×');
    const inverted = values.map(v=> v===null ? null : (v===1 ? 0 : 1));
    const minimizedInv = KMapEngine.minimize(n, inverted);
    let simplifiedPOS;
    if(minimizedInv.allZero) simplifiedPOS = '1';       // complement never 1 -> function always 1
    else if(minimizedInv.allOnes) simplifiedPOS = '0';  // complement always 1 -> function always 0
    else simplifiedPOS = minimizedInv.essential.map(pattern=> wrap(KMapEngine.patternToSumTerm(pattern, labels))).join('×');
    return { canonicalPOS, simplifiedPOS };
  },
  _ceRunGeneration(io, outIdxs){
    document.getElementById('circexpr-setup-form').style.display = 'none';
    document.getElementById('circexpr-error').style.display = 'none';
    document.getElementById('circexpr-loading').style.display = 'flex';
    setTimeout(()=>{
      try{
        const rows = this._ttCompute(io);
        const n = io.inputs.length;
        const labels = io.inputs.map(i=> i.label);
        const resultsBody = document.getElementById('circexpr-results-body');
        resultsBody.innerHTML = '';
        outIdxs.forEach(outIdx=>{
          const values = new Array(1 << n).fill(0);
          rows.forEach(row=>{
            const mask = KMapEngine.bitsToMask(row.bits);
            values[mask] = row.outs[outIdx];
          });
          const { canonical, simplified } = this._ceAnalyzeOutput(n, labels, values);
          const name = io.outputs[outIdx].defaultName;
          const card = document.createElement('div');
          card.className = 'circexpr-result-card';
          const showCanon = canonical !== simplified;
          card.innerHTML = `
            <div class="circexpr-result-name">${this._ttEscape(name)}</div>
            <div class="circexpr-result-label">Expression</div>
            <div class="circexpr-result-expr">${this._ttEscape(simplified)}</div>
            ${showCanon ? `<div class="circexpr-result-label">Sum of minterms</div><div class="circexpr-result-canon">${this._ttEscape(canonical)}</div>` : ''}
            <div class="circexpr-result-actions">
              <button class="circexpr-btn circexpr-copy-btn">Copy</button>
              <button class="circexpr-btn circexpr-build-btn">Build circuit from this</button>
            </div>`;
          const copyBtn = card.querySelector('.circexpr-copy-btn');
          copyBtn.onclick = ()=>{
            this._ceCopyText(simplified);
            copyBtn.textContent = 'Copied';
            copyBtn.classList.add('copied');
            setTimeout(()=>{ copyBtn.textContent = 'Copy'; copyBtn.classList.remove('copied'); }, 1200);
          };
          card.querySelector('.circexpr-build-btn').onclick = ()=>{
            document.getElementById('circexpr-overlay').style.display = 'none';
            this.openBoolExprTool(simplified, labels);
          };
          resultsBody.appendChild(card);
        });
        document.getElementById('circexpr-loading').style.display = 'none';
        document.getElementById('circexpr-results').style.display = 'flex';
      }catch(err){
        document.getElementById('circexpr-loading').style.display = 'none';
        document.getElementById('circexpr-setup-form').style.display = 'flex';
        document.getElementById('circexpr-error').style.display = 'flex';
        document.getElementById('circexpr-error-msg').textContent = 'Unexpected error: ' + err.message;
      }
    }, 450 + Math.random()*250);
  },
  /** Copies text to the clipboard, falling back to a hidden textarea +
   *  execCommand for contexts where navigator.clipboard is unavailable
   *  (e.g. non-HTTPS/local file contexts some users run this app from). */
  _ceCopyText(text){
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).catch(()=> this._ceCopyFallback(text));
    } else {
      this._ceCopyFallback(text);
    }
  },
  _ceCopyFallback(text){
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand('copy'); }catch(e){}
    document.body.removeChild(ta);
  },
  /** Parses `expr`, builds the resulting gate network as real
   *  CircuitComponents (fresh VARIABLE inputs, gates, and an LED/Probe
   *  output), wires it up, and drops it centered in the current viewport —
   *  mirroring _replaceGateWithUniversal's column-by-depth layout
   *  approach. `outputType` is 'LED' or 'PROBE'. Returns { ok:true } on
   *  success or { ok:false, error } on a parse failure. */
  _buildCircuitFromBoolExpr(expr, outputType, knownVars){
    outputType = (outputType==='PROBE') ? 'PROBE' : 'LED';
    let built;
    try{
      const ast = BoolExprParser.parse(expr, knownVars);
      built = BoolExprParser.toNodes(ast);
    }catch(e){
      return { ok:false, error: e.message || 'Could not parse that expression.' };
    }
    const { nodes, outRef, varNames } = built;
    if(nodes.length===0 && varNames.length===0 && !(outRef && outRef.const!==undefined)){
      return { ok:false, error: 'Enter a boolean expression first.' };
    }

    // Anchor at the current viewport center, same spot chip/kit clicks place at.
    const center = { x: this.renderer.viewportSize.w/2, y: this.renderer.viewportSize.h/2 };
    const anchor = this.renderer.screenToWorld(center.x, center.y);
    const spacingX = 170, spacingY = 110;

    // ---- Depth per synthetic gate: 1 + max depth of any node-ref input ----
    const depth = new Array(nodes.length).fill(0);
    for(let idx=0; idx<nodes.length; idx++){
      let d = 0;
      for(const ref of nodes[idx].in){
        if(ref.node !== undefined) d = Math.max(d, depth[ref.node] + 1);
      }
      depth[idx] = d;
    }
    const maxDepth = nodes.length ? depth.reduce((a,b)=>Math.max(a,b), 0) : -1;

    // ---- Column -1: one VARIABLE per distinct name, stacked vertically ----
    const varY = varNames.map((_,i)=> i*spacingY);
    // Constant literals (0/1), if the expression uses any, get their own
    // shared HIGH/LOW component appended below the variables.
    const usesConst = new Set();
    const collectConstUse = (ref)=>{ if(ref && ref.const!==undefined) usesConst.add(ref.const); };
    nodes.forEach(n=>n.in.forEach(collectConstUse));
    collectConstUse(outRef);
    const constOrder = [...usesConst].sort();
    const constY = {};
    constOrder.forEach((v,i)=> constY[v] = (varNames.length + i) * spacingY);

    // ---- Column 0..maxDepth: gates, y = average of what feeds them,
    //      nudged apart to keep at least spacingY between column-mates
    //      (identical approach to _replaceGateWithUniversal's layout) ----
    const yOf = (ref) => {
      if(ref.node !== undefined) return finalY[ref.node];
      if(ref.var !== undefined) return varY[ref.var];
      return constY[ref.const];
    };
    const finalY = new Array(nodes.length).fill(0);
    for(let d=0; d<=maxDepth; d++){
      const colIdxs = [];
      for(let idx=0; idx<nodes.length; idx++) if(depth[idx]===d) colIdxs.push(idx);
      const raw = colIdxs.map(idx=>{
        const refsY = nodes[idx].in.map(yOf);
        return refsY.length ? refsY.reduce((a,b)=>a+b,0)/refsY.length : 0;
      });
      const order = colIdxs.map((idx,i)=>({idx, raw: raw[i]})).sort((a,b)=>a.raw-b.raw);
      let prev = -Infinity;
      for(const item of order){
        let y = item.raw;
        if(prev !== -Infinity && y < prev + spacingY) y = prev + spacingY;
        finalY[item.idx] = y;
        prev = y;
      }
    }

    // Recenter everything (variables, constants, gates, and the final
    // output column) around the anchor point.
    const allY = [...varY, ...constOrder.map(v=>constY[v]), ...finalY, yOf(outRef)];
    const midY = allY.length ? (Math.min(...allY) + Math.max(...allY)) / 2 : 0;
    let outX = anchor.x + (maxDepth+1)*spacingX;

    // ---- Find somewhere free to put the whole block ----
    // Build the rectangles for every component that's actually about to
    // be newly created (a VARIABLE with a name that already exists on
    // the canvas is reused in place, not recreated, so it's left out —
    // it isn't moving and is already accounted for as an existing
    // component below). The bounding set is then nudged as a single
    // unit — same spot first, then outward — until it clears everything
    // already on the sheet.
    const existingVarByName = new Map();
    for(const existing of this.model.components.values()){
      if(existing.type==='VARIABLE') existingVarByName.set(existing.label, existing);
    }
    const plannedRects = [];
    varNames.forEach((name, i)=>{
      if(existingVarByName.has(name)) return;
      const def = GateLibrary['VARIABLE'];
      plannedRects.push({ x: anchor.x - spacingX, y: anchor.y + (varY[i]-midY), w: def.w, h: def.h });
    });
    constOrder.forEach(v=>{
      const def = GateLibrary[v===1 ? 'HIGH' : 'LOW'];
      plannedRects.push({ x: anchor.x - spacingX, y: anchor.y + (constY[v]-midY), w: def.w, h: def.h });
    });
    nodes.forEach((node, idx)=>{
      const def = GateLibrary[node.type];
      plannedRects.push({ x: anchor.x + depth[idx]*spacingX, y: anchor.y + (finalY[idx]-midY), w: def.w, h: def.h });
    });
    {
      const outDef = GateLibrary[outputType];
      plannedRects.push({ x: outX, y: anchor.y + (yOf(outRef)-midY), w: outDef.w, h: outDef.h });
    }
    const placement = this._findFreeBlockOffset(plannedRects);
    if(!placement.ok){
      return { ok:false, error: "There's no free space left on the canvas for this circuit. Increase the canvas size (View \u25b8 Canvas Size) and generate again." };
    }
    anchor.x += placement.dx; anchor.y += placement.dy; outX += placement.dx;

    const newSelected = new Set();

    // Create variable + constant input components.
    // If a VARIABLE with this exact label already exists on the canvas
    // (e.g. from an earlier Generate, or one you placed by hand), reuse it
    // instead of creating a duplicate — the new gates just wire out from
    // that same component, so a variable never ends up cloned.
    const varIds = varNames.map((name, i)=>{
      for(const existing of this.model.components.values()){
        if(existing.type==='VARIABLE' && existing.label===name){
          newSelected.add(existing.id);
          return existing.id;
        }
      }
      const c = new CircuitComponent('VARIABLE', anchor.x - spacingX, anchor.y + (varY[i]-midY));
      c.label = name;
      this.model.addComponent(c);
      this.views.set(c.id, ComponentView.create(c, this.el.world));
      newSelected.add(c.id);
      return c.id;
    });
    const constIds = {};
    constOrder.forEach(v=>{
      const c = new CircuitComponent(v===1 ? 'HIGH' : 'LOW', anchor.x - spacingX, anchor.y + (constY[v]-midY));
      this.model.addComponent(c);
      this.views.set(c.id, ComponentView.create(c, this.el.world));
      newSelected.add(c.id);
      constIds[v] = c.id;
    });

    // Create every synthetic gate
    const srcOf = (ref) => {
      if(ref.node !== undefined) return { comp: newIds[ref.node], pin: GateLibrary[nodes[ref.node].type].outputs[0].id };
      if(ref.var !== undefined) return { comp: varIds[ref.var], pin: 'out' };
      return { comp: constIds[ref.const], pin: 'out' };
    };
    const newIds = nodes.map((node, idx)=>{
      const c = new CircuitComponent(node.type, anchor.x + depth[idx]*spacingX, anchor.y + (finalY[idx]-midY));
      this.model.addComponent(c);
      this.views.set(c.id, ComponentView.create(c, this.el.world));
      newSelected.add(c.id);
      return c.id;
    });
    nodes.forEach((node, idx)=>{
      const destId = newIds[idx];
      const destDef = this.model.getComponent(destId).def;
      node.in.forEach((ref, k)=>{
        const src = srcOf(ref);
        this.model.addWire(new CircuitWire(src.comp, src.pin, destId, destDef.inputs[k].id));
      });
    });

    // Final output component (LED or Probe, per the user's choice), wired
    // from whatever outRef resolves to — both share the same input pin id.
    const outComp = new CircuitComponent(outputType, outX, anchor.y + (yOf(outRef)-midY));
    this.model.addComponent(outComp);
    this.views.set(outComp.id, ComponentView.create(outComp, this.el.world));
    newSelected.add(outComp.id);
    const finalSrc = srcOf(outRef);
    this.model.addWire(new CircuitWire(finalSrc.comp, finalSrc.pin, outComp.id, 'a'));

    this.selection.selectedComponents = newSelected;
    this.selection.selectedWires.clear();
    this.runSimulation();
    this._refreshAll();
    this.history.commit();
    return { ok:true };
  },
  _refreshAll(){
    const univTarget = this._pendingUniversalTarget;
    for(const c of this.model.components.values()){
      c._selected = this.selection.selectedComponents.has(c.id);
      // While a Convert-to-Universal pick is in progress, flag every
      // eligible gate (right category, not already the target type) so
      // ComponentView can paint the amber "you can pick this" hint.
      const def = univTarget && GateLibrary[c.type];
      c._convertEligible = !!(univTarget && def && def.category==='gate' && UniversalConverter.isEligible(c.type, univTarget));
      const node = this.views.get(c.id);
      if(node) ComponentView.sync(c, node);
    }
    for(const w of this.model.wires.values()) w._selected = this.selection.selectedWires.has(w.id);
    // Keep every switch/variable bank panel glued to its member switches —
    // without this, dragging a bank moves the switches but leaves their
    // wrapper box stranded at its original position (this fn was defined
    // but never actually called anywhere, so banks never re-synced).
    this._syncSwitchBanks();
    this._ttApplySelectionHighlight();
    this._kmApplySelectionHighlight();
    this.renderer.drawWires(this.model, (compId,pinId,side)=>this._pinScreenPos(compId,pinId,side), this.activeWireDrag);
    this._updateStatusBar();
    this._updatePropertiesPanel();
    this._updateUndoRedoButtons();
    if(this._pendingUniversalTarget) this._updateUniversalConvertBanner();
  },
  _tick(){
    if(this._dirty){ this.runSimulation(); this._dirty = false; this._refreshAll(); }
    else if(this.mode==='wiring' || this.activeWireDraw || this.mode==='dragging-wire-segment'){
      this.renderer.drawWires(this.model, (c,p,s)=>this._pinScreenPos(c,p,s), this.activeWireDrag);
    }
    this._syncFloatingPanelsClip();
    this._ttSyncPanels();
    this._kmSyncPanels();
    requestAnimationFrame(()=>this._tick());
  },
  /** Keeps the #floating-panels-clip strip locked to the canvas viewport's
   *  current vertical extent (it shifts down when the elements/kits bar
   *  opens, and resizes with the window) so floating panels crop against
   *  the top toolbar and status bar exactly like any other element. */
  _syncFloatingPanelsClip(){
    const wrap = document.getElementById('floating-panels-clip');
    if(!wrap) return;
    const vp = this.el.viewport.getBoundingClientRect();
    wrap.style.top = vp.top + 'px';
    wrap.style.height = vp.height + 'px';
  },
  markDirty(){ this._dirty = true; },
  /** Clamps a proposed component bounding box (x,y,w,h) so it stays fully
   *  inside the bounded design canvas (View ▸ Canvas Size). No-op when
   *  Infinite Canvas is active (renderer.canvasCols is null). Used both
   *  at placement time and while dragging components, so nothing can be
   *  dropped or moved into the border / off the sheet. */
  _clampRectToCanvas(x, y, w, h){
    if(!this.renderer.canvasCols || !this.renderer.canvasRows) return {x, y};
    const canvasW = this.renderer.canvasCols * this.renderer.gridSize;
    const canvasH = this.renderer.canvasRows * this.renderer.gridSize;
    return {
      x: Utils.clamp(x, 0, Math.max(0, canvasW - w)),
      y: Utils.clamp(y, 0, Math.max(0, canvasH - h)),
    };
  },

  /** Resolves a component+pin id to current SCREEN coordinates (after pan/zoom). */
  _pinScreenPos(compId, pinId, side){
    const c = this.model.getComponent(compId);
    if(!c) return null;
    // Resolve the pin's REAL side from the component itself rather than
    // trusting the passed-in `side` — wires no longer guarantee that the
    // "from" end is an output and the "to" end is an input, so a pin's
    // geometry must come from where it actually lives (its own inputs/
    // outputs list), not from its role in a particular wire.
    const resolved = c.resolvePin(pinId);
    if(!resolved) return null;
    const world = c.pinWorldPos(resolved.pinDef, resolved.side);
    return this.renderer.worldToScreen(world.x, world.y);
  },

  // =====================================================================
  // ELEMENTS PANEL (drag-and-drop / click-to-place new components,
  // opened from the "Elements" toggle button in the top bar)
  // =====================================================================
  _bindToolbox(){
    document.querySelectorAll('.element-chip:not(.switch-palette-chip), .rail-chip:not(.switch-palette-chip)').forEach(item=>{
      item.addEventListener('dragstart', (e)=>{
        e.dataTransfer.setData('text/gate-type', item.dataset.gateType);
        e.dataTransfer.effectAllowed = 'copy';
        // Mark that a real HTML drag started so the pointerup handler
        // below doesn't also fire a click-place on drag release.
        item._chipDragging = true;
      });
      item.addEventListener('dragend', ()=>{ item._chipDragging = false; });
      // CLICK-TO-PLACE using pointerdown+pointerup instead of 'click':
      // draggable="true" on these chips makes the browser unreliable with
      // the 'click' event — even a tiny pointer wobble during mousedown can
      // fire 'dragstart' instead, silently swallowing the click so nothing
      // gets placed. By tracking the down-position ourselves and only
      // committing a place if the pointer moved fewer than 6px, we get
      // rock-solid click-to-place without fighting the drag system.
      item.addEventListener('pointerdown', (e)=>{
        if(e.button !== 0) return;
        item._chipPointerDownPos = { x: e.clientX, y: e.clientY };
        item._chipDragging = false;
      });
      item.addEventListener('pointerup', (e)=>{
        if(e.button !== 0) return;
        // If a real HTML drag was in progress, skip — the drop handler places it.
        if(item._chipDragging) return;
        const down = item._chipPointerDownPos;
        if(!down) return;
        const dx = e.clientX - down.x, dy = e.clientY - down.y;
        // More than 6px = user was trying to drag, not click
        if(Math.sqrt(dx*dx + dy*dy) > 6) return;
        e.preventDefault();
        e.stopPropagation();
        const type = item.dataset.gateType;
        if(!type) return;
        const center = { x: this.renderer.viewportSize.w/2, y: this.renderer.viewportSize.h/2 };
        const world = this.renderer.screenToWorld(center.x, center.y);
        const offset = this._nextClickPlaceOffset();
        this._placeComponent(type, world.x + offset, world.y + offset);
        item._chipPointerDownPos = null;
      });
    });
    this.el.viewport.addEventListener('dragover', (e)=>{ e.preventDefault(); });
    this.el.viewport.addEventListener('drop', (e)=>{
      e.preventDefault();
      const type = e.dataTransfer.getData('text/gate-type');
      if(!type) return;
      const count = parseInt(e.dataTransfer.getData('text/switch-count')||'1', 10) || 1;
      const rect = this.el.viewport.getBoundingClientRect();
      const screenX = e.clientX - rect.left, screenY = e.clientY - rect.top;
      const world = this.renderer.screenToWorld(screenX, screenY);
      this._placeComponentN(type, world.x, world.y, count);
      // The drop is the actual action — now it's safe to close the
      // horizontal bar (the vertical rail is unaffected; _closeMenus
      // never touches #elements-rail).
      this._closeMenus();
      this._closeSwitchPalettes();
    });

    // ── Element Palettes: Switch, LED, Probe, Variable (elements bar + rail) ──
    Object.keys(PALETTE_CONFIG).forEach(type=>{
      this._initElementPalette(type, 'bar');
      this._initElementPalette(type, 'rail');
    });
    // Close palettes when clicking outside (ignore right-clicks — those are handled by contextmenu)
    document.addEventListener('pointerdown', (e)=>{
      if(e.button !== 0) return; // right-click handled separately via contextmenu event
      if(e.target.closest('.switch-palette-submenu')) return; // clicking inside menu doesn't close it
      if(!e.target.closest('.switch-palette-wrapper')) this._closeSwitchPalettes();
      if(!e.target.closest('.kit-chip-menu') && !e.target.closest('.kit-chip-arrow')) this._closeKitChipMenus();
    }, true);
  },

  _closeSwitchPalettes(){
    document.querySelectorAll('.switch-palette-submenu').forEach(m=>m.classList.remove('open'));
  },

  _initElementPalette(type, variant){
    const cfg = PALETTE_CONFIG[type];
    if(!cfg) return;
    const prefix   = cfg.idPrefix;
    const btn      = document.getElementById(`${prefix}-palette-btn-${variant}`);
    const menu     = document.getElementById(`${prefix}-palette-submenu-${variant}`);
    const arrowTab = document.getElementById(`${prefix}-palette-arrow-${variant}`);
    if(!btn || !menu) return;

    // Move submenu to <body> so it is never clipped by any parent overflow:hidden
    document.body.appendChild(menu);

    // Build header + rows 2–8
    const header = document.createElement('div');
    header.className = 'sw-palette-header';
    header.textContent = cfg.menuHeader;
    menu.appendChild(header);

    const counts = [2,3,4,5,6,7,8];
    counts.forEach(n=>{
      const row = document.createElement('div');
      row.className = 'sw-palette-item';
      row.draggable = true;
      row.dataset.gateType    = type;
      row.dataset.switchCount = String(n);
      row.innerHTML = `<span class="sw-pi-label">${n} ${cfg.plural}</span><span class="sw-pi-count">×${n}</span>`;
      menu.appendChild(row);

      row.addEventListener('dragstart', (e)=>{
        e.dataTransfer.setData('text/gate-type', type);
        e.dataTransfer.setData('text/switch-count', String(n));
        e.dataTransfer.effectAllowed = 'copy';
        row._swDragging = true;
        this._closeSwitchPalettes();
      });
      row.addEventListener('dragend', ()=>{ row._swDragging = false; });

      let _downPos = null;
      row.addEventListener('pointerdown', (e)=>{ if(e.button===0){ _downPos={x:e.clientX,y:e.clientY}; row._swDragging=false; } });
      row.addEventListener('pointerup', (e)=>{
        if(e.button!==0) return;
        if(row._swDragging) return;
        if(!_downPos) return;
        const dx=e.clientX-_downPos.x, dy=e.clientY-_downPos.y;
        if(Math.sqrt(dx*dx+dy*dy)>6){ _downPos=null; return; }
        e.preventDefault(); e.stopPropagation();
        const center={x:this.renderer.viewportSize.w/2, y:this.renderer.viewportSize.h/2};
        const world=this.renderer.screenToWorld(center.x, center.y);
        const offset=this._nextClickPlaceOffset();
        this._placeComponentN(type, world.x+offset, world.y+offset, n);
        _downPos=null;
        this._closeSwitchPalettes();
        this._closeMenus();
      });
    });

    // Helper: compute and show menu position
    const _openMenu = ()=>{
      const r = btn.getBoundingClientRect();
      const menuW = 160;
      let left = r.left + r.width/2 - menuW/2;
      if(left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
      if(left < 8) left = 8;
      if(variant === 'rail'){
        left = r.left - menuW - 6;
        if(left < 8) left = 8;
      }
      menu.style.left = left + 'px';
      menu.style.top  = (r.bottom + 5) + 'px';
      menu.classList.add('open');
    };
    const _toggleMenu = ()=>{
      const isOpen = menu.classList.contains('open');
      this._closeSwitchPalettes();
      if(!isOpen) _openMenu();
    };

    // ── Arrow tab: left-click → open/close palette ──
    if(arrowTab){
      arrowTab.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
      arrowTab.addEventListener('click', (e)=>{ e.stopPropagation(); _toggleMenu(); });
    }

    // ── Body zone: left-click → place 1 element; also supports drag ──
    const bodyEl = btn.querySelector('.sw-chip-body');
    if(bodyEl){
      bodyEl.draggable = true;
      bodyEl.addEventListener('dragstart', (e)=>{
        e.dataTransfer.setData('text/gate-type', type);
        e.dataTransfer.setData('text/switch-count', '1');
        e.dataTransfer.effectAllowed = 'copy';
        bodyEl._swBodyDragging = true;
        this._closeSwitchPalettes();
      });
      bodyEl.addEventListener('dragend', ()=>{ bodyEl._swBodyDragging = false; });

      let _bodyDown = null;
      bodyEl.addEventListener('pointerdown', (e)=>{ if(e.button===0){ e.stopPropagation(); _bodyDown={x:e.clientX,y:e.clientY}; bodyEl._swBodyDragging=false; } });
      bodyEl.addEventListener('pointerup', (e)=>{
        if(e.button!==0) return;
        if(bodyEl._swBodyDragging){ _bodyDown=null; return; }
        if(!_bodyDown) return;
        const dx=e.clientX-_bodyDown.x, dy=e.clientY-_bodyDown.y;
        if(Math.sqrt(dx*dx+dy*dy)>6){ _bodyDown=null; return; }
        e.preventDefault(); e.stopPropagation();
        const center={x:this.renderer.viewportSize.w/2, y:this.renderer.viewportSize.h/2};
        const world=this.renderer.screenToWorld(center.x, center.y);
        const offset=this._nextClickPlaceOffset();
        this._placeComponent(type, world.x+offset, world.y+offset);
        this._closeSwitchPalettes();
        _bodyDown = null;
      });
    }

    // ── Right-click on entire chip → open palette
    //    contextmenu fires AFTER pointerdown+pointerup, so no conflict.
    btn.addEventListener('contextmenu', (e)=>{
      e.preventDefault(); e.stopPropagation();
      _toggleMenu();
    });
  },

  _placeComponentN(type, worldX, worldY, count){
    count = count || 1;
    const def = GateLibrary[type];

    // Single element: no bank, just place normally
    if(count === 1){
      this._placeComponent(type, worldX, worldY);
      return;
    }

    // Multiple elements (SWITCH, LED, PROBE, or VARIABLE): zero-gap stack
    // inside a unified bank panel — same idea regardless of type.
    const gap = 0; // elements flush against each other — bank provides outer frame
    const padding = 0; // bank border only; no inner padding needed
    const totalH = count * def.h + (count-1)*gap;

    let startX = worldX - def.w/2;
    let startY = worldY - totalH/2;
    if(this.renderer.snapEnabled){
      startX = Utils.snap(startX, this.renderer.gridSize);
      startY = Utils.snap(startY, this.renderer.gridSize);
    }
    // Nudge the whole bank to a non-overlapping position
    const bankPos = this._findNonOverlappingPos(startX, startY, def.w, totalH);
    startX = bankPos.x; startY = bankPos.y;
    ({x: startX, y: startY} = this._clampRectToCanvas(startX, startY, def.w, totalH));

    // Create the bank background/border panel (purely visual, pointer-events:none)
    const bank = document.createElement('div');
    bank.className = 'switch-bank';
    bank.style.left   = (startX - 2) + 'px'; // -2 for the 2px border
    bank.style.top    = (startY - 2) + 'px';
    bank.style.width  = (def.w + 4) + 'px';   // +4 for border on each side
    bank.style.height = (totalH + 4) + 'px';
    this.el.world.appendChild(bank);

    // Place each element flush, no gap, inside the bank
    const ids = [];
    const bankGroupId = Utils.uid('bank');
    for(let i=0; i<count; i++){
      const x = startX;
      const y = startY + i * def.h;
      const comp = new CircuitComponent(type, x, y);
      // VARIABLE: auto-assign the next available letter name, same as a
      // single placement would (so a bank of 3 reads A, B, C — not blank).
      if(type === 'VARIABLE'){
        const usedNames = new Set(
          [...this.model.components.values()]
            .filter(c => c.type === 'VARIABLE')
            .map(c => c.label)
        );
        let idx = 0;
        while(usedNames.has(this._varIdxToName(idx))) idx++;
        comp.label = this._varIdxToName(idx);
      }
      // Tag each component so ComponentView.sync() knows to suppress the individual body shell
      comp._bankId = bank; // direct DOM reference; cleared on remove
      comp.bankGroup = bankGroupId; // persistent id saved to file so banks survive save/load
      this.model.addComponent(comp);
      const node = ComponentView.create(comp, this.el.world);
      // Mark node as living inside a bank so CSS suppresses its individual border/bg
      node.classList.add('in-switch-bank');
      this.views.set(comp.id, node);
      ids.push(comp.id);

      // Divider line between elements (not after last one)
      if(i < count - 1){
        const div = document.createElement('div');
        div.className = 'switch-bank-divider';
        div.style.top = (i * def.h + def.h - 1) + 'px'; // relative to bank top (inside border)
        bank.appendChild(div);
      }
    }

    // Keep a registry of banks so they can be synced (position, selection highlight)
    if(!this._switchBanks) this._switchBanks = [];
    this._switchBanks.push({ bank, ids, x: startX, y: startY, w: def.w, h: totalH });

    this.selection.selectOnly(ids);
    this._repairWiresAroundObstacles(ids);
    this.markDirty();
    this.history.commit();
  },

  /** Whenever any switch that belongs to a bank enters the selection, pull in
   *  all other living members of the same bank. This prevents a single bank
   *  member from being dragged out of the group independently. */
  _expandSelectionForBanks(){
    if(!this._switchBanks || !this._switchBanks.length) return;
    let added = true;
    // Iterate until stable (handles edge-case of overlapping banks)
    while(added){
      added = false;
      for(const entry of this._switchBanks){
        const alive = entry.ids.filter(id=> this.model.getComponent(id));
        const anySelected = alive.some(id=> this.selection.selectedComponents.has(id));
        if(anySelected){
          for(const id of alive){
            if(!this.selection.selectedComponents.has(id)){
              this.selection.add(id, false);
              added = true;
            }
          }
        }
      }
    }
  },

  /** Called from _syncSwitchBanks() to keep bank panels in sync with their member switches
   *  (position, selection highlight, and cleanup of banks whose switches were deleted). */
  _syncSwitchBanks(){
    if(!this._switchBanks) return;
    this._switchBanks = this._switchBanks.filter(entry=>{
      // If all member switches are gone, remove the bank panel too
      const alive = entry.ids.filter(id=> this.model.getComponent(id));
      if(alive.length === 0){ entry.bank.remove(); return false; }
      // If only 1 switch remains, release the bank styling on it and remove panel
      if(alive.length === 1){
        const node = this.views.get(alive[0]);
        if(node) node.classList.remove('in-switch-bank');
        entry.bank.remove();
        return false;
      }
      // Update bank position to follow the first surviving switch's current position
      const first = this.model.getComponent(alive[0]);
      if(first){
        entry.bank.style.left = (first.x - 2) + 'px';
        entry.bank.style.top  = (first.y - 2) + 'px';
      }
      // Update selection highlight
      const anySelected = alive.some(id=> this.selection.selectedComponents.has(id));
      entry.bank.classList.toggle('bank-has-selected', anySelected);
      return true;
    });
  },
  /** Returns a position (x, y) near (preferX, preferY) where a rectangle of
   *  (w × h) does not overlap any existing component. Searches outward in
   *  concentric rings, stepping by gridSize, so placed elements never stack. */
  _findNonOverlappingPos(preferX, preferY, w, h, extraRects){
    const grid = this.renderer.snapEnabled ? this.renderer.gridSize : 10;
    const pad  = 4; // small gap so elements never touch edge-to-edge
    const _overlaps = (cx, cy) => {
      const r1 = { x:cx, y:cy, x2:cx+w, y2:cy+h };
      for(const c of this.model.components.values()){
        const s = c.renderedSize();
        const r2 = { x:c.x-pad, y:c.y-pad, x2:c.x+s.w+pad, y2:c.y+s.h+pad };
        if(r1.x < r2.x2 && r1.x2 > r2.x && r1.y < r2.y2 && r1.y2 > r2.y) return true;
      }
      if(extraRects){
        for(const r2 of extraRects){
          const er = { x:r2.x-pad, y:r2.y-pad, x2:r2.x+r2.w+pad, y2:r2.y+r2.h+pad };
          if(r1.x < er.x2 && r1.x2 > er.x && r1.y < er.y2 && r1.y2 > er.y) return true;
        }
      }
      return false;
    };
    // Start at preferred position
    if(!_overlaps(preferX, preferY)) return { x:preferX, y:preferY };
    // Spiral outward in grid-sized rings until a free spot is found
    for(let ring = 1; ring <= 60; ring++){
      const step = grid;
      const checks = [];
      for(let dx = -ring; dx <= ring; dx++) checks.push([dx*step, -ring*step], [dx*step, ring*step]);
      for(let dy = -ring+1; dy < ring; dy++) checks.push([-ring*step, dy*step], [ring*step, dy*step]);
      for(const [dx, dy] of checks){
        const cx = preferX + dx, cy = preferY + dy;
        if(!_overlaps(cx, cy)) return { x:cx, y:cy };
      }
    }
    // Fallback: just return the preferred position if somehow nothing found
    return { x:preferX, y:preferY };
  },
  /** Given an array of rectangles (world coords) describing a block of
   *  components that's about to be created together — e.g. everything
   *  generated by the Boolean Expression tool — finds a (dx,dy) shift
   *  that can be applied to the whole block at once so none of its
   *  rectangles land on top of anything already on the canvas. Tries
   *  the original spot first, then spirals outward in grid-sized rings
   *  (same pattern as _findNonOverlappingPos) so a free spot under or
   *  beside the existing circuit is used automatically. On a bounded
   *  Canvas Size, the search never proposes a shift that would push the
   *  block off the sheet; if nothing fits anywhere, returns {ok:false}
   *  so the caller can ask the user to enlarge the canvas instead of
   *  dropping the new circuit on top of the old one. */
  _findFreeBlockOffset(rects){
    if(rects.length===0) return { ok:true, dx:0, dy:0 };
    const grid = this.renderer.snapEnabled ? this.renderer.gridSize : 10;
    const pad = 4;
    const minX = Math.min(...rects.map(r=>r.x));
    const minY = Math.min(...rects.map(r=>r.y));
    const maxX = Math.max(...rects.map(r=>r.x+r.w));
    const maxY = Math.max(...rects.map(r=>r.y+r.h));
    const bounded = !!(this.renderer.canvasCols && this.renderer.canvasRows);
    const canvasW = bounded ? this.renderer.canvasCols * this.renderer.gridSize : Infinity;
    const canvasH = bounded ? this.renderer.canvasRows * this.renderer.gridSize : Infinity;
    const fitsCanvas = (dx, dy) => {
      if(!bounded) return true;
      return (minX+dx) >= 0 && (minY+dy) >= 0 && (maxX+dx) <= canvasW && (maxY+dy) <= canvasH;
    };
    const overlapsExisting = (dx, dy) => {
      for(const r of rects){
        const r1 = { x:r.x+dx-pad, y:r.y+dy-pad, x2:r.x+dx+r.w+pad, y2:r.y+dy+r.h+pad };
        for(const c of this.model.components.values()){
          const s = c.renderedSize();
          const r2 = { x:c.x, y:c.y, x2:c.x+s.w, y2:c.y+s.h };
          if(r1.x < r2.x2 && r1.x2 > r2.x && r1.y < r2.y2 && r1.y2 > r2.y) return true;
        }
      }
      return false;
    };
    const tryOffset = (dx, dy) => fitsCanvas(dx, dy) && !overlapsExisting(dx, dy);

    if(tryOffset(0, 0)) return { ok:true, dx:0, dy:0 };

    const maxRing = bounded ? Math.ceil(Math.max(canvasW, canvasH) / grid) + 2 : 80;
    for(let ring = 1; ring <= maxRing; ring++){
      const step = grid;
      const checks = [];
      for(let dx = -ring; dx <= ring; dx++) checks.push([dx*step, -ring*step], [dx*step, ring*step]);
      for(let dy = -ring+1; dy < ring; dy++) checks.push([-ring*step, dy*step], [ring*step, dy*step]);
      for(const [dx, dy] of checks){
        if(tryOffset(dx, dy)) return { ok:true, dx, dy };
      }
    }
    return { ok:false };
  },


  /** Shared diagonal-cascade offset for chip/kit click-to-place (all of
   *  which spawn at the viewport center). Only genuinely rapid, back-to-back
   *  clicks accumulate an offset so newly placed components don't stack
   *  exactly on top of each other — a deliberate, normally-paced click
   *  (more than RAPID_CLICK_WINDOW_MS since the last placement) resets the
   *  cascade back to 0 so it lands exactly at center, same as before. */
  _nextClickPlaceOffset(){
    const RAPID_CLICK_WINDOW_MS = 600;
    const now = Date.now();
    const isRapid = (now - (this._lastClickPlaceTime||0)) < RAPID_CLICK_WINDOW_MS;
    this._clickPlaceCount = isRapid ? (this._clickPlaceCount||0) + 1 : 1;
    this._lastClickPlaceTime = now;
    return ((this._clickPlaceCount - 1) % 6) * 26;
  },
  _placeComponent(type, worldX, worldY, viewMode){
    const base = GateLibrary[type];
    // Kits placed in 'circuit' mode are sized/positioned using their
    // enlarged Full Circuit footprint from the start — this is the only
    // place viewMode is ever set; once placed, a kit's view is fixed for
    // good (see the kit palette chip's arrow menu, which decides this
    // BEFORE placement, not a per-instance toggle afterward).
    const isCircuitKit = viewMode === 'circuit' && KIT_NETLISTS[type];
    const sizeLayout = isCircuitKit ? _buildKitLayout(type, base) : null;
    const w = isCircuitKit ? sizeLayout.W : base.w;
    const h = isCircuitKit ? sizeLayout.H : base.h;
    let x = worldX - w/2, y = worldY - h/2;
    if(this.renderer.snapEnabled){ x = Utils.snap(x, this.renderer.gridSize); y = Utils.snap(y, this.renderer.gridSize); }
    // Nudge to a non-overlapping position
    const pos = this._findNonOverlappingPos(x, y, w, h);
    x = pos.x; y = pos.y;
    ({x, y} = this._clampRectToCanvas(x, y, w, h));
    const comp = new CircuitComponent(type, x, y);
    if(isCircuitKit) comp.viewMode = 'circuit';
    // VARIABLE: auto-assign the next available letter name (a, b, c … z, aa, ab …)
    if(type === 'VARIABLE'){
      const usedNames = new Set(
        [...this.model.components.values()]
          .filter(c => c.type === 'VARIABLE')
          .map(c => c.label)
      );
      let idx = 0;
      while(usedNames.has(this._varIdxToName(idx))) idx++;
      comp.label = this._varIdxToName(idx);
    }
    this.model.addComponent(comp);
    this.views.set(comp.id, ComponentView.create(comp, this.el.world));
    this.selection.selectOnly([comp.id]);
    this._repairWiresAroundObstacles([comp.id]);
    this.markDirty();
    this.history.commit();
  },
  _closeKitChipMenus(){
    document.querySelectorAll('.kit-chip-menu').forEach(m=>m.classList.remove('open'));
  },
  /**
   * Wires up one kit palette chip's "choose view" arrow (Multiplexer,
   * Demultiplexer, Decoder, Encoder, Priority Encoder — the KIT_NETLISTS
   * types). The arrow opens a small popup with two mutually-exclusive
   * options, Block Diagram and Full Circuit; whichever is selected is
   * remembered on the chip (item.dataset.kitView) and decides which
   * version gets built the *next* time the chip is clicked to place one.
   * This choice is made before placement only — once a kit component is
   * on the canvas its view is permanent (see _placeComponent), so there is
   * deliberately no way to flip a placed instance between the two.
   */
  _initKitChipArrow(item){
    const arrow = item.querySelector('.kit-chip-arrow');
    if(!arrow) return; // e.g. BCDSEG has no Full Circuit netlist — no arrow was added for it
    item.dataset.kitView = item.dataset.kitView || 'block';

    const menu = document.createElement('div');
    menu.className = 'kit-chip-menu';
    menu.innerHTML = `
      <div class="kit-chip-menu-item" data-view="block"><span>Block Diagram</span><span class="kcm-check">✓</span></div>
      <div class="kit-chip-menu-item" data-view="circuit"><span>Full Circuit</span><span class="kcm-check">✓</span></div>
    `;
    document.body.appendChild(menu);

    const _refreshMenuActive = ()=>{
      menu.querySelectorAll('.kit-chip-menu-item').forEach(row=>{
        row.classList.toggle('active', row.dataset.view === item.dataset.kitView);
      });
      arrow.classList.toggle('mode-circuit', item.dataset.kitView === 'circuit');
    };
    _refreshMenuActive();

    const _openMenu = ()=>{
      this._closeKitChipMenus();
      const r = arrow.getBoundingClientRect();
      const menuW = 150;
      let left = r.left + r.width/2 - menuW/2;
      if(left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
      if(left < 8) left = 8;
      menu.style.left = left + 'px';
      menu.style.top = (r.bottom + 5) + 'px';
      menu.classList.add('open');
    };
    arrow.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
    arrow.addEventListener('click', (e)=>{
      e.stopPropagation();
      const isOpen = menu.classList.contains('open');
      this._closeKitChipMenus();
      if(!isOpen) _openMenu();
    });
    menu.addEventListener('pointerdown', (e)=>{ e.stopPropagation(); });
    menu.addEventListener('click', (e)=>{
      e.stopPropagation();
      const row = e.target.closest('.kit-chip-menu-item');
      if(!row) return;
      item.dataset.kitView = row.dataset.view;
      _refreshMenuActive();
      this._closeKitChipMenus();
    });
  },
  _varIdxToName(n){
    // 0→A, 1→B … 25→Z, 26→AA, 27→AB …
    let s = '';
    do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while(n >= 0);
    return s;
  },

  // =====================================================================
  // TOP BAR (Files menu, Elements menu, undo/redo)
  // =====================================================================
  _bindTopBar(){
    // "New" now opens a brand-new design tab (like the + button on the
    // design tabs bar) rather than clearing the current canvas, so it's
    // non-destructive — no confirmation needed, the previous design is
    // untouched and still sitting on its own tab.
    document.getElementById('btn-new').onclick = ()=>{
      this._closeMenus();
      this._dtAddTab();
    };
    document.getElementById('new-cancel').onclick = ()=>{ document.getElementById('new-overlay').style.display = 'none'; };
    document.getElementById('new-overlay').addEventListener('click', (e)=>{ if(e.target===document.getElementById('new-overlay')) document.getElementById('new-overlay').style.display='none'; });
    const fileInput = document.getElementById('file-input-hidden');

    // ── Open Circuit modal (in-app, no native browser dialog on menu click) ──
    const openOverlay  = document.getElementById('open-overlay');
    const openDropzone = document.getElementById('open-dropzone');
    const openError    = document.getElementById('open-error');
    const _showOpenModal = ()=>{ openError.style.display='none'; openOverlay.style.display='flex'; };
    const _hideOpenModal = ()=>{ openOverlay.style.display='none'; };

    const _processOpenFile = async (file)=>{
      if(!file){ return; }
      _hideOpenModal();
      try{
        const data = await PersistenceManager.loadFromFile(file);
        this._applySnapshotData(data);
        this._restorePanelsFromData(data);
        this.history.undoStack=[]; this.history.redoStack=[];
        this.history.commit();
        this.markDirty();
        this._currentFilename = file.name.replace(/\.(arlc\.json|arlc|json)$/i,'');
      }catch(err){
        openError.textContent = 'Could not open this .ARLC file. It may be corrupted or invalid.';
        openError.style.display='block';
        openOverlay.style.display='flex';
      }
      fileInput.value='';
    };

    document.getElementById('btn-open').onclick = ()=>{ this._closeMenus(); _showOpenModal(); };
    document.getElementById('open-cancel').onclick = _hideOpenModal;
    openOverlay.addEventListener('click', (e)=>{ if(e.target===openOverlay) _hideOpenModal(); });

    // Browse button is the only trigger for the native file picker
    document.getElementById('open-browse-btn').onclick = (e)=>{ e.stopPropagation(); fileInput.click(); };

    // Drag-and-drop on the drop zone
    openDropzone.addEventListener('dragover', (e)=>{ e.preventDefault(); openDropzone.style.borderColor='#14c8c4'; openDropzone.style.background='#e8fffe'; });
    openDropzone.addEventListener('dragleave', ()=>{ openDropzone.style.borderColor='#c4cbd4'; openDropzone.style.background='#f8f9fb'; });
    openDropzone.addEventListener('drop', (e)=>{ e.preventDefault(); openDropzone.style.borderColor='#c4cbd4'; openDropzone.style.background='#f8f9fb'; const file=e.dataTransfer.files[0]; if(file) _processOpenFile(file); });

    fileInput.onchange = async (e)=>{
      const file = e.target.files[0];
      await _processOpenFile(file);
    };
    // Save: writes to the design's existing filename (falls back to "circuit"
    // the first time, same as Save As, since this is a browser-download model
    // with no persistent file handle to silently overwrite).
    document.getElementById('btn-save').onclick = ()=>{
      this._closeMenus();
      const snap = this._serializeSnapshot();
      PersistenceManager.saveToFile(snap, this._currentFilename || 'circuit');
    };

    const _fname = ()=> this._currentFilename || 'circuit';
    const _openExport = (fmt)=>{
      this._closeMenus();
      ExportPreview.open(this.model, _fname(), fmt);
    };
    document.getElementById('btn-export-png').onclick = ()=> _openExport('png');
    document.getElementById('btn-export-jpg').onclick = ()=> _openExport('jpg');
    document.getElementById('btn-export-svg').onclick = ()=> _openExport('svg');
    document.getElementById('btn-export-pdf').onclick = ()=> _openExport('pdf');
    // Save As: shows an internal modal to name the file — never uses
    // the browser's prompt() so it looks consistent on all platforms.
    const saveAsOverlay = document.getElementById('saveas-overlay');
    const saveAsInput   = document.getElementById('saveas-input');
    const _openSaveAs = ()=>{
      this._closeMenus();
      saveAsInput.value = this._currentFilename || 'circuit';
      saveAsOverlay.style.display = 'flex';
      setTimeout(()=>{ saveAsInput.focus(); saveAsInput.select(); }, 50);
    };
    const _confirmSaveAs = ()=>{
      const clean = (saveAsInput.value.trim() || 'circuit')
        .replace(/\.(arlc|json)(\.|$)/i,'').replace(/\.+$/,'');
      this._currentFilename = clean;
      saveAsOverlay.style.display = 'none';
      const snap = this._serializeSnapshot();
      PersistenceManager.saveToFile(snap, clean);
    };
    document.getElementById('btn-save-as').onclick = _openSaveAs;
    document.getElementById('saveas-confirm').onclick = _confirmSaveAs;
    document.getElementById('saveas-cancel').onclick  = ()=>{ saveAsOverlay.style.display='none'; };
    saveAsOverlay.addEventListener('click', (e)=>{ if(e.target===saveAsOverlay) saveAsOverlay.style.display='none'; });
    saveAsInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') _confirmSaveAs(); if(e.key==='Escape') saveAsOverlay.style.display='none'; });
    // Delete Design: clears the canvas and wipes the autosave slot, so the
    // Delete Design: clears the current tab's canvas (other open design
    // tabs are untouched) and immediately persists the blank state, so it
    // doesn't silently reappear on next load.
    document.getElementById('btn-delete-design').onclick = ()=>{
      this._closeMenus();
      document.getElementById('delete-overlay').style.display = 'flex';
    };
    document.getElementById('delete-confirm').onclick = ()=>{
      document.getElementById('delete-overlay').style.display = 'none';
      this._applySnapshotData({components:[],wires:[]});
      this.history.undoStack=[]; this.history.redoStack=[];
      this.history.commit();
      this._currentFilename = null;
      this.markDirty();
      this._dtAutosaveAll();
    };
    // Delete All Designs: wipes every open design tab (not just the active
    // one), collapsing back down to a single fresh blank tab — the same
    // "always keep at least one open" invariant the tab-close logic uses.
    document.getElementById('delete-confirm-all').onclick = ()=>{
      document.getElementById('delete-overlay').style.display = 'none';
      const id = Utils.uid('tab');
      this._dtTabs = [{ id, name:'Design 1', filename:null, snapshot:this._dtMakeBlankSnapshot(), undoStack:[], redoStack:[] }];
      this._dtActiveId = id;
      this._dtCounter = 2;
      this.history.undoStack=[]; this.history.redoStack=[];
      this._applySnapshotData({components:[],wires:[]});
      this.history.commit();
      this._currentFilename = null;
      this.markDirty();
      this._dtRenderTabs();
      this._dtAutosaveAll();
    };
    document.getElementById('delete-cancel').onclick = ()=>{ document.getElementById('delete-overlay').style.display = 'none'; };
    document.getElementById('delete-overlay').addEventListener('click', (e)=>{ if(e.target===document.getElementById('delete-overlay')) document.getElementById('delete-overlay').style.display='none'; });

    document.getElementById('btn-undo').onclick = ()=> this.history.undo() && (this.runSimulation(), this._refreshAll());
    document.getElementById('btn-redo').onclick = ()=> this.history.redo() && (this.runSimulation(), this._refreshAll());

    document.getElementById('btn-zoom-in').onclick = ()=> this._zoomBy(1.2);
    document.getElementById('btn-zoom-out').onclick = ()=> this._zoomBy(1/1.2);
    document.getElementById('btn-zoom-reset').onclick = ()=>{ this.renderer.pan={x:0,y:0}; this.renderer.zoom=1; this.renderer.draw(); this.markDirty(); this._updateZoomReadout(); };

    this.selectModeOn = false;
    const selectModeBtn = document.getElementById('btn-select-mode');
    this._toggleSelectMode = ()=>{
      this.selectModeOn = !this.selectModeOn;
      selectModeBtn.classList.toggle('active', this.selectModeOn);
      this.el.viewport.style.cursor = this.selectModeOn ? 'crosshair' : '';
    };
    // Explicit "turn on" (vs toggle) used by the right-click context menu's
    // "Select" item — picking it should always activate select mode, never
    // flip it off if it happened to already be on.
    this._enterSelectMode = ()=>{
      this.selectModeOn = true;
      selectModeBtn.classList.add('active');
      this.el.viewport.style.cursor = 'crosshair';
    };
    // Explicit "turn off" — used when a plain click on empty space while
    // in select mode should deselect AND drop back out of select mode.
    this._exitSelectMode = ()=>{
      this.selectModeOn = false;
      selectModeBtn.classList.remove('active');
      this.el.viewport.style.cursor = '';
    };
    selectModeBtn.onclick = ()=> this._toggleSelectMode();

    // Wire width: fixed screen-pixel stroke width for wires, deliberately
    // independent of zoom level (see CanvasRenderer.wireWidth / _strokeWire).
    // Wire width is fixed at 4.4px — adjustment disabled
    // document.getElementById('btn-wire-thicker').onclick = ()=> this._adjustWireWidth(0.4);
    // Wire width is fixed at 4.4px — adjustment disabled
    // document.getElementById('btn-wire-thinner').onclick = ()=> this._adjustWireWidth(-0.4);
    this._updateWireWidthReadout();

    // Files dropdown toggle (floating panel). Elements is handled
    // separately below since it opens the full-width #elements-bar row
    // rather than a floating panel. Copy, Paste, and Delete remain
    // available via Ctrl+C / Ctrl+V / Delete and via right-click context
    // menu — intentionally not top-bar buttons.
    const filesMenu = document.getElementById('menu-files');
    document.getElementById('btn-files-toggle').onclick = (e)=>{
      e.stopPropagation();
      const opening = !filesMenu.classList.contains('open');
      this._closeMenus();
      if(opening) filesMenu.classList.add('open');
    };
    // Clicking inside the dropdown panel shouldn't bubble up and
    // immediately re-close it via the document listener.
    filesMenu.querySelector('.dropdown-panel').addEventListener('click', (e)=> e.stopPropagation());

    // Edit menu dropdown
    const editMenu = document.getElementById('menu-edit');
    document.getElementById('btn-edit-toggle').onclick = (e)=>{
      e.stopPropagation();
      const opening = !editMenu.classList.contains('open');
      this._closeMenus();
      if(opening) editMenu.classList.add('open');
    };
    editMenu.querySelector('.dropdown-panel').addEventListener('click', (e)=> e.stopPropagation());

    // Tools menu dropdown
    const toolsMenu = document.getElementById('menu-tools');
    document.getElementById('btn-tools-toggle').onclick = (e)=>{
      e.stopPropagation();
      const opening = !toolsMenu.classList.contains('open');
      this._closeMenus();
      if(opening) toolsMenu.classList.add('open');
    };
    toolsMenu.querySelector('.dropdown-panel').addEventListener('click', (e)=> e.stopPropagation());
    document.getElementById('tools-truth-table').onclick = ()=>{
      toolsMenu.classList.remove('open');
      // Anchor the setup dialog/panel just under the Tools button itself,
      // rather than falling back to a fixed top-right spot that can land
      // far from where the user actually clicked.
      const r = document.getElementById('btn-tools-toggle').getBoundingClientRect();
      this.openTruthTableMaker({ x: r.left, y: r.bottom + 8 });
    };
    document.getElementById('tools-kmap').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openKMapTool();
    };
    document.getElementById('tools-boolexpr').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openBoolExprTool();
    };
    document.getElementById('tools-circuit-to-boolexpr').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openCircuitToBoolExprTool();
    };
    document.getElementById('tools-simplify-boolexpr').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openSimplifyExprTool();
    };
    document.getElementById('tools-sop-pos').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openSopPosTool();
    };
    document.getElementById('tools-simplify-circuit').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openSimplifyCircuitTool();
    };
    document.getElementById('tools-kmap-to-circuit').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openKMapToCircuitTool();
    };
    document.getElementById('tools-kmap-tt').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openKMapTruthTableTool();
    };
    document.getElementById('tools-tt-to-circuit').onclick = ()=>{
      toolsMenu.classList.remove('open');
      this.openTruthTableToCircuitTool();
    };
    // Convert to Universal: opens the centered square-option popup (shared
    // with the right-click "Conversion Tool" entry below) instead of a
    // hover flyout, since there are now three choices to lay out clearly —
    // NAND, NOR, and the "unofficial" AND-OR option.
    document.getElementById('tools-convert-universal-trigger').addEventListener('click', (e)=>{
      e.stopPropagation();
      toolsMenu.classList.remove('open');
      this._openConversionToolPopup();
    });
    const univBanner = document.getElementById('univ-convert-banner');
    const univBannerText = document.getElementById('univ-convert-banner-text');
    const univTargetPill = document.getElementById('univ-convert-target-pill');
    const univApplyBtn = document.getElementById('univ-convert-apply');
    const univApplyCount = document.getElementById('univ-convert-apply-count');
    // The banner lives inside #canvas-viewport (so it can float over the
    // canvas), which means a plain click on it would otherwise bubble up
    // into the viewport's own mousedown/mouseup handlers — those treat any
    // undragged click on empty canvas as "deselect everything", which was
    // wiping out the very selection the person just made a split second
    // before the button's own click handler got a chance to read it.
    // Stopping propagation here keeps clicks on the banner from ever
    // reaching the canvas selection logic.
    univBanner.addEventListener('mousedown', (e)=> e.stopPropagation());
    univBanner.addEventListener('mouseup', (e)=> e.stopPropagation());
    univBanner.addEventListener('click', (e)=> e.stopPropagation());
    // Conversion Tool popup: opened from the "Conversion Tool" item at the
    // bottom of the right-click (empty-canvas) menu. Centered on screen —
    // picking NAND or NOR here closes the popup and starts the same
    // "select gates, then tap Convert" banner flow as the Tools menu path.
    const conversionToolOverlay = document.getElementById('conversion-tool-overlay');
    this._openConversionToolPopup = ()=>{
      conversionToolOverlay.style.display = 'flex';
    };
    document.getElementById('conversion-tool-cancel').onclick = ()=>{ conversionToolOverlay.style.display = 'none'; };
    conversionToolOverlay.addEventListener('click', (e)=>{ if(e.target===conversionToolOverlay) conversionToolOverlay.style.display='none'; });
    document.querySelectorAll('.conversion-tool-option').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        conversionToolOverlay.style.display = 'none';
        this._startUniversalConvertMode(btn.dataset.target);
      });
    });
    this._startUniversalConvertMode = (target)=>{
      this._pendingUniversalTarget = target;
      univTargetPill.textContent = target;
      univBanner.style.display = 'flex';
      this._updateUniversalConvertBanner();
      this._refreshAll(); // paint the amber "eligible" hint on qualifying gates right away
    };
    this._endUniversalConvertMode = ()=>{
      this._pendingUniversalTarget = null;
      univBanner.style.display = 'none';
      this._refreshAll(); // clear the amber "eligible" hint
    };
    /** Counts how many currently-selected components actually qualify for
     *  conversion (gate-category, not already the target type) and updates
     *  the banner's text, live count badge, and the Convert button's
     *  enabled state to match. Called on every selection change while
     *  conversion mode is active (see _refreshAll), so the banner always
     *  reflects reality instead of only reporting "no gates" after the
     *  fact once Convert is tapped. */
    this._updateUniversalConvertBanner = ()=>{
      if(!this._pendingUniversalTarget) return;
      const target = this._pendingUniversalTarget;
      let count = 0;
      for(const id of this.selection.selectedComponents){
        const c = this.model.getComponent(id);
        const def = c && GateLibrary[c.type];
        if(def && def.category==='gate' && UniversalConverter.isEligible(c.type, target)) count++;
      }
      univApplyCount.textContent = String(count);
      univApplyBtn.disabled = count === 0;
      if(count === 0){
        univBannerText.textContent = 'Click gates on the canvas to select them.';
        univBannerText.classList.remove('has-count');
      } else {
        univBannerText.textContent = count===1 ? '1 gate ready to convert.' : `${count} gates ready to convert.`;
        univBannerText.classList.add('has-count');
      }
    };
    document.getElementById('univ-convert-cancel').onclick = ()=> this._endUniversalConvertMode();
    univApplyBtn.onclick = ()=>{
      const target = this._pendingUniversalTarget;
      if(!target || univApplyBtn.disabled) return;
      const count = this.convertSelectionToUniversal(target);
      if(count === 0){
        this._updateUniversalConvertBanner();
        return;
      }
      this._endUniversalConvertMode();
    };

    // Kits toggle: shows/hides the full-width horizontal #kits-bar row,
    // same behavior as the Elements toggle (not a floating dropdown).
    // Each .kit-item places its component at the viewport center (same
    // click-to-place behavior as a rail/palette chip). Future kits just
    // need another .kit-item with data-gate-type inside #kits-bar.
    const kitsToggle = document.getElementById('btn-kits-toggle');
    const kitsBar = document.getElementById('kits-bar');
    const kitsAppEl = document.getElementById('app');
    kitsToggle.onclick = (e)=>{
      e.stopPropagation();
      const opening = !kitsAppEl.classList.contains('kits-open');
      this._closeMenus();
      if(opening){ kitsAppEl.classList.add('kits-open'); kitsToggle.classList.add('active'); }
    };
    kitsBar.addEventListener('click', (e)=> e.stopPropagation());
    kitsBar.addEventListener('dragstart', (e)=> e.stopPropagation());
    kitsBar.querySelectorAll('.kit-item').forEach(item=>{
      this._initKitChipArrow(item);
      item.addEventListener('click', (e)=>{
        if(e.target.closest('.kit-chip-arrow')) return; // arrow handles its own click
        const type = item.dataset.gateType;
        if(!type) return;
        const center = { x: this.renderer.viewportSize.w/2, y: this.renderer.viewportSize.h/2 };
        const world = this.renderer.screenToWorld(center.x, center.y);
        const offset = this._nextClickPlaceOffset();
        this._placeComponent(type, world.x + offset, world.y + offset, item.dataset.kitView || 'block');
        kitsAppEl.classList.remove('kits-open');
        kitsToggle.classList.remove('active');
      });
    });

    // View menu dropdown (Canvas Size, etc.)
    const viewMenu = document.getElementById('menu-view');
    document.getElementById('btn-view-toggle').onclick = (e)=>{
      e.stopPropagation();
      const opening = !viewMenu.classList.contains('open');
      this._closeMenus();
      if(opening) viewMenu.classList.add('open');
    };
    viewMenu.querySelector('.dropdown-panel').addEventListener('click', (e)=> e.stopPropagation());
    document.getElementById('view-zoom-in').onclick = (e)=>{ e.stopPropagation(); this._zoomStepBy(10); };
    document.getElementById('view-zoom-out').onclick = (e)=>{ e.stopPropagation(); this._zoomStepBy(-10); };
    document.getElementById('view-zoom-fit').onclick = ()=>{
      this.renderer.pan={x:0,y:0}; this.renderer.zoom=1; this.renderer.draw(); this.markDirty(); this._updateZoomReadout();
      viewMenu.classList.remove('open');
    };
    document.getElementById('view-toggle-grid').onclick = ()=>{
      this.renderer.gridVisible = !this.renderer.gridVisible;
      document.getElementById('view-toggle-grid').querySelector('span').textContent = this.renderer.gridVisible ? 'Hide Grid' : 'Show Grid';
      this.renderer.draw();
      viewMenu.classList.remove('open');
    };
    // Element Rail (right-edge icon strip) is now optional, off by default —
    // toggled here instead of always being visible.
    document.getElementById('view-toggle-rail').onclick = ()=>{
      const appEl2 = document.getElementById('app');
      appEl2.classList.toggle('rail-open');
      document.getElementById('view-rail-check').style.visibility = appEl2.classList.contains('rail-open') ? 'visible' : 'hidden';
      viewMenu.classList.remove('open');
    };

    // Canvas Size submenu: opens on hover via CSS, and also toggles on
    // click/tap (for touch devices, where there's no hover) without
    // closing the parent View menu.
    const canvasSizeTrigger = document.getElementById('view-canvas-size-trigger');
    canvasSizeTrigger.addEventListener('click', (e)=>{
      e.stopPropagation();
      canvasSizeTrigger.classList.toggle('submenu-open');
    });
    const CANVAS_SIZES = {
      small:    { cols:90,  rows:51  },
      medium:   { cols:224, rows:128 },
      large:    { cols:448, rows:256 },
      infinite: { cols:null, rows:null },
    };
    this._setActiveCanvasSize = (key)=>{
      document.querySelectorAll('.canvas-size-item').forEach(item=>{
        item.querySelector('[data-check]').textContent = (item.dataset.size === key) ? '✓' : '';
      });
    };
    document.querySelectorAll('.canvas-size-item').forEach(item=>{
      item.addEventListener('click', (e)=>{
        e.stopPropagation();
        const key = item.dataset.size;
        const { cols, rows } = CANVAS_SIZES[key];
        this.renderer.setCanvasSize(cols, rows);
        this._setActiveCanvasSize(key);
        this.markDirty();
        canvasSizeTrigger.classList.remove('submenu-open');
        viewMenu.classList.remove('open');
      });
    });
    // Default: Small Design Canvas (90 × 51 — 20% smaller than the
    // standard 112 × 64 small size), applied on load so the workspace
    // opens bounded instead of Infinite. Medium, Large, and Infinite are
    // untouched and still selectable from the submenu as before.
    this.renderer.setCanvasSize(CANVAS_SIZES.small.cols, CANVAS_SIZES.small.rows);
    this._setActiveCanvasSize('small');

    const _closeEdit = ()=> editMenu.classList.remove('open');

    document.getElementById('edit-undo').onclick = ()=>{ this.history.undo(); this.runSimulation(); this._refreshAll(); _closeEdit(); };
    document.getElementById('edit-delete').onclick = ()=>{ this.deleteSelection(); _closeEdit(); };
    document.getElementById('edit-cut').onclick = ()=>{ this.copySelection(); this.deleteSelection(); _closeEdit(); };
    document.getElementById('edit-copy').onclick = ()=>{ this.copySelection(); _closeEdit(); };
    document.getElementById('edit-paste').onclick = ()=>{ this.pasteClipboard(); _closeEdit(); };
    document.getElementById('edit-rotate-cw').onclick = ()=>{ this.rotateSelection(); _closeEdit(); };
    document.getElementById('edit-rotate-ccw').onclick = ()=>{
      for(const id of this.selection.selectedComponents){
        const c = this.model.getComponent(id);
        if(c) c.rotation = ((c.rotation - 90) % 360 + 360) % 360;
      }
      this.markDirty(); this.history.commit(); _closeEdit();
    };
    document.getElementById('edit-flip-h').onclick = ()=>{
      for(const id of this.selection.selectedComponents){
        const c = this.model.getComponent(id);
        if(c){ c._flipX = !(c._flipX || false); }
      }
      this.markDirty(); this.history.commit(); _closeEdit();
    };
    document.getElementById('edit-flip-v').onclick = ()=>{
      for(const id of this.selection.selectedComponents){
        const c = this.model.getComponent(id);
        if(c){ c._flipY = !(c._flipY || false); }
      }
      this.markDirty(); this.history.commit(); _closeEdit();
    };
    document.getElementById('edit-select-all').onclick = ()=>{
      this.selection.selectOnly([...this.model.components.keys()]); this._refreshAll(); _closeEdit();
    };
    document.getElementById('edit-select-none').onclick = ()=>{ this.selection.clear(); this._refreshAll(); _closeEdit(); };
    document.getElementById('edit-toggle-snap').onclick = ()=>{
      this.renderer.snapEnabled = !this.renderer.snapEnabled;
      document.getElementById('edit-snap-check').style.visibility = this.renderer.snapEnabled ? 'visible' : 'hidden';
      _closeEdit();
    };

    // Elements bar toggle: shows/hides the full-width horizontal strip of
    // gates/inputs/outputs as a dedicated row (#elements-bar) rather than
    // a floating dropdown, so it reads as a toolbar, not a menu.
    const elementsToggle = document.getElementById('btn-elements-toggle');
    const appEl = document.getElementById('app');
    elementsToggle.onclick = (e)=>{
      e.stopPropagation();
      const opening = !appEl.classList.contains('elements-open');
      this._closeMenus();
      if(opening){ appEl.classList.add('elements-open'); elementsToggle.classList.add('active'); }
    };
    document.getElementById('elements-bar').addEventListener('click', (e)=> e.stopPropagation());
    document.getElementById('elements-bar').addEventListener('dragstart', (e)=> e.stopPropagation());
    const elementsRail = document.getElementById('elements-rail');
    if(elementsRail){
      elementsRail.addEventListener('click', (e)=> e.stopPropagation());
      elementsRail.addEventListener('dragstart', (e)=> e.stopPropagation());
    }

    // Context menu actions
    this.el.ctxMenu.querySelectorAll('.ctx-item').forEach(item=>{
      item.addEventListener('click', (e)=>{
        e.stopPropagation();
        const action = item.dataset.action;
        if(action==='copy') this.copySelection();
        if(action==='linked-copy') this.linkedCopySelection();
        if(action==='bank-copy-one')        this._bankCopyOne(false);
        if(action==='bank-copy-all')        this._bankCopyAll(false);
        if(action==='bank-linked-copy-one') this._bankCopyOne(true);
        if(action==='bank-linked-copy-all') this._bankCopyAll(true);
        if(action==='var-copy-same') this._varCopySame();
        if(action==='var-copy-new')  this._varCopyNew();
        if(action==='var-group-copy-same') this._varGroupCopySame();
        if(action==='var-group-copy-new')  this._varGroupCopyNew();
        if(action==='paste') this.pasteClipboard(this._lastContextWorldPos);
        if(action==='select-mode') this._enterSelectMode();
        if(action==='select-all'){ this.selection.selectOnly([...this.model.components.keys()]); this._refreshAll(); }
        if(action==='conversion-tool') this._openConversionToolPopup();
        if(action==='simplify-circuit') this.openSimplifyCircuitTool();
        if(action==='refresh'){ this.runSimulation(); this._refreshAll(); }
        if(action==='delete') this.deleteSelection();
        if(action==='rotate') this.rotateSelection();
        if(action==='truth-table'){ this.openTruthTableMaker(this._lastContextScreenPos); }
        if(action==='kmap'){ this.openKMapTool(); }
        if(action==='properties'){
          this._showCtxProperties();
          return; // keep menu open
        }
        this.el.ctxMenu.style.display='none';
      });
    });
    // Back button in inline properties
    document.getElementById('ctx-back-btn').addEventListener('click', (e)=>{
      e.stopPropagation();
      document.getElementById('ctx-main-items').style.display='block';
      document.getElementById('ctx-props-section').style.display='none';
    });
    document.addEventListener('click', ()=>{ this.el.ctxMenu.style.display='none'; this._closeMenus({ keepElements:true }); });
    this.el.ctxMenu.addEventListener('click', (e)=> e.stopPropagation());
    // Props modal close button
    const propsCloseBtn = document.getElementById('props-modal-close');
    if(propsCloseBtn) propsCloseBtn.onclick = ()=>{ this.el.propsModal.style.display='none'; };
    // Clicking inside props modal shouldn't close it
    if(this.el.propsModal) this.el.propsModal.addEventListener('click', (e)=> e.stopPropagation());
  },
  _closeMenus(opts){
    document.querySelectorAll('.menu-dropdown.open').forEach(m=> m.classList.remove('open'));
    document.querySelectorAll('.has-submenu.submenu-open').forEach(m=> m.classList.remove('submenu-open'));
    // The Elements bar is intentionally NOT closed here when keepElements
    // is set. It should only close on an explicit action in the design
    // workspace (placing a component via click or drop) or when another
    // top-bar menu/toggle is opened — never just from clicking/dragging
    // around the canvas (panning, selecting, etc.).
    if(!(opts && opts.keepElements)){
      document.getElementById('app').classList.remove('elements-open');
      document.getElementById('btn-elements-toggle').classList.remove('active');
      document.getElementById('app').classList.remove('kits-open');
      document.getElementById('btn-kits-toggle').classList.remove('active');
    }
    if(this.el && this.el.propsModal) this.el.propsModal.style.display='none';
    // Reset context menu to main view
    const main = document.getElementById('ctx-main-items');
    const props = document.getElementById('ctx-props-section');
    if(main) main.style.display='block';
    if(props) props.style.display='none';
  },
  _showCtxProperties(){
    const selIds = [...this.selection.selectedComponents];
    const inner = document.getElementById('ctx-props-inner');
    const titleEl = document.getElementById('ctx-props-title');
    if(!inner) return;
    if(selIds.length !== 1){
      inner.innerHTML = `<div style="padding:6px 4px;font-size:12.5px;color:var(--c-text-soft);font-weight:600;">${selIds.length===0?'No component selected.':'Select a single component.'}</div>`;
      if(titleEl) titleEl.textContent = 'Properties';
    } else {
      const c = this.model.getComponent(selIds[0]);
      if(!c){ inner.innerHTML=''; return; }
      const def = c.def;
      if(titleEl) titleEl.textContent = `${def.label} (${c.type})`;
      const stateOf = (v)=> v===1?'1':v===0?'0':'X';
      const pillClass = (v)=> v===1?'state-1':v===0?'state-0':'state-x';
      const outRow = def.outputs.length ? `
        <div class="prop-row"><label class="ui-label">Output</label>
          ${def.outputs.map((o,i)=>`<span class="state-pill ${pillClass(c.outputValues&&c.outputValues[i])}"><span class="dot"></span>${stateOf(c.outputValues&&c.outputValues[i])}</span>`).join(' ')}
        </div>` : '';
      const isExpandable = ExpandableGates.has(c.type);
      const curCount = def.inputs.length;
      const countRow = isExpandable ? `
        <div class="prop-row"><label class="ui-label">Input Count</label>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="strip-btn" id="ctx-prop-inputs-minus" ${curCount<=GATE_MIN_INPUTS?'disabled':''} style="border:1.5px solid var(--c-gray);">−</button>
            <span class="prop-value" style="min-width:32px;text-align:center;padding:5px 6px;">${curCount}</span>
            <button class="strip-btn" id="ctx-prop-inputs-plus" ${curCount>=GATE_MAX_INPUTS?'disabled':''} style="border:1.5px solid var(--c-gray);">+</button>
          </div>
        </div>` : '';
      const inRows = def.inputs.length ? `
        <div class="prop-row"><label class="ui-label">Inputs (${def.inputs.length})</label>
          <div class="pin-list">${def.inputs.map((p,i)=>`<div class="pin-list-item"><span>${p.id.toUpperCase()}</span><span class="state-pill ${pillClass(c.inputValues&&c.inputValues[i])}"><span class="dot"></span>${stateOf(c.inputValues&&c.inputValues[i])}</span></div>`).join('')}</div>
        </div>` : '';
      const gateTypeRow = (def.category==='gate') ? (()=>{
        const siblings = isExpandable ? ['AND','OR','NAND','NOR','XOR','XNOR'] : ['NOT','BUFFER'];
        const btns = siblings.map(t=>`<button class="gate-type-btn${c.type===t?' active':''}" data-gate-type="${t}">${GateLibrary[t].label}</button>`).join('');
        return `<div class="prop-row"><label class="ui-label">Gate Type</label>
          <div class="gate-type-grid" id="ctx-gate-type-grid">${btns}</div>
        </div>`;
      })() : '';
      const colorRow = (c.type==='SEVENSEG'||c.type==='BCDSEG') ? (()=>{
        const cur = (c.state&&c.state.segColor)||'green';
        const cols = [
          {id:'green', label:'Green', lit:'#1fae5c'},
          {id:'red',   label:'Red',   lit:'#e0364a'},
          {id:'blue',  label:'Blue',  lit:'#1e5fcc'},
          {id:'yellow',label:'Yellow',lit:'#e0b800'},
          {id:'orange',label:'Orange',lit:'#e07020'},
          {id:'white', label:'White', lit:'#e8eef4'},
        ];
        const swatches = cols.map(col=>`
          <div data-seg-color="${col.id}" title="${col.label}" style="
            width:22px;height:22px;border-radius:5px;cursor:pointer;
            background:${col.lit};
            border:2.5px solid ${cur===col.id?'#0f2a4a':'#c8d4e0'};
            box-shadow:${cur===col.id?'0 0 0 2px rgba(20,200,196,0.35)':'none'};
          "></div>`).join('');
        return `<div class="prop-row"><label class="ui-label">Segment Color</label>
          <div id="ctx-seg-color-swatches" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">${swatches}</div>
        </div>`;
      })() : '';
      const linkRow = (c.type==='SWITCH' && c.linkGroup) ? `
        <div class="prop-row"><label class="ui-label">Linked To</label>
          <div class="prop-value" style="display:flex;align-items:center;gap:6px;">
            <span style="color:var(--c-teal);font-size:13px;">↔</span>
            <span>${c.linkedSourceName || c.label || 'Switch'}</span>
          </div>
        </div>` : '';
      const isVariable = c.type === 'VARIABLE';
      const isText = c.type === 'TEXT';
      const ctxLabelRowHTML = isVariable ? (()=>{
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const cur = (c.label||'A').toUpperCase();
        const btns = letters.split('').map(l =>
          `<button class="var-letter-btn${cur===l?' active':''}" data-var-letter="${l}" title="${l}">${l}</button>`
        ).join('');
        const ctxGroupMembers = c.bankGroup
          ? [...this.model.components.values()].filter(x => x.type==='VARIABLE' && x.bankGroup===c.bankGroup)
          : [c];
        const ctxInGroup = ctxGroupMembers.length > 1;
        const ctxGroupRow = `<div class="prop-row" id="ctx-var-group-row">
          <label class="ui-label">${ctxInGroup ? `Group (${ctxGroupMembers.length})` : 'Apply To'}</label>
          <div style="display:flex;gap:5px;margin-top:2px;">
            <button class="strip-btn" id="ctx-var-same" style="flex:1;font-size:10px;padding:4px 3px;">
              ${ctxInGroup ? '= Same letter' : '✓ Apply'}
            </button>
            ${ctxInGroup ? `<button class="strip-btn" id="ctx-var-seq" style="flex:1;font-size:10px;padding:4px 3px;">A B C… Seq</button>` : ''}
          </div>
        </div>`;
        // When this variable belongs to a multi-variable bank, let the user
        // edit every member's name individually, right here. Typing a long
        // name in any of these expands that variable's body on the canvas
        // automatically (handled by ComponentView.sync), so nothing is ever
        // clipped.
        const ctxMemberListRow = ctxInGroup ? `<div class="prop-row" id="ctx-var-member-list">
          <label class="ui-label">Edit Each Name</label>
          <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px;">
            ${ctxGroupMembers.map((m,i)=>`
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:10px;font-weight:800;color:var(--c-text-soft);min-width:14px;">${i+1}.</span>
                <input class="var-name-input ctx-var-member-input" data-member-id="${m.id}" maxlength="16" value="${(m.label||'').toUpperCase().replace(/"/g,'&quot;')}" spellcheck="false" style="flex:1;" />
              </div>`).join('')}
          </div>
        </div>` : '';
        return `<div class="prop-row"><label class="ui-label">Variable Name</label>
          <div class="var-name-row">
            <input class="var-name-input" id="ctx-prop-label" maxlength="16" value="${cur.replace(/"/g,'&quot;')}" spellcheck="false" />
          </div>
          <div class="var-letter-grid" id="ctx-var-letter-grid">${btns}</div>
        </div>${ctxGroupRow}${ctxMemberListRow}`;
      })() : isText ? (()=>{
        const curText = (c.state && c.state.text) || 'Text';
        const curFs = (c.state && c.state.fontSize) || 18;
        return `<div class="prop-row"><label class="ui-label">Text</label>
          <textarea class="prop-input" id="ctx-prop-text" rows="2" spellcheck="false" style="resize:vertical;font-family:inherit;">${curText.replace(/</g,'&lt;')}</textarea>
        </div>
        <div class="prop-row"><label class="ui-label">Font Size</label>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="strip-btn" id="ctx-prop-fontsize-minus" style="border:1.5px solid var(--c-gray);">−</button>
            <span class="prop-value" id="ctx-prop-fontsize-val" style="min-width:32px;text-align:center;padding:5px 6px;">${curFs}</span>
            <button class="strip-btn" id="ctx-prop-fontsize-plus" style="border:1.5px solid var(--c-gray);">+</button>
          </div>
        </div>`;
      })() : (()=>{
        const defaultLabel = GateLibrary[c.type] ? GateLibrary[c.type].label : c.type;
        const shown = (c.label && c.label !== defaultLabel) ? c.label : '';
        return `<div class="prop-row"><label class="ui-label">Label</label><input class="prop-input" id="ctx-prop-label" placeholder="${defaultLabel.replace(/"/g,'&quot;')}" value="${shown.replace(/"/g,'&quot;')}" /></div>`;
      })();
      inner.innerHTML = `
        ${ctxLabelRowHTML}
        ${linkRow}${colorRow}${outRow}${gateTypeRow}${countRow}${inRows}
        <div class="prop-row"><label class="ui-label">Rotation</label>
          <div style="display:flex;align-items:center;gap:8px;">
            <button class="strip-btn" id="ctx-prop-rot-minus" style="border:1.5px solid var(--c-gray);">−</button>
            <span class="prop-value" style="min-width:40px;text-align:center;padding:5px 6px;">${c.rotation}°</span>
            <button class="strip-btn" id="ctx-prop-rot-plus" style="border:1.5px solid var(--c-gray);">+</button>
          </div>
        </div>
        <div class="prop-row"><label class="ui-label">Position</label><div class="prop-value">x: ${Math.round(c.x)}, y: ${Math.round(c.y)}</div></div>
      `;
      const labelInput = document.getElementById('ctx-prop-label');
      if(labelInput){
        const applyCtxLabel = (val) => {
          if(isVariable){
            const v = val.toUpperCase();
            c.label = v;
            labelInput.value = v;
          } else {
            const defaultLabel = GateLibrary[c.type] ? GateLibrary[c.type].label : c.type;
            c.label = val.trim() === '' ? defaultLabel : val;
          }
          const node=this.views.get(c.id); if(node) ComponentView.sync(c,node);
          const g = document.getElementById('ctx-var-letter-grid');
          if(g) g.querySelectorAll('.var-letter-btn').forEach(b=>b.classList.toggle('active', b.dataset.varLetter===c.label));
        };
        labelInput.addEventListener('click', e=> e.stopPropagation());
        labelInput.addEventListener('input', ()=>applyCtxLabel(labelInput.value));
        labelInput.addEventListener('blur', ()=> { this.history.commit(); this._closeMenus(); });
      }
      const ctxTextInput = document.getElementById('ctx-prop-text');
      if(ctxTextInput){
        ctxTextInput.addEventListener('click', e=> e.stopPropagation());
        ctxTextInput.addEventListener('input', ()=>{
          c.state = c.state || {};
          c.state.text = ctxTextInput.value === '' ? 'Text' : ctxTextInput.value;
          const node=this.views.get(c.id); if(node) ComponentView.sync(c,node);
        });
        ctxTextInput.addEventListener('blur', ()=> { this.history.commit(); this._closeMenus(); });
      }
      const ctxFsVal = document.getElementById('ctx-prop-fontsize-val');
      const ctxFsStep = (delta)=>{
        c.state = c.state || {};
        const cur = c.state.fontSize || 18;
        c.state.fontSize = Utils.clamp(cur + delta, 8, 96);
        if(ctxFsVal) ctxFsVal.textContent = c.state.fontSize;
        const node=this.views.get(c.id); if(node) ComponentView.sync(c,node);
        this.history.commit();
      };
      const ctxFsMinus = document.getElementById('ctx-prop-fontsize-minus');
      const ctxFsPlus  = document.getElementById('ctx-prop-fontsize-plus');
      if(ctxFsMinus) ctxFsMinus.addEventListener('click', e=>{ e.stopPropagation(); ctxFsStep(-2); });
      if(ctxFsPlus)  ctxFsPlus.addEventListener('click', e=>{ e.stopPropagation(); ctxFsStep(2); });
      const ctxGrid = document.getElementById('ctx-var-letter-grid');
      if(ctxGrid){
        ctxGrid.addEventListener('click', (e)=>{
          e.stopPropagation();
          const btn = e.target.closest('.var-letter-btn');
          if(!btn) return;
          const letter = btn.dataset.varLetter;
          c.label = letter;
          if(labelInput) labelInput.value = letter;
          const node=this.views.get(c.id); if(node) ComponentView.sync(c,node);
          ctxGrid.querySelectorAll('.var-letter-btn').forEach(b=>b.classList.toggle('active', b.dataset.varLetter===letter));
          this.history.commit();
        });
      }
      const ctxMemberInputs = inner.querySelectorAll('.ctx-var-member-input');
      ctxMemberInputs.forEach(mInp=>{
        mInp.addEventListener('click', e=> e.stopPropagation());
        mInp.addEventListener('input', ()=>{
          const mid = mInp.dataset.memberId;
          const m = this.model.getComponent(mid);
          if(!m) return;
          const v = mInp.value.toUpperCase();
          mInp.value = v;
          m.label = v;
          const mNode = this.views.get(m.id);
          if(mNode) ComponentView.sync(m, mNode);
          // Keep the main name field / letter grid in sync if this row is
          // the same component the panel was opened on.
          if(mid === c.id){
            if(labelInput) labelInput.value = v;
            const g = document.getElementById('ctx-var-letter-grid');
            if(g) g.querySelectorAll('.var-letter-btn').forEach(b=>b.classList.toggle('active', b.dataset.varLetter===v));
          }
        });
        mInp.addEventListener('blur', ()=> this.history.commit());
      });
      if(isVariable){
        const _ctxGroupMembers = () => c.bankGroup
          ? [...this.model.components.values()].filter(x => x.type==='VARIABLE' && x.bankGroup===c.bankGroup)
          : [c];
        const _ctxApply = (labelFn) => {
          _ctxGroupMembers().forEach((m, i) => {
            m.label = labelFn(i).toUpperCase();
            const n = this.views.get(m.id);
            if(n) ComponentView.sync(m, n);
          });
          this.history.commit();
          this._showCtxProperties();
        };
        const ctxSameBtn = document.getElementById('ctx-var-same');
        if(ctxSameBtn) ctxSameBtn.addEventListener('click', (e)=>{ e.stopPropagation(); _ctxApply(() => (c.label||'A').toUpperCase()); });
        const ctxSeqBtn = document.getElementById('ctx-var-seq');
        if(ctxSeqBtn) ctxSeqBtn.addEventListener('click', (e)=>{ e.stopPropagation(); const base=(c.label||'A').toUpperCase().charCodeAt(0)-65; _ctxApply((i)=>this._varIdxToName(base+i)); });
      }
      if(isExpandable){
        const minusBtn = document.getElementById('ctx-prop-inputs-minus');
        const plusBtn  = document.getElementById('ctx-prop-inputs-plus');
        if(minusBtn) minusBtn.addEventListener('click', (e)=>{ e.stopPropagation(); this.setInputCount(c.id,curCount-1); this.runSimulation(); this._refreshAll(); this._showCtxProperties(); });
        if(plusBtn)  plusBtn.addEventListener('click',  (e)=>{ e.stopPropagation(); this.setInputCount(c.id,curCount+1); this.runSimulation(); this._refreshAll(); this._showCtxProperties(); });
      }
      const ctxGateTypeGrid = document.getElementById('ctx-gate-type-grid');
      if(ctxGateTypeGrid){
        ctxGateTypeGrid.addEventListener('click', (e)=>{
          e.stopPropagation();
          const btn = e.target.closest('.gate-type-btn');
          if(!btn) return;
          this.changeGateType(c.id, btn.dataset.gateType);
          this._refreshAll();
          this._showCtxProperties();
        });
      }
      const ctxRotMinus = document.getElementById('ctx-prop-rot-minus');
      const ctxRotPlus  = document.getElementById('ctx-prop-rot-plus');
      if(ctxRotMinus) ctxRotMinus.addEventListener('click', (e)=>{ e.stopPropagation(); this.rotateComponent(c.id, -90); this._showCtxProperties(); });
      if(ctxRotPlus)  ctxRotPlus.addEventListener('click',  (e)=>{ e.stopPropagation(); this.rotateComponent(c.id, 90); this._showCtxProperties(); });
      const swatchWrap = document.getElementById('ctx-seg-color-swatches');
      if(swatchWrap){
        swatchWrap.addEventListener('click', (e)=>{
          e.stopPropagation();
          const sw = e.target.closest('[data-seg-color]');
          if(!sw) return;
          if(!c.state) c.state = {};
          c.state.segColor = sw.dataset.segColor;
          const node = this.views.get(c.id);
          if(node) ComponentView.sync(c, node);
          this.history.commit();
          this._showCtxProperties();
        });
      }
    }
    document.getElementById('ctx-main-items').style.display='none';
    document.getElementById('ctx-props-section').style.display='block';
    // Re-clamp menu position now that it's taller
    const menu = this.el.ctxMenu;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    const curLeft = parseInt(menu.style.left)||0;
    const curTop  = parseInt(menu.style.top)||0;
    menu.style.left = Math.max(8, Math.min(curLeft, window.innerWidth  - mw - 8)) + 'px';
    menu.style.top  = Math.max(8, Math.min(curTop,  window.innerHeight - mh - 8)) + 'px';
  },
  _zoomBy(factor){
    const center = {x:this.renderer.viewportSize.w/2, y:this.renderer.viewportSize.h/2};
    this._zoomAtPoint(factor, center);
  },
  /** Steps the zoom by a fixed 10% increment (e.g. 100% → 110% → 120%),
   *  snapping to the nearest clean 10% first so repeated clicks always
   *  land on round numbers, regardless of any prior pinch/scroll zoom. */
  _zoomStepBy(deltaPct){
    const center = {x:this.renderer.viewportSize.w/2, y:this.renderer.viewportSize.h/2};
    const curPct = Math.round(this.renderer.zoom*100/10)*10;
    const targetZoom = Utils.clamp((curPct+deltaPct)/100, this.renderer.minZoomForBounds(), 4);
    const factor = targetZoom / this.renderer.zoom;
    this._zoomAtPoint(factor, center);
  },
  _updateZoomReadout(){
    const zoomPct = Math.round(this.renderer.zoom*100)+'%';
    document.getElementById('zoom-readout').textContent = zoomPct;
    const viewZoomReadout = document.getElementById('view-zoom-readout');
    if(viewZoomReadout) viewZoomReadout.textContent = zoomPct;
  },
  _zoomAtPoint(factor, screenPoint){
    const worldBefore = this.renderer.screenToWorld(screenPoint.x, screenPoint.y);
    this.renderer.zoom = Utils.clamp(this.renderer.zoom*factor, this.renderer.minZoomForBounds(), 4);
    const screenAfter = this.renderer.worldToScreen(worldBefore.x, worldBefore.y);
    this.renderer.pan.x += screenPoint.x - screenAfter.x;
    this.renderer.pan.y += screenPoint.y - screenAfter.y;
    this.renderer.draw();
    this._updateZoomReadout();
    // Redraw the wire layer right now (not on the next rAF tick) so the wire
    // strokes and hop-bridge semicircles are always recomputed from the
    // zoom/pan values that were just set — never one frame stale during
    // fast continuous scroll/pinch zooming.
    this.renderer.drawWires(this.model, (c,p,s)=>this._pinScreenPos(c,p,s), this.activeWireDrag);
    this.markDirty();
  },
  /** Adjusts the constant on-screen wire stroke width. This value is never
   *  multiplied by renderer.zoom (see CanvasRenderer._strokeWire), so wires
   *  stay visually the same thickness at any zoom level — only this control
   *  changes how thick they look. */
  _adjustWireWidth(delta){
    // Wire width is fixed at 4.4px — adjustment disabled
    // this.renderer.wireWidth = Utils.clamp(
    //   Math.round((this.renderer.wireWidth + delta) * 10) / 10, 1.0, 6.0
    // );
    // this._updateWireWidthReadout();
    // this.renderer.draw();
    // this.markDirty();
  },
  _updateWireWidthReadout(){
    const v = this.renderer.wireWidth.toFixed(1) + 'px';
    const el = document.getElementById('wire-width-readout');
    if(el) el.textContent = v;
    const el2 = document.getElementById('edit-wire-width-readout');
    if(el2) el2.textContent = v;
  },

  // =====================================================================
  // CANVAS MOUSE / WIRING / DRAGGING / PANNING / BOX-SELECT
  // =====================================================================
  _bindCanvasEvents(){
    const vp = this.el.viewport;
    vp.addEventListener('mousedown', (e)=> this._onMouseDown(e));
    vp.addEventListener('dblclick', (e)=> this._onDblClick(e));
    window.addEventListener('mousemove', (e)=> this._onMouseMove(e));
    window.addEventListener('mouseup', (e)=> this._onMouseUp(e));
    vp.addEventListener('wheel', (e)=>{
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const screenPoint = {x:e.clientX-rect.left, y:e.clientY-rect.top};
      const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
      this._zoomAtPoint(factor, screenPoint);
    }, {passive:false});
    vp.addEventListener('contextmenu', (e)=>{
      e.preventDefault();
      this._closeMenus();
      const rect = vp.getBoundingClientRect();
      const screenX = e.clientX-rect.left, screenY = e.clientY-rect.top;
      this._lastContextWorldPos = this.renderer.screenToWorld(screenX, screenY);
      // Select component under cursor if right-clicking one
      const compNode = e.target.closest && e.target.closest('.comp-node');
      let hitWireHit = null;
      if(compNode && compNode.dataset.id){
        if(!this.selection.selectedComponents.has(compNode.dataset.id))
          this.selection.selectOnly([compNode.dataset.id]);
        this._refreshAll();
      } else {
        // No component — check if we right-clicked near a wire
        hitWireHit = this._hitTestWireAtScreen(screenX, screenY, WIRE_HIT_PX);
        if(hitWireHit){
          const hitWireId = hitWireHit.id;
          if(!this.selection.selectedWires.has(hitWireId))
            this.selection.selectOnly([], [hitWireId]);
          this._refreshAll();
        }
      }
      const hasActiveSelection = this.selection.selectedComponents.size > 0 || this.selection.selectedWires.size > 0;
      // "Empty canvas" menu (Paste + Select only) applies when right-clicking
      // bare canvas with nothing selected. If something is already selected
      // (e.g. a group), right-clicking empty space should still bring up the
      // act-on-selection menu (Copy/Delete/etc.) rather than wiping it out.
      const isEmptyCanvas = !compNode && !hitWireHit && !hasActiveSelection;
      const ctxTruthTable = document.getElementById('ctx-truth-table');
      const ctxTruthTableSep = document.getElementById('ctx-truth-table-sep');
      const ctxKMap = document.getElementById('ctx-kmap');
      if(ctxTruthTable)    ctxTruthTable.style.display    = 'none';
      if(ctxTruthTableSep) ctxTruthTableSep.style.display = 'none';
      if(ctxKMap)           ctxKMap.style.display          = 'none';
      const ctxSelectMode = document.getElementById('ctx-select-mode');
      if(ctxSelectMode) ctxSelectMode.style.display = isEmptyCanvas ? 'flex' : 'none';
      const ctxSelectAll = document.getElementById('ctx-select-all');
      if(ctxSelectAll) ctxSelectAll.style.display = isEmptyCanvas ? 'flex' : 'none';
      const ctxConversionTool = document.getElementById('ctx-conversion-tool');
      const ctxConversionToolSep = document.getElementById('ctx-conversion-tool-sep');
      if(ctxConversionTool)    ctxConversionTool.style.display    = isEmptyCanvas ? 'flex'  : 'none';
      if(ctxConversionToolSep) ctxConversionToolSep.style.display = isEmptyCanvas ? 'block' : 'none';
      const ctxSimplifyCircuit = document.getElementById('ctx-simplify-circuit');
      if(ctxSimplifyCircuit) ctxSimplifyCircuit.style.display = isEmptyCanvas ? 'flex' : 'none';
      this._lastContextScreenPos = { x: e.clientX, y: e.clientY };
      // Reset to main items view
      const mainItems = document.getElementById('ctx-main-items');
      const propsSection = document.getElementById('ctx-props-section');
      if(mainItems) mainItems.style.display='block';
      if(propsSection) propsSection.style.display='none';
      // Reset per-item overrides from previous invocation
      const _ctxRotate = this.el.ctxMenu.querySelector('[data-action="rotate"]');
      const _ctxProps  = this.el.ctxMenu.querySelector('[data-action="properties"]');
      if(_ctxRotate) _ctxRotate.style.display = '';
      if(_ctxProps)  _ctxProps.style.display  = '';

      // Determine if the right-clicked component is a switch in a bank
      const rightClickedId = compNode && compNode.dataset.id;
      const rightClickedComp = rightClickedId ? this.model.getComponent(rightClickedId) : null;
      const isSwitch = rightClickedComp && rightClickedComp.type === 'SWITCH';
      const isVariable = rightClickedComp && rightClickedComp.type === 'VARIABLE';
      const bankEntry = isSwitch ? this._getBankForSwitch(rightClickedId) : null;
      const varBankEntry = isVariable ? this._getBankForSwitch(rightClickedId) : null;

      const standardCopy   = document.getElementById('ctx-copy-standard');
      const linkedCopyItem = document.getElementById('ctx-linked-copy');
      const bankGroup      = document.getElementById('ctx-bank-copy-group');
      const varCopyGroup   = document.getElementById('ctx-variable-copy-group');

      if(bankEntry){
        // Right-clicked a bank switch → show 4-option bank group, hide standard items
        if(standardCopy)   standardCopy.style.display   = 'none';
        if(linkedCopyItem) linkedCopyItem.style.display  = 'none';
        if(bankGroup)      bankGroup.style.display       = 'block';
        if(varCopyGroup)   varCopyGroup.style.display    = 'none';
        this._lastContextSwitchId = rightClickedId;
        this._lastContextBankEntry = bankEntry;
      } else if(isVariable){
        // Right-clicked a variable → show variable copy options
        if(standardCopy)   standardCopy.style.display   = 'none';
        if(linkedCopyItem) linkedCopyItem.style.display  = 'none';
        if(bankGroup)      bankGroup.style.display       = 'none';
        if(varCopyGroup)   varCopyGroup.style.display    = 'block';
        const lbl = document.getElementById('ctx-var-copy-same-lbl');
        if(lbl) lbl.textContent = `(${(rightClickedComp.label||'?').toUpperCase()})`;
        // Show/hide group section depending on whether this variable is in a bank
        const grpSection = document.getElementById('ctx-var-group-section');
        if(grpSection){
          if(varBankEntry && varBankEntry.ids.length > 1){
            grpSection.style.display = 'block';
            const grpLabel = document.getElementById('ctx-var-group-label');
            if(grpLabel) grpLabel.textContent = `Copy Whole Group (${varBankEntry.ids.length})`;
            // Build a letter summary like "A B C"
            const members = varBankEntry.ids.map(id=>this.model.getComponent(id)).filter(Boolean);
            const letters = members.map(m=>(m.label||'?').toUpperCase()).join(' ');
            const grpSameLbl = document.getElementById('ctx-var-group-same-lbl');
            if(grpSameLbl) grpSameLbl.textContent = `(${letters})`;
          } else {
            grpSection.style.display = 'none';
          }
        }
        this._lastContextSwitchId = rightClickedId;
        this._lastContextBankEntry = varBankEntry || null;
      } else {
        // Not a bank switch → restore standard copy items
        if(bankGroup)    bankGroup.style.display    = 'none';
        if(varCopyGroup) varCopyGroup.style.display = 'none';
        // When only wires are selected (no components), hide copy/rotate/properties
        const wireOnlySelected = this.selection.selectedComponents.size === 0 && this.selection.selectedWires.size > 0;
        if(standardCopy) standardCopy.style.display = wireOnlySelected ? 'none' : 'flex';
        if(linkedCopyItem){
          const hasSwitch = !wireOnlySelected && [...this.selection.selectedComponents].some(id=>{
            const sc = this.model.getComponent(id);
            return sc && sc.type === 'SWITCH';
          });
          linkedCopyItem.style.display = hasSwitch ? 'flex' : 'none';
        }
        const ctxRotate = this.el.ctxMenu.querySelector('[data-action="rotate"]');
        const ctxProps  = this.el.ctxMenu.querySelector('[data-action="properties"]');
        const ctxDeleteEl = this.el.ctxMenu.querySelector('[data-action="delete"]');
        // Rotate and Properties only make sense for a single component —
        // hide both whenever a whole group (2+ components) is selected,
        // since there's no single set of properties to show for a group.
        const isGroupSelected = this.selection.selectedComponents.size > 1;
        if(ctxRotate) ctxRotate.style.display = (wireOnlySelected || isGroupSelected) ? 'none' : '';
        if(ctxProps)  ctxProps.style.display  = (wireOnlySelected || isGroupSelected) ? 'none' : '';
        // Delete always applies to whatever is selected (single component,
        // group, or wire), so it stays visible here.
        if(ctxDeleteEl) ctxDeleteEl.style.display = '';
        // Truth Table Maker: offer it whenever at least one component is
        // selected (a single gate/output or a whole group), so the user can
        // generate a truth table for the selection without first deselecting.
        if(!wireOnlySelected && this.selection.selectedComponents.size > 0){
          if(ctxTruthTable)    ctxTruthTable.style.display    = 'flex';
          if(ctxTruthTableSep) ctxTruthTableSep.style.display = 'block';
          if(ctxKMap)           ctxKMap.style.display          = 'flex';
        }
        this._lastContextSwitchId = null;
        this._lastContextBankEntry = null;
      }
      // Right-clicking truly empty canvas (no component, no wire under the
      // cursor): the menu should offer nothing but Paste and Select — no
      // Copy/Rotate/Delete/Properties/Truth-Table items, since there's
      // nothing selected to act on.
      if(isEmptyCanvas){
        const ctxDelete = this.el.ctxMenu.querySelector('[data-action="delete"]');
        const ctxRotateEl = this.el.ctxMenu.querySelector('[data-action="rotate"]');
        const ctxPropsEl  = this.el.ctxMenu.querySelector('[data-action="properties"]');
        const propsSep = ctxPropsEl && ctxPropsEl.previousElementSibling;
        if(standardCopy)   standardCopy.style.display   = 'none';
        if(linkedCopyItem) linkedCopyItem.style.display = 'none';
        if(bankGroup)      bankGroup.style.display      = 'none';
        if(varCopyGroup)   varCopyGroup.style.display   = 'none';
        if(ctxDelete)      ctxDelete.style.display      = 'none';
        if(ctxRotateEl)    ctxRotateEl.style.display    = 'none';
        if(ctxPropsEl)     ctxPropsEl.style.display     = 'none';
        if(propsSep)        propsSep.style.display      = 'none';
        // Truth Table Maker and K-map generation both still apply on bare
        // canvas (whole-sheet scope), so keep them — and their shared
        // separator — visible even though the other selection-only items
        // above are hidden.
        if(ctxTruthTable)    ctxTruthTable.style.display    = 'flex';
        if(ctxTruthTableSep) ctxTruthTableSep.style.display = 'block';
        if(ctxKMap)           ctxKMap.style.display          = 'flex';
      }
      // Measure menu
      const menu = this.el.ctxMenu;
      menu.style.left = '-9999px'; menu.style.top = '-9999px';
      menu.style.display = 'block';
      const mw = menu.offsetWidth, mh = menu.offsetHeight;
      // If right-clicked a component, anchor to its right edge; else use cursor
      let anchorX = e.clientX, anchorY = e.clientY;
      if(compNode && compNode.dataset.id){
        const compId = compNode.dataset.id;
        const c = this.model.getComponent(compId);
        if(c){
          // Convert component right+top edge from world to screen
          const topRight  = this.renderer.worldToScreen(c.x + c.w, c.y);
          anchorX = rect.left + topRight.x + 18;
          anchorY = rect.top  + topRight.y;
        }
      }
      // Clamp so menu stays fully on screen
      const left = Math.min(anchorX, window.innerWidth  - mw - 8);
      const top  = Math.min(anchorY, window.innerHeight - mh - 8);
      menu.style.left = Math.max(8, left) + 'px';
      menu.style.top  = Math.max(8, top)  + 'px';
    });
  },
  _screenPosFromEvent(e){
    const rect = this.el.viewport.getBoundingClientRect();
    return {x:e.clientX-rect.left, y:e.clientY-rect.top};
  },
  _onMouseDown(e){
    // -1) Clicking inside a TEXT element currently being edited in-place
    // (see _startTextEdit) should behave like normal text editing — place
    // the caret, allow text selection — not start dragging the component.
    if(e.target && e.target.isContentEditable && e.target.classList && e.target.classList.contains('text-el-content')){
      return;
    }
    const screen = this._screenPosFromEvent(e);
    const world = this.renderer.screenToWorld(screen.x, screen.y);

    // 0) NODE temporarily unlocked (via double-click) -> this click drags it
    // like any other component, bypassing pin hit-testing entirely (which
    // would otherwise always win on a NODE, since its invisible pins sit
    // right where the click lands). The unlock is consumed by this single
    // drag — _onMouseUp re-locks it once the drag/click resolves, so the
    // node goes back to normal "every click wires" behavior afterward.
    // Any click that does NOT land on the unlocked node (clicking elsewhere,
    // a different component, empty canvas...) clears the unlock immediately
    // rather than leaving it silently armed for a later, unrelated click.
    if(this._unlockedNodeId){
      const clickedNode = e.target.closest && e.target.closest('.comp-node');
      const stillTarget = clickedNode && clickedNode.dataset.id === this._unlockedNodeId;
      if(stillTarget && e.button===0){
        const id = clickedNode.dataset.id;
        if(e.shiftKey){ this.selection.toggle(id,false); }
        else if(!this.selection.selectedComponents.has(id)){ this.selection.selectOnly([id]); }
        this.mode = 'dragging-components';
        this.dragStart = world;
        this.dragOrigins = new Map(); this._lastValidDragDelta = null;
        for(const cid of this.selection.selectedComponents){
          const c = this.model.getComponent(cid);
          if(c) this.dragOrigins.set(cid, {x:c.x, y:c.y});
        }
        this._refreshAll();
        return;
      } else {
        const prevNode = this.views.get(this._unlockedNodeId);
        if(prevNode) prevNode.classList.remove('node-unlocked');
        this._unlockedNodeId = null;
      }
    }

    // 1) Pin hit? -> click-to-wire: start or continue wire drawing
    const pinHit = this._hitTestPin(e.target);
    if(pinHit && e.button === 0){
      // If we're already drawing a wire, this pin click completes it
      if(this.activeWireDraw){
        this._finishWireDrawAt(pinHit.compId, pinHit.pinId);
        return;
      }
      // No wire drawing in progress — start one from this pin
      this._startWireDraw(pinHit);
      return;
    }

    if(this.activeWireDraw && e.button === 0 && !e.target.closest('.comp-node')){
      const draw = this.activeWireDraw;

      // 1a) Is there a real pin nearby, even though the click didn't land
      // exactly on it (e.g. the click is just outside the component's DOM
      // box, or landed on a wire that happens to pass close to the pin)?
      // A real pin always wins over tapping into a wire — otherwise routing
      // a new wire near an existing one, on the way to its actual target
      // pin, would get hijacked into an unwanted tap partway there.
      const nearPin = this._findNearestPinWithin(e.clientX, e.clientY, PIN_SNAP_PX, draw.fromComp, draw.fromPin);
      if(nearPin){
        this._finishWireDrawAt(nearPin.compId, nearPin.pinId);
        return;
      }

      // 1b) Clicked on an existing wire's path → tap into it: split the
      // wire with a NODE junction at the click point and complete the wire
      // being drawn by connecting onto that junction.
      const wireHit = this._hitTestWireAtScreen(screen.x, screen.y, WIRE_HIT_PX);
      if(wireHit){
        let w0 = this.renderer.screenToWorld(screen.x, screen.y);
        if(this.renderer.snapEnabled){
          w0.x = Utils.snap(w0.x, this.renderer.gridSize);
          w0.y = Utils.snap(w0.y, this.renderer.gridSize);
        }
        const tapPin = this._tapWireAt(wireHit.id, w0);
        if(tapPin) this._finishWireDrawAt(tapPin.compId, tapPin.pinId);
        else { this._clearWireDraw(); this._clearPendingWire(); }
        this._refreshAll();
        return;
      }

      // 1c) Otherwise, empty canvas → add a waypoint and keep drawing.
      const w = this.renderer.screenToWorld(screen.x, screen.y);
      if(this.renderer.snapEnabled){
        w.x = Utils.snap(w.x, this.renderer.gridSize);
        w.y = Utils.snap(w.y, this.renderer.gridSize);
      }
      this.activeWireDraw.waypoints.push(w);
      // Update preview
      this.activeWireDrag = {
        from: this._pinScreenPos(this.activeWireDraw.fromComp, this.activeWireDraw.fromPin, 'out'),
        to: screen,
        waypoints: this.activeWireDraw.waypoints,
        fromComp: this.activeWireDraw.fromComp,
        fromPin: this.activeWireDraw.fromPin
      };
      this.renderer.drawWires(this.model, (c,p,s)=>this._pinScreenPos(c,p,s), this.activeWireDrag);
      return;
    }

    // If drawing a wire and clicked on a component body → snap to nearest pin
    if(this.activeWireDraw && e.button === 0){
      const bodyNode = e.target.closest && e.target.closest('.comp-node');
      if(bodyNode){
        const draw = this.activeWireDraw;
        const pins = bodyNode.querySelectorAll('.pin');
        let best = null, bestDist = Infinity;
        for(const pin of pins){
          if(bodyNode.dataset.id === draw.fromComp && pin.dataset.pinId === draw.fromPin) continue;
          const r = pin.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const d = Math.sqrt((cx - e.clientX) ** 2 + (cy - e.clientY) ** 2);
          if(d < bestDist){ bestDist = d; best = pin; }
        }
        if(best){
          this._finishWireDrawAt(bodyNode.dataset.id, best.dataset.pinId);
        } else {
          this._clearWireDraw();
          this._clearPendingWire();
        }
        return;
      }
    }

    // Cancel wire drawing if click lands on empty canvas with no waypoint intent
    // (handled above by adding a waypoint, so reaching here means no draw active)

    // 1.5) Old pending wire compatibility — no longer used but kept for safety
    if(this.pendingWirePin) this._clearPendingWire();

    // 2) Switch/Variable hit -> behaves like any other component for dragging, but
    // ALSO arms a "pending toggle": if the mouse releases again without
    // having moved more than a few pixels (a genuine click, not a drag),
    // _onMouseUp() flips the switch. This is what lets a switch be both
    // draggable and clickable without one gesture stealing the other —
    // previously a mousedown on the switch toggled it immediately and
    // returned, so dragging never had a chance to start.
    // Hit-tested against the whole .comp-node (not a separate overlay div)
    // so the toggle fires no matter where on the component you click.
    // IMPORTANT: only the left mouse button (button 0) arms this. A
    // right-click (button 2) on a switch must NOT toggle it — it should
    // just open the context menu, same as right-clicking any other
    // component. Without this check, a right-click's mousedown still
    // armed the pending toggle and its mouseup (with no movement) fired
    // it, silently flipping the switch every time you right-clicked it.
    const switchNode = e.button===0 ? (e.target.closest && e.target.closest('.comp-node')) : null;
    if(switchNode && (switchNode.dataset.ctype === 'SWITCH' || switchNode.dataset.ctype === 'VARIABLE')){
      this._clearWireDraw();
      const node = switchNode;
      const id = node.dataset.id;
      if(e.shiftKey){ this.selection.toggle(id,false); }
      else if(!this.selection.selectedComponents.has(id)){ this.selection.selectOnly([id]); }
      // If this switch belongs to a bank, force ALL bank members into the
      // selection so they always move as one unit — no member can be
      // dragged out of the bank independently.
      this._expandSelectionForBanks();
      this.mode = 'dragging-components';
      this.dragStart = world;
      this.dragOrigins = new Map(); this._lastValidDragDelta = null;
      for(const cid of this.selection.selectedComponents){
        const c = this.model.getComponent(cid);
        if(c) this.dragOrigins.set(cid, {x:c.x, y:c.y});
      }
      this._pendingToggleId = id;
      this._pendingToggleStartScreen = screen;
      this._refreshAll();
      return;
    }

    // 3) Component body hit -> select + start drag
    const compNode = e.target.closest && e.target.closest('.comp-node');
    if(compNode){
      this._clearWireDraw();
      const id = compNode.dataset.id;
      if(e.shiftKey){ this.selection.toggle(id,false); }
      else if(!this.selection.selectedComponents.has(id)){ this.selection.selectOnly([id]); }
      // Same bank-locking for non-switch components caught by the generic handler
      this._expandSelectionForBanks();
      this.mode = 'dragging-components';
      this.dragStart = world;
      this.dragOrigins = new Map(); this._lastValidDragDelta = null;
      for(const cid of this.selection.selectedComponents){
        const c = this.model.getComponent(cid);
        if(c) this.dragOrigins.set(cid, {x:c.x, y:c.y});
      }
      this._refreshAll();
      return;
    }

    // 4) Empty canvas: check if click hit a wire segment for dragging
    if(e.button === 0 && !this.activeWireDraw){
      const hitResult = this._hitTestWireAtScreen(screen.x, screen.y, WIRE_HIT_PX);
      if(hitResult){
        const wire = this.model.wires.get(hitResult.id);
        if(wire){
          if(!e.shiftKey) this.selection.selectOnly([], [hitResult.id]);
          else this.selection.selectedWires.add(hitResult.id);
          // Start dragging this wire segment.
          //
          // wire.waypoints is a flat list of points; the dragged segment
          // runs between waypoints[segA] and waypoints[segA+1]. An interior
          // point is also the endpoint of its neighboring segment (e.g. one
          // corner of the router's L-bend, where a horizontal run hands
          // off to a vertical jog). If we dragged that point as-is, the
          // neighboring segment would move too, since it shares the same
          // point.
          //
          // Fix: give the dragged segment its own *private* copy of each
          // boundary point that isn't a true pin anchor (index 0 / last).
          // The duplicate is inserted right next to the original; the drag
          // moves only the duplicates, by the same delta, so the segment
          // translates as a rigid whole (this matters for L-bend corner
          // segments especially — both of its corners must move together
          // or the bend breaks into a jagged kink). The original point
          // stays put, so whatever neighbor segment was using it doesn't move.
          this.mode = 'dragging-wire-segment';
          this._dragWireId = hitResult.id;
          this._dragWireStart = world;
          this._ensureWireWaypoints(wire);
          if(!wire.waypoints || wire.waypoints.length < 2) {
            this.mode = 'idle';
            return;
          }

          // Which segment, exactly? Test directly against THIS wire's own
          // (now-materialized) waypoints at the click coordinates — the same
          // function the hover highlight uses — instead of translating an
          // index from hitResult.segmentIndex (which was computed against a
          // separately-reconstructed pin-dot→stub→…→pin-dot render path).
          // That translation assumed a fixed +1/-1 offset between the two
          // index spaces, which only holds if every waypoint pair re-routes
          // to exactly 2 points; whenever it didn't, the offset silently
          // pointed at a neighboring segment instead of the clicked one.
          // Hit-testing the same waypoint list that gets edited removes that
          // assumption entirely — there's only one index space now.
          const bodyHit = this._hitTestWireBodySegment(wire, screen.x, screen.y, WIRE_HIT_PX);
          if(!bodyHit){
            // Clicked on a stub segment or pin-dot stub — just select, no drag
            this.mode = 'idle';
            this._refreshAll();
            return;
          }

          const segA = bodyHit.segIndex;
          const segARightIdx = segA + 1;
          const lastIdx = wire.waypoints.length - 1;
          const pA = wire.waypoints[segA], pB = wire.waypoints[segARightIdx];
          const leftIsAnchor  = (segA === 0);
          const rightIsAnchor = (segARightIdx === lastIdx);

          // Lock the drag to whichever axis the segment is perpendicular to,
          // so a horizontal run can only slide vertically (and vice versa) —
          // this is what keeps the segment's own orientation intact AND keeps
          // its still-anchored neighbor segments from kinking off-axis, since
          // those neighbors share an unmoved endpoint whose other coordinate
          // (x for a vertical neighbor, y for a horizontal one) now matches.
          const AXIS_EPS = 0.5;
          const segDx = Math.abs(pB.x - pA.x), segDy = Math.abs(pB.y - pA.y);
          if(segDy < AXIS_EPS && segDx >= AXIS_EPS) this._dragWireAxis = 'h';      // horizontal segment → vertical-only drag
          else if(segDx < AXIS_EPS && segDy >= AXIS_EPS) this._dragWireAxis = 'v'; // vertical segment → horizontal-only drag
          else this._dragWireAxis = 'free';                                       // near-degenerate segment → unconstrained (rare)

          if(!rightIsAnchor){
            wire.waypoints.splice(segARightIdx, 0, { x: pB.x, y: pB.y });
          }
          let dragLeftIdx = segA;
          if(!leftIsAnchor){
            wire.waypoints.splice(segA + 1, 0, { x: pA.x, y: pA.y });
            dragLeftIdx = segA + 1;
          }
          this._dragWireSegIdx = dragLeftIdx;
          this._dragWireOrigWaypoints = wire.waypoints.map(p=>({x:p.x,y:p.y}));
          this._refreshAll();
          return;
        }
      }
    }

    // 4b) Empty canvas: middle-click/space/shift = box-select, plain
    // left-drag = pan. Plain left-drag panning is the primary way to move
    // around on touch devices (no middle mouse button, no spacebar), so
    // it takes the default gesture; box-select moves to Shift+drag.
    // Clicking the grid itself — even when it's not hitting a component —
    // counts as "doing something in the workspace" and closes the bar.
    // Right-click (button 2) on empty canvas: do nothing here — the
    // contextmenu event will handle wire hit-testing and menu display,
    // so we must NOT clear the selection or start a box-select now.
    if(e.button === 2) return;
    this._closeMenus();
    if(e.shiftKey || this.selectModeOn){
      this.mode = 'box-select';
      this.boxSelectStart = screen;
      this.el.selectionBox.style.display='block';
      this._updateSelectionBoxDOM(screen, screen);
      return;
    }
    // If a group/selection is already active and the user presses down on
    // empty space, don't immediately pan-and-clear. Arm a "pending clear":
    // if the mouse releases without having moved (a genuine click), the
    // selection is cleared as before. But if the mouse moves first, treat
    // it as a drag of the currently-selected components (so an existing
    // group can be moved by pressing anywhere on empty canvas and dragging,
    // not just by grabbing one of its elements directly).
    if(this.selection.selectedComponents.size > 0){
      this.mode = 'dragging-components';
      this.dragStart = world;
      this.dragOrigins = new Map(); this._lastValidDragDelta = null;
      for(const cid of this.selection.selectedComponents){
        const c = this.model.getComponent(cid);
        if(c) this.dragOrigins.set(cid, {x:c.x, y:c.y});
      }
      this._pendingEmptyClickClear = true;
      this._pendingEmptyClickStartScreen = screen;
      this._refreshAll();
      return;
    }
    this.mode = 'panning';
    this.dragStart = screen;
    this._panOrigin = {...this.renderer.pan};
    this.selection.clear();
  },
  /** Double-click on a NODE "unlocks" it for exactly one subsequent drag.
   *  NODE's whole clickable area is covered by its (invisible) pins, which
   *  normally claim every mousedown for wiring — there's no plain "body"
   *  patch left to grab once the pins are sized for easy wiring. Rather
   *  than shrinking the pins again (which made wiring fiddly), a
   *  double-click here flags the node as unlocked; the very next mousedown
   *  on it (handled in step 0 of _onMouseDown) drags it like a normal
   *  component instead of starting a wire. Both clicks that make up the
   *  double-click already ran through _onMouseDown/_onMouseUp first (likely
   *  arming a pending wire on the dot), so that pending state is cleared
   *  here too — otherwise the node would end up both "unlocked" and glowing
   *  with a pending wire at the same time. */
  _onDblClick(e){
    if(e.button !== 0) return;
    const node = e.target.closest && e.target.closest('.comp-node');
    if(!node){
      // Empty-canvas double-click no longer toggles select mode — selection
      // mode is now activated via the right-click context menu's "Select"
      // item instead (see _enterSelectMode / contextmenu handler below).
      return;
    }
    if(node.dataset.ctype === 'TEXT'){
      e.preventDefault();
      this._startTextEdit(node.dataset.id, node);
      return;
    }
    if(node.dataset.ctype !== 'NODE') return;
    e.preventDefault();
    this._clearPendingWire();
    this.activeWireDrag = null;
    this._unlockedNodeId = node.dataset.id;
    node.classList.add('node-unlocked');
  },
  /** Double-click on a TEXT element enters in-place editing: the text's own
   *  DOM node becomes contenteditable and receives focus, so the user just
   *  types over it right there on the canvas (no popup/modal). Enter or
   *  clicking away commits the change; Escape reverts. Empty text falls
   *  back to the default "Text" placeholder rather than leaving a
   *  zero-size blank label behind. */
  _startTextEdit(compId, node){
    const c = this.model.getComponent(compId);
    if(!c || c.type !== 'TEXT') return;
    const txt = node.querySelector('.text-el-content');
    if(!txt) return;
    this._clearPendingWire();
    this.selection.selectOnly([compId]);
    this._refreshAll();
    const original = (c.state && c.state.text) || 'Text';
    txt.contentEditable = 'true';
    txt.textContent = original;
    txt.focus();
    document.execCommand && document.execCommand('selectAll', false, null);
    const commit = (cancel)=>{
      txt.removeEventListener('blur', onBlur);
      txt.removeEventListener('keydown', onKeydown);
      txt.contentEditable = 'false';
      if(!cancel){
        const val = txt.textContent.replace(/\n+$/,'').trim();
        c.state = c.state || {};
        c.state.text = val === '' ? 'Text' : val;
        this.history.commit();
      }
      const compNode = this.views.get(c.id);
      if(compNode) ComponentView.sync(c, compNode);
      this.markDirty();
      this._repairWiresAroundObstacles([c.id]);
    };
    const onBlur = ()=> commit(false);
    const onKeydown = (e)=>{
      if(e.key === 'Enter' && !e.shiftKey){ e.preventDefault(); txt.blur(); }
      else if(e.key === 'Escape'){ e.preventDefault(); commit(true); }
    };
    txt.addEventListener('blur', onBlur);
    txt.addEventListener('keydown', onKeydown);
  },
  _onMouseMove(e){
    const screen = this._screenPosFromEvent(e);
    this._lastMouseScreen = screen;
    const world = this.renderer.screenToWorld(screen.x, screen.y);
    document.getElementById('cursor-coords').textContent = `x: ${Math.round(world.x)}, y: ${Math.round(world.y)}`;

    if(this.mode==='wiring'){
      this.activeWireDrag.to = screen;
      // Track if the user has actually dragged (vs just clicked a pin)
      const from = this.activeWireDrag.from;
      const dx = screen.x - from.x, dy = screen.y - from.y;
      if(Math.sqrt(dx*dx+dy*dy) > 6) this._wireDragMoved = true;
      const target = this._hitTestPin(e.target, true);
      document.querySelectorAll('.pin-hover-target').forEach(p=>p.classList.remove('pin-hover-target'));
      if(target){
        const side = target.side === 'in' ? 'pin-in' : 'pin-out';
        const el = document.querySelector(`.comp-node[data-id="${target.compId}"] .${side}[data-pin-id="${target.pinId}"]`);
        if(el) el.classList.add('pin-hover-target');
      } else {
        // Body hover: highlight the nearest pin (any side) while drag-wiring over a component body
        const bodyNode = e.target.closest && e.target.closest('.comp-node');
        if(bodyNode && this.activeWireDrag){
          const pins = bodyNode.querySelectorAll('.pin');
          let best = null, bestDist = Infinity;
          for(const pin of pins){
            if(bodyNode.dataset.id === this.activeWireDrag.fromComp && pin.dataset.pinId === this.activeWireDrag.fromPin) continue;
            const r = pin.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const d = Math.sqrt((cx - e.clientX) ** 2 + (cy - e.clientY) ** 2);
            if(d < bestDist){ bestDist = d; best = pin; }
          }
          if(best) best.classList.add('pin-hover-target');
        }
      }
      return;
    }
    // Live preview while drawing a multi-click wire
    if(this.activeWireDraw){
      const target = this._hitTestPin(e.target, true);
      this.activeWireDrag = {
        from: this._pinScreenPos(this.activeWireDraw.fromComp, this.activeWireDraw.fromPin, 'out'),
        to: screen,
        waypoints: this.activeWireDraw.waypoints,
        fromComp: this.activeWireDraw.fromComp,
        fromPin: this.activeWireDraw.fromPin,
        toComp: target ? target.compId : null,
        toPin: target ? target.pinId : null
      };
      // Highlight hovered pins
      document.querySelectorAll('.pin-hover-target').forEach(p=>p.classList.remove('pin-hover-target'));
      if(target){
        const side = target.side === 'in' ? 'pin-in' : 'pin-out';
        const el = document.querySelector(`.comp-node[data-id="${target.compId}"] .${side}[data-pin-id="${target.pinId}"]`);
        if(el) el.classList.add('pin-hover-target');
      }
      this.renderer.drawWires(this.model, (c,p,s)=>this._pinScreenPos(c,p,s), this.activeWireDrag);
      return;
    }
    if(this.mode==='dragging-wire-segment'){
      const wire = this.model.wires.get(this._dragWireId);
      if(!wire || !wire.waypoints) return;
      let dx = world.x - this._dragWireStart.x;
      let dy = world.y - this._dragWireStart.y;
      // Axis lock: a horizontal segment may only slide along Y (no left/right
      // drift), a vertical segment may only slide along X (no up/down drift).
      // Zeroing out the disallowed component is enough — both endpoints below
      // get the same (dx,dy), which is a pure translation, so the segment
      // keeps its exact original orientation and length.
      const orig = this._dragWireOrigWaypoints;
      const si = this._dragWireSegIdx;
      if(this._dragWireAxis === 'h') dx = 0;
      else if(this._dragWireAxis === 'v') dy = 0;
      if(this.renderer.snapEnabled){
        if(this._dragWireAxis === 'h') dy = Utils.snap(orig[si].y + dy, this.renderer.gridSize) - orig[si].y;
        else if(this._dragWireAxis === 'v') dx = Utils.snap(orig[si].x + dx, this.renderer.gridSize) - orig[si].x;
      }
      // The dragged segment runs between waypoint[si] and waypoint[si+1].
      // These two points were freshly duplicated for this drag (see
      // _onMouseDown), so they belong only to this segment — moving them
      // never affects any neighboring segment. The only points that must
      // stay fixed are the true pin anchors at index 0 and the last index.
      const n = orig.length;
      wire.waypoints = orig.map((p,i)=>({x:p.x,y:p.y}));
      if(si > 0) wire.waypoints[si] = { x: orig[si].x + dx, y: orig[si].y + dy };
      if(si+1 < n-1) wire.waypoints[si+1] = { x: orig[si+1].x + dx, y: orig[si+1].y + dy };
      this.markDirty();
      return;
    }
    if(this.mode==='dragging-components'){
      let dx = world.x - this.dragStart.x, dy = world.y - this.dragStart.y;
      if(this.renderer.snapEnabled){
        // Snap the *first* selected component's resulting position, apply same delta to all (keeps relative layout exact while staying grid-aligned).
        const [firstId] = this.selection.selectedComponents;
        const origin = this.dragOrigins.get(firstId);
        if(origin){
          const snappedX = Utils.snap(origin.x+dx, this.renderer.gridSize);
          const snappedY = Utils.snap(origin.y+dy, this.renderer.gridSize);
          dx = snappedX - origin.x; dy = snappedY - origin.y;
        }
      }
      // Bounded canvas: clamp the group delta so no dragged component can
      // cross the sheet's edge into the border / off the canvas.
      if(this.renderer.canvasCols && this.renderer.canvasRows){
        const canvasW = this.renderer.canvasCols * this.renderer.gridSize;
        const canvasH = this.renderer.canvasRows * this.renderer.gridSize;
        let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
        for(const [id, origin] of this.dragOrigins){
          const c = this.model.getComponent(id);
          if(!c) continue;
          const s = c.renderedSize();
          minX = Math.min(minX, origin.x); minY = Math.min(minY, origin.y);
          maxX = Math.max(maxX, origin.x+s.w); maxY = Math.max(maxY, origin.y+s.h);
        }
        if(isFinite(minX)){
          dx = Utils.clamp(dx, -minX, canvasW - maxX);
          dy = Utils.clamp(dy, -minY, canvasH - maxY);
        }
      }
      // Collision clamping: compute proposed positions and check against
      // non-selected components. If any overlap, revert to last valid delta.
      const selectedIds = new Set(this.selection.selectedComponents);
      const PAD = 4;
      let collides = false;
      for(const [id, origin] of this.dragOrigins){
        const c = this.model.getComponent(id);
        if(!c) continue;
        const s = c.renderedSize();
        const nx = origin.x+dx, ny = origin.y+dy;
        for(const other of this.model.components.values()){
          if(selectedIds.has(other.id)) continue;
          const os = other.renderedSize();
          if(nx < other.x+os.w+PAD && nx+s.w+PAD > other.x &&
             ny < other.y+os.h+PAD && ny+s.h+PAD > other.y){ collides=true; break; }
        }
        if(collides) break;
      }
      if(!collides){
        this._lastValidDragDelta = {dx, dy};
        for(const [id, origin] of this.dragOrigins){
          const c = this.model.getComponent(id);
          if(c){ c.x = origin.x+dx; c.y = origin.y+dy; }
        }
      } else if(this._lastValidDragDelta){
        // Keep components at last valid position (already set)
      }
      this.markDirty();
      return;
    }
    if(this.mode==='panning'){
      this.renderer.pan.x = this._panOrigin.x + (screen.x - this.dragStart.x);
      this.renderer.pan.y = this._panOrigin.y + (screen.y - this.dragStart.y);
      this.renderer.draw();
      this.markDirty();
      return;
    }
    if(this.mode==='box-select'){
      this._updateSelectionBoxDOM(this.boxSelectStart, screen);
      this._applyBoxSelection(this.boxSelectStart, screen);
      return;
    }
    // Idle: show pointer cursor + highlight the specific segment under the
    // cursor when hovering a draggable wire — gives users a clear "this is
    // what will move" signal before they commit to a drag. Uses the exact
    // same per-wire hit test that drag pickup uses (_hitTestWireBodySegment),
    // so whatever lights up here is guaranteed to be what actually moves.
    if(this.mode==='idle' && !this.activeWireDraw){
      const hit = this._hitTestWireAtScreen(screen.x, screen.y, WIRE_HIT_PX);
      const wire = hit ? this.model.wires.get(hit.id) : null;
      const bodyHit = wire ? this._hitTestWireBodySegment(wire, screen.x, screen.y, WIRE_HIT_PX) : null;
      this.el.viewport.style.cursor = bodyHit ? 'grab' : '';
      const newHover = bodyHit ? { wireId: wire.id, waypoints: bodyHit.waypoints, segIndex: bodyHit.segIndex } : null;
      const prev = this._hoverWireSeg;
      const changed = (prev ? prev.wireId : null) !== (newHover ? newHover.wireId : null)
                   || (prev ? prev.segIndex : null) !== (newHover ? newHover.segIndex : null);
      if(changed){
        this._hoverWireSeg = newHover;
        this.renderer.drawWires(this.model, (c,p,s)=>this._pinScreenPos(c,p,s), this.activeWireDrag, this._hoverWireSeg);
      }
    } else if(this.mode==='dragging-wire-segment'){
      this.el.viewport.style.cursor = 'grabbing';
    }
  },
  _onMouseUp(e){
    const wasIdle = this.mode === 'idle';
    let didAction = false; // tracks whether something actually happened to the
                            // circuit this mouseup (vs. just panning/box-select/
                            // a click that landed on nothing) — only a real
                            // action closes the Elements bar.
    if(this.mode==='wiring'){
      let target = this._hitTestPin(e.target, true);
      const dragged = this._wireDragMoved;
      this._wireDragMoved = false;

      // Body fallback: if drag-wire released over a component body (not a pin),
      // snap to the nearest pin on that component (any side).
      if(!target && dragged){
        const bodyNode = e.target.closest && e.target.closest('.comp-node');
        if(bodyNode){
          const pins = bodyNode.querySelectorAll('.pin');
          let best = null, bestDist = Infinity;
          for(const pin of pins){
            if(bodyNode.dataset.id === this.activeWireDrag.fromComp && pin.dataset.pinId === this.activeWireDrag.fromPin) continue;
            const r = pin.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const d = Math.sqrt((cx - e.clientX) ** 2 + (cy - e.clientY) ** 2);
            if(d < bestDist){ bestDist = d; best = pin; }
          }
          if(best) target = { compId: bodyNode.dataset.id, pinId: best.dataset.pinId, side: best.dataset.side };
        }
      }

      // Second fallback: the drop point may be near a real pin without
      // being over that component's DOM box at all (e.g. it landed on a
      // wire that happens to pass close to the pin). A real pin always
      // wins over tapping into a wire, so check a slightly wider radius
      // across ALL pins before considering a wire tap — otherwise a drag
      // aimed at a pin, but not landed perfectly on it, could get hijacked
      // into an unwanted wire-to-wire tap partway there.
      if(!target && dragged){
        const dropScreen = this._screenPosFromEvent(e);
        const nearPin = this._findNearestPinWithin(e.clientX, e.clientY, PIN_SNAP_PX, this.activeWireDrag.fromComp, this.activeWireDrag.fromPin);
        if(nearPin) target = nearPin;
      }

      // Third fallback: if still no pin/component target, check whether the
      // wire was dropped onto an existing wire's path — tap into it with a
      // NODE junction at the drop point so the new wire links onto the
      // existing one instead of being discarded.
      let tapPin = null;
      if(!target && dragged){
        const dropScreen = this._screenPosFromEvent(e);
        const wireHit = this._hitTestWireAtScreen(dropScreen.x, dropScreen.y, WIRE_HIT_PX);
        if(wireHit){
          let w0 = this.renderer.screenToWorld(dropScreen.x, dropScreen.y);
          if(this.renderer.snapEnabled){
            w0.x = Utils.snap(w0.x, this.renderer.gridSize);
            w0.y = Utils.snap(w0.y, this.renderer.gridSize);
          }
          tapPin = this._tapWireAt(wireHit.id, w0);
          if(tapPin) target = tapPin;
        }
      }

      if(dragged){
        // Drag-wire: complete immediately if dropped on any pin (or a
        // junction just created by tapping into an existing wire above)
        if(target && !(target.compId===this.activeWireDrag.fromComp && target.pinId===this.activeWireDrag.fromPin)){
          const wire = new CircuitWire(this.activeWireDrag.fromComp, this.activeWireDrag.fromPin, target.compId, target.pinId);
          this.model.addWire(wire);
          this.markDirty();
          this.history.commit();
          didAction = true;
        }
        document.querySelectorAll('.pin-hover-target').forEach(p=>p.classList.remove('pin-hover-target'));
        this.activeWireDrag = null;
      } else {
        // Click (no drag) on a pin: start wire-drawing mode
        const pending = { compId: this.activeWireDrag.fromComp, pinId: this.activeWireDrag.fromPin, side: this.activeWireDrag.fromSide };
        this.activeWireDrag = null;
        this._startWireDraw(pending);
      }
    }
    if(this.mode==='dragging-wire-segment'){
      const wire = this.model.wires.get(this._dragWireId);
      if(wire) this._simplifyWireWaypoints(wire);
      this.history.commit();
      this.el.viewport.style.cursor = '';
      this._hoverWireSeg = null; // stale: segment indices shifted after simplify
      didAction = true;
    }
    if(this.mode==='dragging-components'){
      // Resolve a pending "clicked empty space while a group was selected"
      // state: if the mouse never actually moved, this was a genuine click
      // on empty space, not a drag — clear the selection as before. If it
      // did move, the group was dragged, so leave the selection (and its
      // new position) intact.
      if(this._pendingEmptyClickClear){
        const screen = this._screenPosFromEvent(e);
        const moved = Utils.dist(screen.x, screen.y, this._pendingEmptyClickStartScreen.x, this._pendingEmptyClickStartScreen.y);
        if(moved < 5){
          this.selection.clear();
          this.history.commit(); // no-op commit is harmless; keeps history consistent
        } else {
          didAction = true;
        }
        this._pendingEmptyClickClear = false; this._pendingEmptyClickStartScreen = null;
        this.mode = 'idle';
        this._refreshAll();
        if(didAction) this._closeMenus();
        return;
      }
      // Resolve any pending switch toggle: only counts as a toggle if the
      // mouse stayed within a small click threshold (didn't actually drag).
      if(this._pendingToggleId){
        const screen = this._screenPosFromEvent(e);
        const moved = Utils.dist(screen.x, screen.y, this._pendingToggleStartScreen.x, this._pendingToggleStartScreen.y);
        if(moved < 5){
          const comp = this.model.getComponent(this._pendingToggleId);
          if(comp && (comp.type === 'SWITCH' || comp.type === 'VARIABLE')){
            if(comp.type === 'SWITCH') this.toggleLinkedSwitch(comp);
            else this.toggleLinkedVariable(comp);
            this.markDirty();
            didAction = true;
          }
        } else {
          didAction = true; // it was a real drag of the component, not a toggle
        }
        this._pendingToggleId = null; this._pendingToggleStartScreen = null;
      } else {
        didAction = true; // ordinary component drag (no pending toggle involved)
      }
      this.history.commit();
      // A dropped component may now sit on top of another wire's fixed
      // bend point — repair any wire whose custom waypoints collide with
      // where this drag ended up.
      this._repairWiresAroundObstacles(this.selection.selectedComponents);
      // Consume the NODE unlock now that its one drag/click has resolved —
      // back to normal "every click wires" behavior from here on.
      if(this._unlockedNodeId){
        const n = this.views.get(this._unlockedNodeId);
        if(n) n.classList.remove('node-unlocked');
        this._unlockedNodeId = null;
      }
    }
    if(this.mode==='box-select'){
      this.el.selectionBox.style.display='none';
      // A plain click (no real drag) on empty space — i.e. the box-select
      // rectangle never actually grew — means the user just wants to
      // deselect and leave selection mode, rather than draw a selection
      // box. Distinguish that from an intentional drag-select by checking
      // movement distance from where the mousedown started.
      const upScreen = this._screenPosFromEvent(e);
      const dx = upScreen.x - this.boxSelectStart.x, dy = upScreen.y - this.boxSelectStart.y;
      const wasRealDrag = Math.sqrt(dx*dx + dy*dy) > 4;
      if(!wasRealDrag){
        this.selection.clear();
        this._refreshAll();
        if(this.selectModeOn) this._exitSelectMode();
      }
    }
    this.mode = 'idle';
    // `mouseup` is bound on `window` (not just the canvas viewport) so that a
    // drag/wire/pan started inside the canvas still resolves correctly even
    // if the button is released outside it. But that means this handler also
    // fires for completely unrelated clicks elsewhere on the page (e.g. a
    // button in the Properties panel) — if `mode` was already 'idle', the
    // canvas had nothing in progress, so skip the refresh. Rebuilding the
    // properties panel here was not just wasted work: it destroyed and
    // recreated the very button being clicked *before* the browser's own
    // synthetic `click` event fired on it, so the button's click handler
    // (e.g. the input-count +/- controls) silently never ran.
    if(!wasIdle) this._refreshAll();
    // Only an actual change in the workspace (wire connected, component
    // moved, switch toggled) closes the Elements bar. Plain panning,
    // box-selecting, or clicking empty canvas leaves it open.
    if(didAction) this._closeMenus();
  },
  _updateSelectionBoxDOM(a,b){
    const x = Math.min(a.x,b.x), y=Math.min(a.y,b.y), w=Math.abs(a.x-b.x), h=Math.abs(a.y-b.y);
    Object.assign(this.el.selectionBox.style, {left:x+'px', top:y+'px', width:w+'px', height:h+'px'});
  },
  _applyBoxSelection(a,b){
    const wa = this.renderer.screenToWorld(a.x,a.y), wb = this.renderer.screenToWorld(b.x,b.y);
    const minX=Math.min(wa.x,wb.x), maxX=Math.max(wa.x,wb.x), minY=Math.min(wa.y,wb.y), maxY=Math.max(wa.y,wb.y);
    const ids = [];
    for(const c of this.model.components.values()){
      const size = c.renderedSize();
      if(c.x < maxX && c.x+size.w > minX && c.y < maxY && c.y+size.h > minY) ids.push(c.id);
    }
    // Also select wires whose bezier path passes through the selection box
    const wireIds = [];
    for(const wire of this.model.wires.values()){
      if(this._wireIntersectsWorldRect(wire, minX, minY, maxX, maxY)) wireIds.push(wire.id);
    }
    // Truth table panels are screen-fixed (position:fixed) overlays, not
    // world-space model components, so test them against the raw screen-
    // space selection rect rather than the world-space one used above.
    const sx0 = Math.min(a.x,b.x), sx1 = Math.max(a.x,b.x), sy0 = Math.min(a.y,b.y), sy1 = Math.max(a.y,b.y);
    const ttIds = [];
    if(this._ttPanels){
      for(const table of this._ttPanels){
        const panel = table.panelEl;
        if(!panel || panel.style.display === 'none') continue;
        const r = panel.getBoundingClientRect();
        if(r.left < sx1 && r.right > sx0 && r.top < sy1 && r.bottom > sy0) ttIds.push(table.id);
      }
    }
    // K-map panels are the same kind of screen-fixed overlay element as
    // truth tables, so they get box-selected the same way.
    const kmIds = [];
    if(this._kmPanels){
      for(const panel of this._kmPanels){
        const el = panel.panelEl;
        if(!el || el.style.display === 'none') continue;
        const r = el.getBoundingClientRect();
        if(r.left < sx1 && r.right > sx0 && r.top < sy1 && r.bottom > sy0) kmIds.push(panel.id);
      }
    }
    this.selection.selectOnly(ids, wireIds, ttIds, kmIds);
    this._ttApplySelectionHighlight();
    this._kmApplySelectionHighlight();
    this._expandSelectionForBanks();
    this._refreshAll();
  },
  /** Mirrors this.selection.selectedTruthTables onto each panel's DOM via
   *  the .selected class, so box-select visually highlights truth tables
   *  the same way components/wires get highlighted. */
  _ttApplySelectionHighlight(){
    if(!this._ttPanels) return;
    for(const table of this._ttPanels){
      if(!table.panelEl) continue;
      table.panelEl.classList.toggle('selected', this.selection.selectedTruthTables.has(table.id));
    }
  },
  /** Same as _ttApplySelectionHighlight but for K-map panels, which are
   *  selectable/deletable workspace elements just like truth tables. */
  _kmApplySelectionHighlight(){
    if(!this._kmPanels) return;
    for(const panel of this._kmPanels){
      if(!panel.panelEl) continue;
      panel.panelEl.classList.toggle('selected', this.selection.selectedKMaps.has(panel.id));
    }
  },
  /** Returns true if the wire's orthogonal routed path passes through
   *  the given world-space axis-aligned bounding box. */
  _wireIntersectsWorldRect(wire, minX, minY, maxX, maxY){
    const fromStub = WireRouter._resolveStub(wire.fromComp, wire.fromPin, this.model);
    const toStub   = WireRouter._resolveStub(wire.toComp,   wire.toPin,   this.model);
    if(!fromStub || !toStub) return false;

    const obs = WireRouter._obstacles(this.model, wire.fromComp, wire.toComp)
      .concat(WireRouter._pinObstacles(this.model, wire.fromComp, wire.fromPin, wire.toComp, wire.toPin));

    let pts;
    if(wire.waypoints && wire.waypoints.length >= 2){
      const wps = wire.waypoints.map(p=>({x:p.x,y:p.y}));
      wps[0] = fromStub.stubPos; wps[wps.length-1] = toStub.stubPos;
      pts = [];
      for(let i=0;i<wps.length-1;i++){
        const seg = WireRouter.route(wps[i], wps[i+1], obs);
        if(i===0) pts.push(...seg); else pts.push(...seg.slice(1));
      }
    } else {
      pts = WireRouter.route(fromStub.stubPos, toStub.stubPos, obs);
    }
    // Include the stub segments and pin dots in the intersection test
    pts.unshift(fromStub.pinPos);
    pts.push(toStub.pinPos);

    const inBox = (p) => p.x>=minX&&p.x<=maxX&&p.y>=minY&&p.y<=maxY;
    for(let s=0; s<pts.length-1; s++){
      const a=pts[s], b=pts[s+1];
      const STEPS=20;
      for(let i=0; i<=STEPS; i++){
        const t=i/STEPS;
        if(inBox({x:a.x+(b.x-a.x)*t, y:a.y+(b.y-a.y)*t})) return true;
      }
    }
    return false;
  },
  /** Returns the id of the wire whose routed path is closest to the given
   *  SCREEN-space point, within `thresholdPx` pixels. Also returns
   *  segmentIndex for wire editing (which segment was hit). */
  _hitTestWireAtScreen(screenX, screenY, thresholdPx){
    let bestId = null, bestDist = thresholdPx, bestSeg = -1;
    for(const wire of this.model.wires.values()){
      const fromStub = WireRouter._resolveStub(wire.fromComp, wire.fromPin, this.model);
      const toStub   = WireRouter._resolveStub(wire.toComp,   wire.toPin,   this.model);
      if(!fromStub || !toStub) continue;

      // Screen-space pin dots (true endpoints of the drawn path)
      const fromDot = this.renderer.worldToScreen(fromStub.pinPos.x, fromStub.pinPos.y);
      const toDot   = this.renderer.worldToScreen(toStub.pinPos.x,   toStub.pinPos.y);
      // Screen-space stub entry/exit points
      const fromSS  = this.renderer.worldToScreen(fromStub.stubPos.x, fromStub.stubPos.y);
      const toSS    = this.renderer.worldToScreen(toStub.stubPos.x,   toStub.stubPos.y);

      const obs2 = WireRouter._obstacles(this.model, wire.fromComp, wire.toComp)
        .concat(WireRouter._pinObstacles(this.model, wire.fromComp, wire.fromPin, wire.toComp, wire.toPin));

      // Build the full drawn path: pin dot → stub → routed body → stub → pin dot
      // This must exactly mirror what drawWires produces.
      let fullPts;
      if(wire.waypoints && wire.waypoints.length >= 2){
        const wps = wire.waypoints.map(p=>({x:p.x, y:p.y}));
        wps[0] = fromStub.stubPos; wps[wps.length-1] = toStub.stubPos;
        const worldPts = [];
        for(let i = 0; i < wps.length - 1; i++){
          const seg = WireRouter.route(wps[i], wps[i+1], obs2);
          if(i === 0) worldPts.push(...seg);
          else worldPts.push(...seg.slice(1));
        }
        fullPts = worldPts.map(p => this.renderer.worldToScreen(p.x, p.y));
      } else {
        const worldPts = WireRouter.route(fromStub.stubPos, toStub.stubPos, obs2);
        fullPts = worldPts.map(p => this.renderer.worldToScreen(p.x, p.y));
      }
      // Prepend from-dot and append to-dot (same as drawWires)
      fullPts.unshift(fromDot);
      fullPts.push(toDot);

      // Test all segments of the full drawn path
      const STEPS = 18;
      for(let s = 0; s < fullPts.length - 1; s++){
        const a = fullPts[s], b = fullPts[s+1];
        for(let i = 0; i <= STEPS; i++){
          const t = i / STEPS;
          const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          const d = Math.sqrt((x - screenX) ** 2 + (y - screenY) ** 2);
          if(d < bestDist){ bestDist = d; bestId = wire.id; bestSeg = s; }
        }
      }
    }
    return bestId ? { id: bestId, segmentIndex: bestSeg } : null;
  },
  /** Completes the in-progress click-to-wire draw by connecting it to
   *  (compId, pinId) — building the wire (with any accumulated waypoints)
   *  and clearing the draw state. Connecting back onto the same pin the
   *  draw started from just cancels it, same as before. Centralizing this
   *  (instead of duplicating it at every place a draw can be completed —
   *  pin click, component-body snap, wire tap) keeps all completion paths
   *  in agreement about how a wire gets built. */
  _finishWireDrawAt(compId, pinId){
    const draw = this.activeWireDraw;
    if(!draw) return;
    ({ compId, pinId } = this._canonicalizePinHit({ compId, pinId }));
    if(!(compId === draw.fromComp && pinId === draw.fromPin)){
      const fromComp = this.model.getComponent(draw.fromComp);
      const fromR = fromComp && fromComp.resolvePin(draw.fromPin);
      const fromW = fromR ? fromComp.pinWorldPos(fromR.pinDef, fromR.side) : null;
      const toComp = this.model.getComponent(compId);
      const toR = toComp && toComp.resolvePin(pinId);
      const toW = toR ? toComp.pinWorldPos(toR.pinDef, toR.side) : null;
      const wire = new CircuitWire(draw.fromComp, draw.fromPin, compId, pinId);
      if(draw.waypoints.length > 0 && fromW && toW){
        wire.waypoints = [fromW, ...draw.waypoints, toW];
      }
      this.model.addWire(wire);
      this.markDirty();
      this.history.commit();
    }
    this._clearWireDraw();
    this._clearPendingWire();
  },
  /** Finds the closest real pin (on ANY component, not just one whose DOM
   *  box the event landed inside) to a client-space point, within
   *  thresholdPx. Used to give real pins priority over tapping into a wire
   *  when finishing a wire draw. */
  _findNearestPinWithin(clientX, clientY, thresholdPx, excludeCompId, excludePinId){
    let best = null, bestDist = thresholdPx;
    document.querySelectorAll('.comp-node .pin').forEach(pin=>{
      const node = pin.closest('.comp-node');
      if(!node) return;
      const compId = node.dataset.id, pinId = pin.dataset.pinId;
      if(compId === excludeCompId && pinId === excludePinId) return;
      const r = pin.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const d = Math.sqrt((cx - clientX) ** 2 + (cy - clientY) ** 2);
      if(d < bestDist){ bestDist = d; best = { compId, pinId, side: pin.dataset.side }; }
    });
    return this._canonicalizePinHit(best);
  },
  /** Taps into an existing wire so a new wire can connect onto its middle,
   *  not just its end pins. Drops a tiny NODE junction component at
   *  worldPoint, deletes the original wire, and reconnects its two original
   *  endpoints through the node (endpoint→node, node→endpoint) so the net
   *  stays electrically identical. Returns {compId, pinId, side} for the
   *  node's pin, which the caller then wires the in-progress draw onto —
   *  or null if the wire no longer exists. */
  _tapWireAt(wireId, worldPoint){
    const wire = this.model.wires.get(wireId);
    if(!wire) return null;
    const def = GateLibrary.NODE;
    let x = worldPoint.x - def.w/2, y = worldPoint.y - def.h/2;
    if(this.renderer.snapEnabled){
      x = Utils.snap(x, this.renderer.gridSize);
      y = Utils.snap(y, this.renderer.gridSize);
    }
    const node = new CircuitComponent('NODE', x, y);
    this.model.addComponent(node);
    this.views.set(node.id, ComponentView.create(node, this.el.world));
    // Route BOTH of the original wire's endpoints onto the SAME node pin
    // ('in') instead of splitting them across NODE's in/out pair. A tap is
    // a plain electrical junction — everything meeting there is one
    // undirected net — so every party (both original endpoints, plus
    // whatever wire connects here next) has to land on the identical
    // pin/key. Splitting them across NODE's two different pins would
    // bridge them through NODE's one-way in→out relay instead of a real
    // junction: a wire's stored fromComp/toComp order doesn't reflect
    // which side is the actual driver, so whichever original endpoint
    // ended up on the "downstream" (out) side would never see a value
    // change from something newly tapped onto the "upstream" (in) side —
    // exactly the "signal only goes forward, not backward" bug this fixes.
    const w1 = new CircuitWire(wire.fromComp, wire.fromPin, node.id, 'in');
    const w2 = new CircuitWire(wire.toComp, wire.toPin, node.id, 'in');
    this.model.removeWire(wire.id);
    this.model.addWire(w1);
    this.model.addWire(w2);
    return { compId: node.id, pinId: 'in', side: 'in' };
  },
  /** After a component is moved or newly placed, any EXISTING wire with
   *  custom waypoints may now have one of its fixed bend points sitting
   *  inside that component's new footprint. The obstacle-avoiding router
   *  can bypass an obstacle that's merely in the way *between* two points,
   *  but not one that swallows a point the wire is required to pass
   *  through — so that's the one case a dropped component can still end
   *  up with a wire visibly cutting through it. Clearing the affected
   *  wire's waypoints falls it back to full auto-routing, which
   *  recomputes a clean bypass around every current obstacle (including
   *  the one that just moved) from scratch. Wires that don't collide are
   *  left exactly as the user drew them. */
  _repairWiresAroundObstacles(compIds){
    const movedSet = new Set(compIds);
    if(movedSet.size === 0) return;
    const obstacles = [];
    for(const id of movedSet){
      const c = this.model.getComponent(id);
      if(!c) continue;
      const s = c.renderedSize();
      obstacles.push({ x:c.x, y:c.y, w:s.w, h:s.h, compId:id });
    }
    if(!obstacles.length) return;
    let repaired = false;
    for(const wire of this.model.wires.values()){
      if(!wire.waypoints || wire.waypoints.length === 0) continue;
      const collides = wire.waypoints.some(wp => obstacles.some(r=>{
        // A wire's own endpoint component is allowed to have waypoints
        // touching its own body (that's just the wire leaving its pin).
        if((r.compId === wire.fromComp || r.compId === wire.toComp)) return false;
        return wp.x >= r.x && wp.x <= r.x + r.w && wp.y >= r.y && wp.y <= r.y + r.h;
      }));
      if(collides){ wire.waypoints = null; repaired = true; }
    }
    if(repaired) this.markDirty();
  },
  /** Returns the world-space body waypoints for a wire WITHOUT mutating it —
   *  if the wire already has a custom waypoint list, that's returned as-is;
   *  otherwise a temporary auto-route is computed on the fly (same router,
   *  same obstacles _ensureWireWaypoints would use) just for hit-testing.
   *  Used so hovering near a not-yet-edited wire can still preview the
   *  correct segment without prematurely freezing its auto-route. */
  _resolveWireBodyWaypoints(wire){
    if(wire.waypoints && wire.waypoints.length >= 2) return wire.waypoints;
    const fromStub = WireRouter._resolveStub(wire.fromComp, wire.fromPin, this.model);
    const toStub   = WireRouter._resolveStub(wire.toComp,   wire.toPin,   this.model);
    if(!fromStub || !toStub) return null;
    const obs = WireRouter._obstacles(this.model, wire.fromComp, wire.toComp)
      .concat(WireRouter._pinObstacles(this.model, wire.fromComp, wire.fromPin, wire.toComp, wire.toPin));
    return WireRouter.route(fromStub.stubPos, toStub.stubPos, obs);
  },
  /** Finds the draggable interior body segment of ONE specific wire that's
   *  closest to a screen point, testing directly against that wire's own
   *  waypoint list (not the separately-reconstructed pin-dot→stub→…→pin-dot
   *  render path). This is deliberately the *only* place that decides "which
   *  segment is this", and both the hover highlight and the actual drag
   *  pickup call it with the same coordinates — so whatever segment lights
   *  up under the cursor is guaranteed to be the exact one that moves,
   *  rather than two separately-computed index spaces drifting apart (which
   *  is what let the wrong segment move before). Returns
   *  {segIndex, waypoints} — segIndex is an index into `waypoints` such that
   *  the hit segment runs waypoints[segIndex] → waypoints[segIndex+1] — or
   *  null if no draggable segment of this wire is within thresholdPx. */
  _hitTestWireBodySegment(wire, screenX, screenY, thresholdPx){
    const wps = this._resolveWireBodyWaypoints(wire);
    if(!wps || wps.length < 4) return null; // need >=1 true interior segment (excludes the 2 stub segments)
    let bestSeg = -1, bestDist = thresholdPx;
    for(let i = 1; i <= wps.length - 3; i++){
      const a = this.renderer.worldToScreen(wps[i].x, wps[i].y);
      const b = this.renderer.worldToScreen(wps[i+1].x, wps[i+1].y);
      const d = Utils.distToSegment(screenX, screenY, a, b);
      if(d < bestDist){ bestDist = d; bestSeg = i; }
    }
    return bestSeg >= 0 ? { segIndex: bestSeg, waypoints: wps } : null;
  },
  /** Hit-tests a DOM event target against pin elements. Returns
   *  {compId, pinId, side} or null. `forDrop` relaxes nothing currently
   *  but is kept as a hook for future pin-type compatibility checks. */
  _hitTestPin(target, forDrop){
    if(!target || !target.classList || !target.classList.contains('pin')) return null;
    const node = target.closest('.comp-node');
    if(!node) return null;
    return this._canonicalizePinHit({ compId: node.dataset.id, pinId: target.dataset.pinId, side: target.dataset.side });
  },
  /** NODE renders its 'in' and 'a' pins coincident at the exact same visual
   *  dot on purpose — a junction reads as one connection point. But
   *  electrically they're two different pins/keys, and only 'in' is the
   *  one every tap-created (and hand-placed) junction actually shares.
   *  Whichever of the two happens to be hit first (DOM order, sub-pixel
   *  proximity, etc.) must not matter, so every pin reference touching a
   *  NODE is canonicalized to 'in' here — otherwise a new wire could land
   *  on the unused 'a' pin and silently form its own disconnected net,
   *  which is exactly what made a second switch fail to affect a shared
   *  junction/LED even though the dot looked identical either way. */
  _canonicalizePinHit(pinRef){
    if(!pinRef) return pinRef;
    const c = this.model.getComponent(pinRef.compId);
    if(c && c.type === 'NODE') return { compId: pinRef.compId, pinId: 'in', side: 'in' };
    return pinRef;
  },

  /** Sets a pending wire pin (click-to-wire first click). Highlights the pin
   *  with a glowing ring so the user knows a connection is waiting. */
  _setPendingWire(pin){
    this._clearPendingWire(); // remove any previous pending state
    this.pendingWirePin = pin;
    const sideClass = pin.side === 'in' ? 'pin-in' : 'pin-out';
    const el = document.querySelector(`.comp-node[data-id="${pin.compId}"] .${sideClass}[data-pin-id="${pin.pinId}"]`);
    if(el){
      el.classList.add('pin-pending-wire');
      this._pendingWirePinEl = el;
    }
    // Show a subtle status hint in the cursor coords area
    const hint = document.getElementById('pending-wire-hint');
    if(hint) hint.style.display = 'inline';
  },
  /** Clears the pending wire pin state and removes the highlight. */
  _clearPendingWire(){
    if(this._pendingWirePinEl){
      this._pendingWirePinEl.classList.remove('pin-pending-wire');
      this._pendingWirePinEl = null;
    }
    this.pendingWirePin = null;
    document.querySelectorAll('.pin-pending-wire').forEach(p=>p.classList.remove('pin-pending-wire'));
    const hint = document.getElementById('pending-wire-hint');
    if(hint) hint.style.display = 'none';
  },

  /** Starts multi-click wire drawing from a given pin. */
  _startWireDraw(pin){
    this._clearWireDraw();
    this.activeWireDraw = { fromComp: pin.compId, fromPin: pin.pinId, fromSide: pin.side, waypoints: [] };
    // Highlight the source pin
    const sideClass = pin.side === 'in' ? 'pin-in' : 'pin-out';
    const el = document.querySelector(`.comp-node[data-id="${pin.compId}"] .${sideClass}[data-pin-id="${pin.pinId}"]`);
    if(el){ el.classList.add('pin-pending-wire'); this._pendingWirePinEl = el; }
    const hint = document.getElementById('pending-wire-hint');
    if(hint) hint.style.display = 'inline';
    // Set preview drag to start from that pin
    this.activeWireDrag = {
      from: this._pinScreenPos(pin.compId, pin.pinId, pin.side),
      to: this.activeWireDrag ? this.activeWireDrag.to : this._pinScreenPos(pin.compId, pin.pinId, pin.side),
      waypoints: [],
      fromComp: pin.compId,
      fromPin: pin.pinId
    };
  },

  /** Clears multi-click wire drawing state. */
  _clearWireDraw(){
    this.activeWireDraw = null;
    this.activeWireDrag = null;
    if(this._pendingWirePinEl){ this._pendingWirePinEl.classList.remove('pin-pending-wire'); this._pendingWirePinEl = null; }
    document.querySelectorAll('.pin-pending-wire').forEach(p=>p.classList.remove('pin-pending-wire'));
    const hint = document.getElementById('pending-wire-hint');
    if(hint) hint.style.display = 'none';
  },

  /** Ensures a wire has an editable waypoints array (converts from auto-route if needed). */
  _ensureWireWaypoints(wire){
    if(wire.waypoints && wire.waypoints.length >= 2) return;
    const fromStub = WireRouter._resolveStub(wire.fromComp, wire.fromPin, this.model);
    const toStub   = WireRouter._resolveStub(wire.toComp,   wire.toPin,   this.model);
    if(!fromStub || !toStub){ wire.waypoints = []; return; }
    const obs = WireRouter._obstacles(this.model, wire.fromComp, wire.toComp)
      .concat(WireRouter._pinObstacles(this.model, wire.fromComp, wire.fromPin, wire.toComp, wire.toPin));
    // Waypoints run from stub → routed body → stub (pin dots are rendered
    // separately as the first/last segments, not stored in waypoints).
    wire.waypoints = WireRouter.route(fromStub.stubPos, toStub.stubPos, obs);
  },
  /** Cleans up a wire's waypoint list after editing. The segment-drag
   *  interaction in _onMouseDown deliberately duplicates boundary points so
   *  the dragged segment doesn't drag its neighbors along with it. Once the
   *  drag is done, the *un-dragged* copy of that duplicate is dead weight —
   *  it sits at the old, stale position and (if left in) renders as a tiny
   *  leftover stub/kink. This removes points that are coincident with a
   *  neighbor (zero-length dead segments) and merges runs of 3+ points that
   *  are exactly collinear (no longer a real corner) down to just the two
   *  endpoints. Pin-anchor points at index 0 and the last index are always
   *  kept. */
  _simplifyWireWaypoints(wire){
    if(!wire.waypoints || wire.waypoints.length < 3) return;
    const EPS = 0.01;
    let pts = wire.waypoints;
    // Pass 1: drop coincident points (but never drop index 0 or the last).
    let out = [pts[0]];
    for(let i=1;i<pts.length-1;i++){
      const prev = out[out.length-1];
      if(Math.abs(pts[i].x-prev.x) < EPS && Math.abs(pts[i].y-prev.y) < EPS) continue; // dead/coincident point
      out.push(pts[i]);
    }
    out.push(pts[pts.length-1]);
    // Drop the last real point too if it's coincident with the true end anchor.
    if(out.length>2){
      const last = out[out.length-1], prev = out[out.length-2];
      if(Math.abs(last.x-prev.x) < EPS && Math.abs(last.y-prev.y) < EPS) out.splice(out.length-2,1);
    }
    // Pass 2: collapse collinear runs — if p[i] sits exactly on the line
    // between p[i-1] and p[i+1], it's not a real corner anymore; drop it.
    let collapsed = [out[0]];
    for(let i=1;i<out.length-1;i++){
      const a = collapsed[collapsed.length-1], b = out[i], c = out[i+1];
      const cross = (b.x-a.x)*(c.y-a.y) - (b.y-a.y)*(c.x-a.x);
      if(Math.abs(cross) < EPS) continue; // collinear — skip b, it's not a real corner
      collapsed.push(b);
    }
    collapsed.push(out[out.length-1]);
    wire.waypoints = collapsed.length >= 2 ? collapsed : pts;
  },

  // =====================================================================
  // KEYBOARD SHORTCUTS
  // =====================================================================
  _bindKeyboard(){
    window.addEventListener('keydown', (e)=>{
      if(e.code==='Space') this.spaceHeld = true;
      const meta = e.ctrlKey || e.metaKey;
      const isTextInput = e.target.tagName==='INPUT' || e.target.tagName==='TEXTAREA';
      if(isTextInput) return;
      if(meta && e.key.toLowerCase()==='z' && !e.shiftKey){ e.preventDefault(); this.history.undo(); this.runSimulation(); this._refreshAll(); }
      else if(meta && (e.key.toLowerCase()==='y' || (e.key.toLowerCase()==='z' && e.shiftKey))){ e.preventDefault(); this.history.redo(); this.runSimulation(); this._refreshAll(); }
      else if(meta && e.key.toLowerCase()==='c'){ e.preventDefault(); this.copySelection(); }
      else if(meta && e.key.toLowerCase()==='v'){ e.preventDefault(); this.pasteClipboard(); }
      else if(meta && e.key.toLowerCase()==='a' && e.shiftKey){ e.preventDefault(); this.selection.clear(); this._refreshAll(); }
      else if(meta && e.key.toLowerCase()==='a'){ e.preventDefault(); this.selection.selectOnly([...this.model.components.keys()]); this._refreshAll(); }
      else if(e.key==='Delete' || e.key==='Backspace'){ e.preventDefault(); this.deleteSelection(); }
      else if(e.key.toLowerCase()==='r' && e.shiftKey){ for(const id of this.selection.selectedComponents){ const c=this.model.getComponent(id); if(c) c.rotation=((c.rotation-90)%360+360)%360; } this.markDirty(); this.history.commit(); }
      else if(e.key.toLowerCase()==='r'){ this.rotateSelection(); }
      else if(e.key==='Escape'){ this._clearPendingWire(); this._clearWireDraw(); this.selection.clear(); this._refreshAll(); this._closeMenus(); if(this._pendingUniversalTarget) this._endUniversalConvertMode(); }
    });
    window.addEventListener('keyup', (e)=>{ if(e.code==='Space') this.spaceHeld = false; });
  },

  // =====================================================================
  // CLIPBOARD / DELETE / ROTATE
  // =====================================================================
  copySelection(){
    const comps = [...this.selection.selectedComponents].map(id=>this.model.getComponent(id)).filter(Boolean);
    if(comps.length===0) return;
    const ids = new Set(comps.map(c=>c.id));
    const wires = [...this.model.wires.values()].filter(w=>ids.has(w.fromComp)&&ids.has(w.toComp));
    // Detect whether the copied components include a complete switch bank
    // (all members of at least one bank entry are in the selection). If so,
    // flag the clipboard so pasteClipboard() knows to recreate the bank panel.
    let fromBank = false;
    if(this._switchBanks){
      for(const entry of this._switchBanks){
        const alive = entry.ids.filter(id=> this.model.getComponent(id));
        if(alive.length > 1 && alive.every(id=> ids.has(id))){
          fromBank = true;
          break;
        }
      }
    }
    this.clipboard = { components: comps.map(c=>c.toJSON()), wires: wires.map(w=>w.toJSON()), linked:false, _fromBank: fromBank };
  },
  /**
   * If a switch has no user label, assign the next available "SW N" name
   * (SW1, SW2, … across all switches on the canvas). Returns the name used.
   */
  _autoNameSwitch(comp){
    if(comp.label && comp.label.trim()) return comp.label.trim(); // already named
    // Collect all existing SW-N numbers already in use
    const used = new Set();
    for(const c of this.model.components.values()){
      if(c.type === 'SWITCH'){
        const m = c.label && c.label.match(/^SW\s*(\d+)$/i);
        if(m) used.add(parseInt(m[1], 10));
      }
    }
    let n = 1;
    while(used.has(n)) n++;
    comp.label = 'SW' + n;
    const node = this.views.get(comp.id);
    if(node) ComponentView.sync(comp, node);
    return comp.label;
  },

  /**
   * "Operational" copy: only meaningful for SWITCH components. The copy
   * (and the original) end up sharing a linkGroup id, so toggling either
   * one flips both — they behave as one logical switch with two visual
   * placements. Non-switch components in the selection are copied normally
   * (linking doesn't apply to them) so a mixed selection doesn't break.
   */
  linkedCopySelection(){
    const comps = [...this.selection.selectedComponents].map(id=>this.model.getComponent(id)).filter(Boolean);
    if(comps.length===0) return;
    const ids = new Set(comps.map(c=>c.id));
    const wires = [...this.model.wires.values()].filter(w=>ids.has(w.fromComp)&&ids.has(w.toComp));
    // Auto-name each switch and assign linkGroup; record source name for badge
    comps.forEach(c=>{
      if(c.type==='SWITCH'){
        const name = this._autoNameSwitch(c);
        if(!c.linkGroup) c.linkGroup = Utils.uid('link');
        const node = this.views.get(c.id);
        if(node) ComponentView.sync(c, node);
        // Store source name on clipboard JSON so paste can stamp "↔ SWN" on the copy
        // (done per-component below via a transient property on the JSON object)
      }
    });
    const clipComps = comps.map(c=>{
      const j = c.toJSON();
      if(c.type==='SWITCH') j._clipSourceName = c.label.trim();
      return j;
    });
    this.clipboard = { components: clipComps, wires: wires.map(w=>w.toJSON()), linked:true };
  },
  /** Returns the bank entry for a given switch id, or null if it's not in any bank. */
  /** Copy variable keeping the same letter. */
  _varCopySame(){
    const id = this._lastContextSwitchId;
    const comp = id ? this.model.getComponent(id) : null;
    if(!comp || comp.type !== 'VARIABLE') return;
    const j = comp.toJSON();
    this.clipboard = { components: [j], wires: [] };
  },

  /** Copy variable with the next available auto-assigned letter. */
  _varCopyNew(){
    const id = this._lastContextSwitchId;
    const comp = id ? this.model.getComponent(id) : null;
    if(!comp || comp.type !== 'VARIABLE') return;
    const j = comp.toJSON();
    const usedNames = new Set([...this.model.components.values()].filter(c=>c.type==='VARIABLE').map(c=>c.label));
    let idx = 0;
    while(usedNames.has(this._varIdxToName(idx))) idx++;
    j.label = this._varIdxToName(idx);
    this.clipboard = { components: [j], wires: [], _varNewLetter: true };
  },

  /** Copy whole variable group keeping the same letters. */
  _varGroupCopySame(){
    const entry = this._lastContextBankEntry;
    if(!entry) return;
    const comps = entry.ids.map(id=>this.model.getComponent(id)).filter(c=>c&&c.type==='VARIABLE');
    if(!comps.length) return;
    this.clipboard = {
      components: comps.map(c=>c.toJSON()),
      wires: [],
      _fromBank: true,
    };
  },

  /** Copy whole variable group with new sequential letters starting after the last used. */
  _varGroupCopyNew(){
    const entry = this._lastContextBankEntry;
    if(!entry) return;
    const comps = entry.ids.map(id=>this.model.getComponent(id)).filter(c=>c&&c.type==='VARIABLE');
    if(!comps.length) return;
    const usedNames = new Set([...this.model.components.values()].filter(c=>c.type==='VARIABLE').map(c=>c.label));
    let idx = 0;
    const newLabels = comps.map(()=>{
      while(usedNames.has(this._varIdxToName(idx))) idx++;
      const lbl = this._varIdxToName(idx);
      usedNames.add(lbl); // reserve it for the next sibling
      idx++;
      return lbl;
    });
    this.clipboard = {
      components: comps.map((c, i)=>{ const j=c.toJSON(); j.label=newLabels[i]; return j; }),
      wires: [],
      _fromBank: true,
      _varNewLetter: true,
    };
  },

  _getBankForSwitch(switchId){
    if(!this._switchBanks) return null;
    for(const entry of this._switchBanks){
      if(entry.ids.includes(switchId) && entry.ids.some(id=> this.model.getComponent(id))) return entry;
    }
    return null;
  },

  /** Copy / linked-copy of only the one switch that was right-clicked. */
  _bankCopyOne(linked){
    const id = this._lastContextSwitchId;
    const comp = id ? this.model.getComponent(id) : null;
    if(!comp) return;
    let sourceName = null;
    if(linked){
      sourceName = this._autoNameSwitch(comp);
      if(!comp.linkGroup) comp.linkGroup = Utils.uid('link');
      const node = this.views.get(comp.id);
      if(node) ComponentView.sync(comp, node);
    }
    const j = comp.toJSON();
    if(!linked) j.linkGroup = null;
    if(linked && sourceName) j._clipSourceName = sourceName;
    this.clipboard = { components: [j], wires: [], linked };
  },

  /** Copy / linked-copy of all living members of the bank. */
  _bankCopyAll(linked){
    const entry = this._lastContextBankEntry;
    if(!entry) return;
    const comps = entry.ids.map(id=> this.model.getComponent(id)).filter(Boolean);
    if(!comps.length) return;
    if(linked){
      comps.forEach(c=>{
        if(c.type==='SWITCH'){
          this._autoNameSwitch(c);
          if(!c.linkGroup) c.linkGroup = Utils.uid('link');
          const node = this.views.get(c.id);
          if(node) ComponentView.sync(c, node);
        }
      });
    }
    const ids = new Set(comps.map(c=>c.id));
    const wires = [...this.model.wires.values()].filter(w=> ids.has(w.fromComp) && ids.has(w.toComp));
    this.clipboard = {
      components: comps.map(c=>{
        const j = c.toJSON();
        if(!linked) j.linkGroup = null;
        if(linked && c.type==='SWITCH') j._clipSourceName = c.label.trim();
        return j;
      }),
      wires: wires.map(w=>w.toJSON()),
      linked,
      _fromBank: true,
    };
  },

  pasteClipboard(worldPos){
    if(!this.clipboard) return;
    // If this is a var-copy-new paste, reassign the next free letter(s) now
    if(this.clipboard._varNewLetter){
      const usedNames = new Set([...this.model.components.values()].filter(c=>c.type==='VARIABLE').map(c=>c.label));
      let idx = 0;
      this.clipboard.components.forEach(o=>{
        if(o.type === 'VARIABLE'){
          while(usedNames.has(this._varIdxToName(idx))) idx++;
          o.label = this._varIdxToName(idx);
          usedNames.add(o.label);
          idx++;
        }
      });
    }
    const idMap = new Map();
    const comps = this.clipboard.components;
    let dx, dy;
    if(worldPos){
      // Translate the whole pasted group so its bounding-box center lands
      // at worldPos (where the user right-clicked), instead of leaving
      // every pasted component at its original copied coordinates.
      const minX = Math.min(...comps.map(o=>o.x));
      const minY = Math.min(...comps.map(o=>o.y));
      const maxX = Math.max(...comps.map(o=>o.x + (GateLibrary[o.type]?GateLibrary[o.type].w:0)));
      const maxY = Math.max(...comps.map(o=>o.y + (GateLibrary[o.type]?GateLibrary[o.type].h:0)));
      const centerX = (minX+maxX)/2, centerY = (minY+maxY)/2;
      dx = worldPos.x - centerX; dy = worldPos.y - centerY;
    } else {
      dx = 30; dy = 30; // default nudge when pasting via Ctrl+V with no cursor position
    }
    const newIds = [];
    const origBankGroupById = new Map(); // new comp id -> original (stale) bankGroup id, if any
    comps.forEach(o=>{
      const c = CircuitComponent.fromJSON(o);
      c.id = Utils.uid('c');
      c.x += dx; c.y += dy;
      // Normal (non-linked) copy of a switch must NOT inherit the original's
      // linkGroup — otherwise every plain copy/paste of a previously-linked
      // switch would silently stay wired to it. fromJSON already copied
      // o.linkGroup verbatim (needed for re-loading a saved linked design),
      // so explicitly clear it here when this paste isn't a linked-copy paste.
      if(!this.clipboard.linked) c.linkGroup = null;
      // Every pasted component still carries its *original* bankGroup id at
      // this point (it still matches the live source bank, if any, that's
      // still sitting on the canvas) — remember it for the generic bank
      // reconstruction below, then clear it here. It only gets re-assigned
      // a brand-new bankGroup id if it turns out to be part of a full bank
      // copy (see below); otherwise it stays detached, as it should.
      if(o.bankGroup) origBankGroupById.set(c.id, o.bankGroup);
      c.bankGroup = null;
      // Linked paste: stamp "↔ SWN" badge on the new copy, and ensure the
      // source switch on the canvas also shows its own name as its badge.
      if(this.clipboard.linked && c.type==='SWITCH' && o._clipSourceName){
        c.linkedSourceName = o._clipSourceName;
        // Also sync all canvas switches sharing the same linkGroup so
        // their badges show they are the named source.
        if(c.linkGroup){
          for(const existing of this.model.components.values()){
            if(existing.type==='SWITCH' && existing.linkGroup===c.linkGroup){
              if(!existing.linkedSourceName){
                existing.linkedSourceName = o._clipSourceName;
                const enode = this.views.get(existing.id);
                if(enode) ComponentView.sync(existing, enode);
              }
            }
          }
        }
      }
      idMap.set(o.id, c.id);
      this.model.addComponent(c);
      this.views.set(c.id, ComponentView.create(c, this.el.world));
      newIds.push(c.id);
    });
    this.clipboard.wires.forEach(o=>{
      const w = new CircuitWire(idMap.get(o.fromComp), o.fromPin, idMap.get(o.toComp), o.toPin);
      this.model.addWire(w);
    });

    // If the clipboard came from a bank (multiple same-type components
    // stacked flush — SWITCH, LED, PROBE, or VARIABLE), re-create the bank
    // panel(s) so each pasted group reads as a unified bank again, rather
    // than a set of disconnected individual elements. Grouping by the
    // original (stale) bankGroup id correctly separates members coming
    // from different source banks even when several are pasted in one go;
    // each qualifying group is then assigned a brand-new bankGroup id.
    if(this.clipboard._fromBank){
      const pastedGroups = new Map(); // original bankGroup id → [component, ...]
      newIds.forEach(id=>{
        const origGroup = origBankGroupById.get(id);
        if(!origGroup) return;
        const c = this.model.getComponent(id);
        if(!c) return;
        if(!pastedGroups.has(origGroup)) pastedGroups.set(origGroup, []);
        pastedGroups.get(origGroup).push(c);
      });
      for(const [, members] of pastedGroups){
        if(members.length < 2) continue;
        const def = GateLibrary[members[0].type];
        // Sort by y so the bank panel spans them in order
        members.sort((a,b)=> a.y - b.y);
        const startX = members[0].x;
        const startY = members[0].y;
        const totalH = members.length * def.h;
        const maxW = Math.max(def.w, ...members.map(m=>m.w));

        const bank = document.createElement('div');
        bank.className = 'switch-bank';
        bank.style.left   = (startX - 2) + 'px';
        bank.style.top    = (startY - 2) + 'px';
        bank.style.width  = (maxW + 4) + 'px';
        bank.style.height = (totalH + 4) + 'px';
        // Insert the bank panel BEFORE the first pasted comp-node so that the
        // nodes paint on top of the bank background (later in DOM = higher
        // stacking order). If appended last, the bank div covers the elements
        // and they appear as blank white boxes.
        const firstNode = this.views.get(members[0].id);
        if(firstNode && firstNode.parentNode === this.el.world){
          this.el.world.insertBefore(bank, firstNode);
        } else {
          this.el.world.appendChild(bank);
        }

        const bankIds = members.map(c=> c.id);
        const bankGroupId = Utils.uid('bank');
        members.forEach((c, i)=>{
          c.bankGroup = bankGroupId; // persist so save/load can reconstruct the bank
          const node = this.views.get(c.id);
          if(node) node.classList.add('in-switch-bank');
          if(i < members.length - 1){
            const div = document.createElement('div');
            div.className = 'switch-bank-divider';
            div.style.top = (i * def.h + def.h - 1) + 'px';
            bank.appendChild(div);
          }
        });

        if(!this._switchBanks) this._switchBanks = [];
        this._switchBanks.push({ bank, ids: bankIds, x: startX, y: startY, w: def.w, h: totalH });
      }
    }

    this.selection.selectOnly(newIds);
    this.markDirty();
    this.history.commit();
  },
  /**
   * Toggles a switch's value and, if it belongs to a linkGroup, propagates
   * the same new value to every other switch sharing that group so all
   * linked copies flip together. Used instead of writing comp.state.value
   * directly wherever a switch can be toggled (mouse click and, if ever
   * added, keyboard/properties-panel toggles).
   */
  toggleLinkedSwitch(comp){
    if(!comp) return;
    const newVal = comp.state.value === null ? false : !comp.state.value;
    comp.state.value = newVal;
    const node = this.views.get(comp.id);
    if(node) ComponentView.sync(comp, node);
    if(comp.linkGroup){
      for(const other of this.model.components.values()){
        if(other.id===comp.id) continue;
        if(other.type==='SWITCH' && other.linkGroup===comp.linkGroup){
          other.state.value = newVal;
          const onode = this.views.get(other.id);
          if(onode) ComponentView.sync(other, onode);
        }
      }
    }
  },
  /**
   * Toggles a variable's value and propagates to all other VARIABLEs that
   * share the same label, so same-named variables always stay in sync.
   */
  toggleLinkedVariable(comp){
    if(!comp) return;
    const newVal = comp.state.value === null ? false : !comp.state.value;
    const label = (comp.label || '').toUpperCase();
    for(const other of this.model.components.values()){
      if(other.type !== 'VARIABLE') continue;
      if((other.label || '').toUpperCase() !== label) continue;
      other.state.value = newVal;
      const onode = this.views.get(other.id);
      if(onode) ComponentView.sync(other, onode);
    }
  },
  deleteSelection(){
    if(this.selection.isEmpty()) return;
    for(const id of this.selection.selectedComponents){
      this.model.removeComponent(id);
      const node = this.views.get(id);
      if(node){ node.remove(); this.views.delete(id); }
    }
    for(const id of this.selection.selectedWires) this.model.removeWire(id);
    if(this._ttPanels){
      for(const id of [...this.selection.selectedTruthTables]){
        const table = this._ttPanels.find(t=>t.id===id);
        if(table) this._ttClosePanel(table);
      }
    }
    if(this._kmPanels){
      for(const id of [...this.selection.selectedKMaps]){
        const panel = this._kmPanels.find(p=>p.id===id);
        if(panel) this._kmClosePanel(panel);
      }
    }
    this.selection.clear();
    this.markDirty();
    this.history.commit();
  },
  rotateSelection(){
    if(this.selection.selectedComponents.size===0) return;
    for(const id of this.selection.selectedComponents){
      const c = this.model.getComponent(id);
      if(c) c.rotation = (c.rotation+90)%360;
    }
    this.markDirty();
    this.history.commit();
  },

  // =====================================================================
  // PROPERTIES PANEL / STATUS BAR
  // =====================================================================
  _updateStatusBar(){
    document.getElementById('component-count').textContent = `${this.model.components.size} components`;
    document.getElementById('wire-count').textContent = `${this.model.wires.size} wires`;
  },
  _updateUndoRedoButtons(){
    document.getElementById('btn-undo').disabled = !this.history.canUndo();
    document.getElementById('btn-redo').disabled = !this.history.canRedo();
  },
  _updatePropertiesPanel(openModal){
    const container = this.el.propsContent;
    const modal = this.el.propsModal;
    const selIds = [...this.selection.selectedComponents];
    if(selIds.length!==1){
      if(modal) modal.style.display='none';
      container.innerHTML = '';
      return;
    }
    const c = this.model.getComponent(selIds[0]);
    if(!c){ if(modal) modal.style.display='none'; container.innerHTML=''; return; }
    const def = c.def;
    const stateOf = (v)=> v===1?'1':v===0?'0':'X';
    const pillClass = (v)=> v===1?'state-1':v===0?'state-0':'state-x';
    const outRow = def.outputs.length ? `
      <div class="prop-row"><label class="ui-label">Output State</label>
        ${def.outputs.map((o,i)=>`<span class="state-pill ${pillClass(c.outputValues&&c.outputValues[i])}"><span class="dot"></span>${stateOf(c.outputValues&&c.outputValues[i])}</span>`).join(' ')}
      </div>` : '';
    const isExpandable = ExpandableGates.has(c.type);
    const curCount = def.inputs.length;
    const countRow = isExpandable ? `
      <div class="prop-row"><label class="ui-label">Input Count</label>
        <div style="display:flex; align-items:center; gap:8px;">
          <button class="strip-btn" id="prop-inputs-minus" ${curCount<=GATE_MIN_INPUTS?'disabled':''} style="border:1.5px solid var(--c-gray);">−</button>
          <span class="prop-value" style="min-width:34px; text-align:center; padding:7px 6px;">${curCount}</span>
          <button class="strip-btn" id="prop-inputs-plus" ${curCount>=GATE_MAX_INPUTS?'disabled':''} style="border:1.5px solid var(--c-gray);">+</button>
        </div>
      </div>` : '';
    const inRows = def.inputs.length ? `
      <div class="prop-row"><label class="ui-label">Inputs (${def.inputs.length})</label>
        <div class="pin-list">${def.inputs.map((p,i)=>`<div class="pin-list-item"><span>${p.id.toUpperCase()}</span><span class="state-pill ${pillClass(c.inputValues&&c.inputValues[i])}"><span class="dot"></span>${stateOf(c.inputValues&&c.inputValues[i])}</span></div>`).join('')}</div>
      </div>` : '<div class="prop-row"><label class="ui-label">Inputs</label><div class="empty-panel-hint">None — this is a source component.</div></div>';
    const gateTypeRow = (def.category==='gate') ? (()=>{
      const siblings = isExpandable ? ['AND','OR','NAND','NOR','XOR','XNOR'] : ['NOT','BUFFER'];
      const btns = siblings.map(t=>`<button class="gate-type-btn${c.type===t?' active':''}" data-gate-type="${t}">${GateLibrary[t].label}</button>`).join('');
      return `<div class="prop-row"><label class="ui-label">Gate Type</label>
        <div class="gate-type-grid" id="prop-gate-type-grid">${btns}</div>
      </div>`;
    })() : '';
    const colorRow = (c.type==='SEVENSEG'||c.type==='BCDSEG') ? (() => {
      const cur = (c.state&&c.state.segColor)||'green';
      const colors = [
        {id:'green',  label:'Green',  lit:'#1fae5c'},
        {id:'red',    label:'Red',    lit:'#e0364a'},
        {id:'blue',   label:'Blue',   lit:'#1e5fcc'},
        {id:'yellow', label:'Yellow', lit:'#e0b800'},
        {id:'orange', label:'Orange', lit:'#e07020'},
        {id:'white',  label:'White',  lit:'#e8eef4'},
      ];
      const swatches = colors.map(col=>`
        <div data-seg-color="${col.id}" title="${col.label}" style="
          width:22px;height:22px;border-radius:5px;cursor:pointer;
          background:${col.lit};
          border:2.5px solid ${cur===col.id?'var(--c-navy)':'var(--c-gray)'};
          box-shadow:${cur===col.id?'0 0 0 2px var(--c-teal-soft)':'none'};
          transition:border-color .1s,box-shadow .1s;
        "></div>`).join('');
      return `<div class="prop-row"><label class="ui-label">Segment Color</label>
        <div id="seg-color-swatches" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">${swatches}</div>
      </div>`;
    })() : '';
    const descRow = def.desc ? `
      <div class="prop-row"><label class="ui-label">Description</label>
        <div class="prop-value" style="font-weight:500; line-height:1.4; white-space:normal; text-align:left;">${def.desc}</div>
      </div>` : '';
    const kitViewRow = KIT_NETLISTS[c.type] ? `
      <div class="prop-row"><label class="ui-label">View</label>
        <div class="prop-value" style="font-weight:700;">${c.viewMode==='circuit' ? 'Full Circuit' : 'Block Diagram'}
          <span style="font-weight:500;color:var(--c-text-soft);"> — fixed at placement</span>
        </div>
      </div>` : '';
    const linkRow = (c.type==='SWITCH' && c.linkGroup) ? `
      <div class="prop-row"><label class="ui-label">Linked To</label>
        <div class="prop-value" style="display:flex;align-items:center;gap:6px;">
          <span style="color:var(--c-teal);font-size:13px;">↔</span>
          <span>${c.linkedSourceName || c.label || 'Switch'}</span>
        </div>
      </div>` : '';
    const isVariable = c.type === 'VARIABLE';
    const isText = c.type === 'TEXT';
    const labelRowHTML = isVariable ? (() => {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const cur = (c.label||'A').toUpperCase();
      const btns = letters.split('').map(l =>
        `<button class="var-letter-btn${cur===l?' active':''}" data-var-letter="${l}" title="${l}">${l}</button>`
      ).join('');
      // Check if this variable is part of a bank group
      const groupMembers = c.bankGroup
        ? [...this.model.components.values()].filter(x => x.type==='VARIABLE' && x.bankGroup===c.bankGroup)
        : [c];
      const inGroup = groupMembers.length > 1;
      const groupRow = `<div class="prop-row" id="prop-var-group-row">
        <label class="ui-label">${inGroup ? `Group (${groupMembers.length})` : 'Apply To'}</label>
        <div style="display:flex;gap:5px;margin-top:2px;">
          <button class="strip-btn" id="prop-var-same" title="${inGroup ? 'Set all in group to the same letter' : 'Apply this letter'}" style="flex:1;font-size:11px;padding:5px 4px;">
            ${inGroup ? '= Same letter' : '✓ Apply'}
          </button>
          ${inGroup ? `<button class="strip-btn" id="prop-var-seq" title="Assign sequential letters starting from this letter" style="flex:1;font-size:11px;padding:5px 4px;">A B C… Sequential</button>` : ''}
        </div>
      </div>`;
      // Edit every bank member's name individually. Each variable's body
      // auto-expands to fit whatever is typed (see ComponentView.sync).
      const memberListRow = inGroup ? `<div class="prop-row" id="prop-var-member-list">
        <label class="ui-label">Edit Each Name</label>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:4px;">
          ${groupMembers.map((m,i)=>`
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:10px;font-weight:800;color:var(--c-text-soft);min-width:14px;">${i+1}.</span>
              <input class="var-name-input prop-var-member-input" data-member-id="${m.id}" maxlength="16" value="${(m.label||'').toUpperCase().replace(/"/g,'&quot;')}" spellcheck="false" style="flex:1;" />
            </div>`).join('')}
        </div>
      </div>` : '';
      return `<div class="prop-row"><label class="ui-label">Variable Name</label>
        <div class="var-name-row">
          <input class="var-name-input" id="prop-label-input" maxlength="16" value="${cur.replace(/"/g,'&quot;')}" spellcheck="false" />
        </div>
        <div class="var-letter-grid" id="prop-var-letter-grid">${btns}</div>
      </div>${groupRow}${memberListRow}`;
    })() : isText ? (()=>{
      const curText = (c.state && c.state.text) || 'Text';
      const curFs = (c.state && c.state.fontSize) || 18;
      return `<div class="prop-row"><label class="ui-label">Text</label>
        <textarea class="prop-input" id="prop-text-input" rows="2" spellcheck="false" style="resize:vertical;font-family:inherit;">${curText.replace(/</g,'&lt;')}</textarea>
      </div>
      <div class="prop-row"><label class="ui-label">Font Size</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="strip-btn" id="prop-fontsize-minus" style="border:1.5px solid var(--c-gray);">−</button>
          <span class="prop-value" id="prop-fontsize-val" style="min-width:34px;text-align:center;padding:7px 6px;">${curFs}</span>
          <button class="strip-btn" id="prop-fontsize-plus" style="border:1.5px solid var(--c-gray);">+</button>
        </div>
      </div>`;
    })() : (()=>{
      const defaultLabel = GateLibrary[c.type] ? GateLibrary[c.type].label : c.type;
      const shown = (c.label && c.label !== defaultLabel) ? c.label : '';
      return `<div class="prop-row"><label class="ui-label">Label</label><input class="prop-input" id="prop-label-input" placeholder="${defaultLabel.replace(/"/g,'&quot;')}" value="${shown.replace(/"/g,'&quot;')}" /></div>`;
    })();
    container.innerHTML = `
      <div class="prop-row"><label class="ui-label">Component Type</label><div class="prop-value">${def.label} (${c.type})</div></div>
      ${descRow}
      ${kitViewRow}
      ${labelRowHTML}
      ${linkRow}
      ${colorRow}
      ${outRow}
      ${gateTypeRow}
      ${countRow}
      ${inRows}
      <div class="prop-row"><label class="ui-label">Rotation</label>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="strip-btn" id="prop-rot-minus" style="border:1.5px solid var(--c-gray);">−</button>
          <span class="prop-value" style="min-width:42px;text-align:center;padding:7px 6px;">${c.rotation}°</span>
          <button class="strip-btn" id="prop-rot-plus" style="border:1.5px solid var(--c-gray);">+</button>
        </div>
      </div>
      <div class="prop-row"><label class="ui-label">Position (world)</label><div class="prop-value">x: ${Math.round(c.x)}, y: ${Math.round(c.y)}</div></div>
    `;
    const labelInput = document.getElementById('prop-label-input');
    if(labelInput){
      const applyLabel = (val) => {
        if(isVariable){
          const v = val.toUpperCase();
          c.label = v;
          labelInput.value = v;
        } else {
          const defaultLabel = GateLibrary[c.type] ? GateLibrary[c.type].label : c.type;
          c.label = val.trim() === '' ? defaultLabel : val;
        }
        const node=this.views.get(c.id); if(node) ComponentView.sync(c,node);
        // update active letter btn
        const grid = document.getElementById('prop-var-letter-grid');
        if(grid) grid.querySelectorAll('.var-letter-btn').forEach(b=>b.classList.toggle('active', b.dataset.varLetter===c.label));
      };
      labelInput.addEventListener('input', ()=>applyLabel(labelInput.value));
      labelInput.addEventListener('blur', ()=> { this.history.commit(); this._closeMenus(); });
    }
    const textInput = document.getElementById('prop-text-input');
    if(textInput){
      textInput.addEventListener('input', ()=>{
        c.state = c.state || {};
        c.state.text = textInput.value === '' ? 'Text' : textInput.value;
        const node=this.views.get(c.id); if(node) ComponentView.sync(c,node);
      });
      textInput.addEventListener('blur', ()=> { this.history.commit(); this._closeMenus(); });
    }
    const fsVal = document.getElementById('prop-fontsize-val');
    const fsStep = (delta)=>{
      c.state = c.state || {};
      const cur = c.state.fontSize || 18;
      c.state.fontSize = Utils.clamp(cur + delta, 8, 96);
      if(fsVal) fsVal.textContent = c.state.fontSize;
      const node=this.views.get(c.id); if(node) ComponentView.sync(c,node);
      this.history.commit();
    };
    const fsMinus = document.getElementById('prop-fontsize-minus');
    const fsPlus  = document.getElementById('prop-fontsize-plus');
    if(fsMinus) fsMinus.addEventListener('click', ()=> fsStep(-2));
    if(fsPlus)  fsPlus.addEventListener('click', ()=> fsStep(2));
    const grid = document.getElementById('prop-var-letter-grid');
    if(grid){
      grid.addEventListener('click', (e)=>{
        const btn = e.target.closest('.var-letter-btn');
        if(!btn) return;
        const letter = btn.dataset.varLetter;
        c.label = letter;
        if(labelInput) labelInput.value = letter;
        const node=this.views.get(c.id); if(node) ComponentView.sync(c,node);
        grid.querySelectorAll('.var-letter-btn').forEach(b=>b.classList.toggle('active', b.dataset.varLetter===letter));
        this.history.commit();
      });
    }
    const memberInputs = container.querySelectorAll('.prop-var-member-input');
    memberInputs.forEach(mInp=>{
      mInp.addEventListener('input', ()=>{
        const mid = mInp.dataset.memberId;
        const m = this.model.getComponent(mid);
        if(!m) return;
        const v = mInp.value.toUpperCase();
        mInp.value = v;
        m.label = v;
        const mNode = this.views.get(m.id);
        if(mNode) ComponentView.sync(m, mNode);
        if(mid === c.id){
          if(labelInput) labelInput.value = v;
          if(grid) grid.querySelectorAll('.var-letter-btn').forEach(b=>b.classList.toggle('active', b.dataset.varLetter===v));
        }
      });
      mInp.addEventListener('blur', ()=> this.history.commit());
    });
    if(isVariable){
      const _applyGroupLabel = (members, labelFn) => {
        members.forEach((m, i) => {
          m.label = labelFn(i).toUpperCase();
          const n = this.views.get(m.id);
          if(n) ComponentView.sync(m, n);
        });
        this.history.commit();
        this._updatePropertiesPanel();
      };
      const _groupMembers = () => {
        return c.bankGroup
          ? [...this.model.components.values()].filter(x => x.type==='VARIABLE' && x.bankGroup===c.bankGroup)
          : [c];
      };
      const sameBtn = document.getElementById('prop-var-same');
      if(sameBtn) sameBtn.addEventListener('click', ()=>{
        const letter = (c.label||'A').toUpperCase();
        _applyGroupLabel(_groupMembers(), () => letter);
      });
      const seqBtn = document.getElementById('prop-var-seq');
      if(seqBtn) seqBtn.addEventListener('click', ()=>{
        const base = (c.label||'A').toUpperCase().charCodeAt(0) - 65;
        _applyGroupLabel(_groupMembers(), (i) => this._varIdxToName(base + i));
      });
    }
    if(isExpandable){
      const minusBtn = document.getElementById('prop-inputs-minus');
      const plusBtn = document.getElementById('prop-inputs-plus');
      if(minusBtn) minusBtn.addEventListener('click', ()=>{ this.setInputCount(c.id, curCount-1); this.runSimulation(); this._refreshAll(); });
      if(plusBtn) plusBtn.addEventListener('click', ()=>{ this.setInputCount(c.id, curCount+1); this.runSimulation(); this._refreshAll(); });
    }
    const gateTypeGrid = document.getElementById('prop-gate-type-grid');
    if(gateTypeGrid){
      gateTypeGrid.addEventListener('click', (e)=>{
        const btn = e.target.closest('.gate-type-btn');
        if(!btn) return;
        this.changeGateType(c.id, btn.dataset.gateType);
        this._updatePropertiesPanel();
      });
    }
    const rotMinus = document.getElementById('prop-rot-minus');
    const rotPlus = document.getElementById('prop-rot-plus');
    if(rotMinus) rotMinus.addEventListener('click', ()=>{ this.rotateComponent(c.id, -90); this._updatePropertiesPanel(); });
    if(rotPlus) rotPlus.addEventListener('click', ()=>{ this.rotateComponent(c.id, 90); this._updatePropertiesPanel(); });
    const swatchWrap = document.getElementById('seg-color-swatches');
    if(swatchWrap){
      swatchWrap.addEventListener('click', (e)=>{
        const sw = e.target.closest('[data-seg-color]');
        if(!sw) return;
        if(!c.state) c.state = {};
        c.state.segColor = sw.dataset.segColor;
        const node = this.views.get(c.id);
        if(node) ComponentView.sync(c, node);
        this.history.commit();
        // Re-render props to update swatch selection ring
        this._updatePropertiesPanel();
      });
    }
    // Update modal title
    const titleEl = document.getElementById('props-modal-title');
    if(titleEl) titleEl.textContent = `${def.label} Properties`;
    // Position and show modal if requested
    if(openModal && modal){
      const { x, y } = openModal;
      const mw = 280, mh = 400;
      const left = Math.min(x, window.innerWidth - mw - 10);
      const top  = Math.min(y, window.innerHeight - mh - 10);
      modal.style.left = left + 'px';
      modal.style.top  = top  + 'px';
      modal.style.display = 'block';
    }
  },

  // =====================================================================
  // =====================================================================
  // TRUTH TABLE MAKER
  // -------------------------------------------------------------------------
  // Reads every VARIABLE element on the canvas as a truth-table input
  // column, and every LED/Probe element as an output column. Walks all
  // 2^n input combinations, forcing each VARIABLE's state and re-running
  // SimulationEngine, then restores whatever the user had set before.
  //
  // Multiple tables can exist at once: each generated table gets its own
  // cloned floating panel (independent position/pin/play/name state),
  // tracked in this._ttPanels. The setup/rename dialogs stay singletons
  // since only one can be open at a time, but they always act on the
  // specific table instance that triggered them (this._ttActiveTable).
  // =====================================================================
  _ttCollectIO(){
    const selected = this.selection && this.selection.selectedComponents;
    const scoped = selected && selected.size > 0 ? selected : null;
    const comps = [...this.model.components.values()].filter(c=> !scoped || scoped.has(c.id));
    const varMap = new Map();
    for(const c of comps){
      if(c.type !== 'VARIABLE') continue;
      const lbl = (c.label || '').trim().toUpperCase() || '?';
      if(!varMap.has(lbl)) varMap.set(lbl, { label: lbl, y: c.y, x: c.x });
    }
    const inputs = [...varMap.values()].sort((a,b)=> a.label.localeCompare(b.label));
    const outputs = comps
      .filter(c=> c.type === 'LED' || c.type === 'PROBE')
      .sort((a,b)=> (a.y - b.y) || (a.x - b.x))
      .map((c, idx)=> ({
        id: c.id, type: c.type,
        defaultName: (c.label && c.label.trim()) ? c.label.trim() : `${c.type}${idx+1}`
      }));
    return { inputs, outputs, scoped: !!scoped };
  },
  _ttSetVar(label, value){
    for(const c of this.model.components.values()){
      if(c.type === 'VARIABLE' && (c.label||'').trim().toUpperCase() === label){
        c.state.value = value;
      }
    }
  },
  /** Opens the in-app rename dialog (no native browser prompt) prefilled
   *  with the target table's current name, if any. */
  _ttOpenRenameDialog(table){
    this._ttActiveTable = table;
    const input = document.getElementById('tt-rename-input');
    if(input) input.value = table.tableName || '';
    this.el.ttRenameOverlay.style.display = 'flex';
    if(input){ input.focus(); input.select(); }
  },
  _ttSaveRenameDialog(){
    const table = this._ttActiveTable;
    if(!table){ this.el.ttRenameOverlay.style.display = 'none'; return; }
    const input = document.getElementById('tt-rename-input');
    table.tableName = input ? input.value.trim() : '';
    const nameEl = table.panelEl.querySelector('#tt-panel-name');
    if(nameEl){
      if(table.tableName){
        nameEl.textContent = table.tableName;
        nameEl.style.display = 'block';
      } else {
        nameEl.style.display = 'none';
      }
    }
    this.el.ttRenameOverlay.style.display = 'none';
    this._autosaveSoon();
  },
  openTruthTableMaker(anchorScreenPos){
    this._ttPendingAnchor = anchorScreenPos || null;
    this._ttPendingTableName = '';
    const tableNameInput = document.getElementById('tt-setup-tablename');
    if(tableNameInput) tableNameInput.value = '';
    const io = this._ttCollectIO();
    this._ttPendingIO = io;
    const body = document.getElementById('tt-setup-body');
    const subtitle = document.getElementById('tt-setup-subtitle');
    const genBtn = document.getElementById('tt-setup-generate');
    body.innerHTML = '';
    if(io.inputs.length === 0){
      subtitle.textContent = io.scoped
        ? 'No VARIABLE elements found in your current selection. Select the circuit you want a table for (including its variables), or click empty canvas to use the whole sheet.'
        : 'No VARIABLE elements found on the canvas. Add at least one variable to generate a truth table.';
      genBtn.style.display = 'none';
    } else if(io.outputs.length === 0){
      subtitle.textContent = io.scoped
        ? 'No LED or Probe outputs found in your current selection. Make sure the selected circuit includes its output(s).'
        : 'No LED or Probe outputs found on the canvas. Add at least one output to generate a truth table.';
      genBtn.style.display = 'none';
    } else {
      subtitle.textContent = (io.scoped ? `Selected circuit — inputs: ${io.inputs.map(i=>i.label).join(', ')}.` : `Inputs detected: ${io.inputs.map(i=>i.label).join(', ')}.`) + ' Choose which outputs to include, and name each below.';
      genBtn.style.display = 'inline-block';
      io.outputs.forEach((o, idx)=>{
        const wrap = document.createElement('div');
        wrap.innerHTML = `<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
            <input type="checkbox" class="tt-output-pick" data-idx="${idx}" checked style="accent-color:#14c8c4; width:15px; height:15px; flex:none;">
            <label class="tt-field-label" style="margin-bottom:0; flex:1;">${o.type} output ${idx+1}</label>
          </div>
          <input type="text" class="tt-row-input" id="tt-name-${idx}" maxlength="24" value="${this._ttEscape(o.defaultName)}">`;
        body.appendChild(wrap);
      });
    }
    document.getElementById('tt-setup-form').style.display = 'flex';
    document.getElementById('tt-setup-loading').style.display = 'none';
    this.el.ttSetupOverlay.style.display = 'flex';
  },
  _bindTruthTableMaker(){
    // Capture the original panel markup as a reusable template, then take
    // the literal element out of normal flow — every generated table gets
    // its own clone instead of all of them fighting over one shared panel.
    this._ttPanelTemplate = this.el.ttPanel.outerHTML;
    this._ttPanelsContainer = document.getElementById('floating-panels-clip');
    this.el.ttPanel.remove();
    this._ttPanels = [];
    this._ttZTop = 10;
    // Shared cascade counter for staggering the spawn position of new
    // floating panels (Truth Table and K-map alike) so opening several in
    // a row — of either type, in any order — doesn't stack them in an
    // identical spot. Wraps after PANEL_SPAWN_RESET_AFTER so the offset
    // can't eventually walk a panel off-screen on a long session, and
    // resets to 0 once every panel of both types has been closed.
    this._panelSpawnCount = 0;
    this._PANEL_SPAWN_OFFSET = 20;
    this._PANEL_SPAWN_RESET_AFTER = 8;

    document.getElementById('tt-setup-cancel').onclick = ()=>{ this.el.ttSetupOverlay.style.display = 'none'; };
    this.el.ttSetupOverlay.addEventListener('click', (e)=>{
      if(e.target === this.el.ttSetupOverlay) this.el.ttSetupOverlay.style.display = 'none';
    });
    document.getElementById('tt-setup-dialog').addEventListener('click', (e)=> e.stopPropagation());
    document.getElementById('tt-rename-cancel').onclick = ()=>{ this.el.ttRenameOverlay.style.display = 'none'; };
    document.getElementById('tt-rename-save').onclick = ()=> this._ttSaveRenameDialog();
    this.el.ttRenameOverlay.addEventListener('click', (e)=>{
      if(e.target === this.el.ttRenameOverlay) this.el.ttRenameOverlay.style.display = 'none';
    });
    document.getElementById('tt-rename-dialog').addEventListener('click', (e)=> e.stopPropagation());
    document.getElementById('tt-rename-input').addEventListener('keydown', (e)=>{
      if(e.key === 'Enter') this._ttSaveRenameDialog();
      else if(e.key === 'Escape') this.el.ttRenameOverlay.style.display = 'none';
    });
    document.getElementById('tt-setup-generate').onclick = ()=>{
      const io = this._ttPendingIO;
      if(!io || io.inputs.length === 0 || io.outputs.length === 0) return;
      // Multi-select: only include outputs whose checkbox is checked
      // (checkboxes default to checked, so leaving everything alone
      // reproduces the old "include every output" behaviour).
      const pickedIdx = [];
      io.outputs.forEach((o, idx)=>{
        const cb = document.querySelector(`.tt-output-pick[data-idx="${idx}"]`);
        if(!cb || cb.checked) pickedIdx.push(idx);
      });
      if(pickedIdx.length === 0) return;
      const filteredIO = { ...io, outputs: pickedIdx.map(i=> io.outputs[i]) };
      const names = pickedIdx.map(idx=>{
        const el = document.getElementById('tt-name-'+idx);
        const v = el && el.value.trim();
        return v || io.outputs[idx].defaultName;
      });
      const tableNameInput = document.getElementById('tt-setup-tablename');
      this._ttPendingTableName = tableNameInput ? tableNameInput.value.trim() : '';
      this._ttRunGeneration(filteredIO, names, this._ttPendingTableName, this._ttPendingAnchor);
    };
    document.getElementById('tt-ctx-rename').onclick = ()=>{
      document.getElementById('tt-panel-ctxmenu').style.display = 'none';
      if(this._ttActiveTable) this._ttOpenRenameDialog(this._ttActiveTable);
    };
    document.getElementById('tt-ctx-delete').onclick = ()=>{
      document.getElementById('tt-panel-ctxmenu').style.display = 'none';
      if(this._ttActiveTable) this._ttClosePanel(this._ttActiveTable);
    };
    document.addEventListener('mousedown', (e)=>{
      const menu = document.getElementById('tt-panel-ctxmenu');
      if(menu.style.display === 'block' && !menu.contains(e.target)) menu.style.display = 'none';
    });
  },
  /** Builds a fresh, fully independent panel instance for one generated
   *  table: clones the template DOM, wires up its own drag/play/props
   *  handlers scoped only to that clone, and appends it to this._ttPanels
   *  so every table keeps its own position and play state. */
  _ttCreatePanelInstance(){
    const wrap = document.createElement('div');
    wrap.innerHTML = this._ttPanelTemplate;
    const panelEl = wrap.firstElementChild;
    panelEl.removeAttribute('id'); // avoid a confusing duplicate-id template id; queries below are scoped
    this._ttPanelsContainer.appendChild(panelEl);

    const table = {
      id: 'tt' + Date.now() + Math.random().toString(36).slice(2,7),
      panelEl,
      io: null, names: null, rows: null,
      tableName: '',
      pinned: true,
      playing: false,
      playTimer: null,
      playIndex: 0,
      dragging: false,
      worldAnchor: null,
      baseZoom: 1,
      baseW: 0
    };
    // Every table behaves like a permanent element sitting on the design
    // sheet: flat against the paper (no shadow, square corners), and its
    // position tracks pan/zoom via a world-space anchor. There's no
    // floating mode to toggle, so this is applied once, permanently.
    panelEl.classList.add('tt-pinned');

    const q = (sel)=> panelEl.querySelector(sel);

    panelEl.addEventListener('mousedown', ()=> this._ttBringToFront(table), true);

    const openTtPropsMenu = (x, y)=>{
      this._ttActiveTable = table;
      const menu = document.getElementById('tt-panel-ctxmenu');
      const deleteItem = document.getElementById('tt-ctx-delete');
      if(deleteItem) deleteItem.style.display = 'block';
      const cx = Utils.clamp(x, 4, window.innerWidth  - 160);
      const cy = Utils.clamp(y, 4, window.innerHeight - 90);
      menu.style.left = cx + 'px';
      menu.style.top  = cy + 'px';
      menu.style.display = 'block';
    };
    panelEl.addEventListener('contextmenu', (e)=>{
      e.preventDefault(); e.stopPropagation();
      openTtPropsMenu(e.clientX, e.clientY);
    });
    q('#tt-panel-props').onclick = (e)=>{
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openTtPropsMenu(r.left, r.bottom + 6);
    };
    q('#tt-panel-play').onclick = ()=> this._ttTogglePlay(table);

    let offX = 0, offY = 0;
    panelEl.addEventListener('mousedown', (e)=>{
      if(e.target.closest('button')) return; // let play/props buttons handle their own clicks
      this._ttBringToFront(table);
      table.dragging = true;
      const rect = panelEl.getBoundingClientRect();
      offX = e.clientX - rect.left; offY = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e)=>{
      if(!table.dragging) return;
      const rawLeft = e.clientX - offX, rawTop = e.clientY - offY;
      const { left, top } = this._ttClampHorizontal(panelEl, rawLeft, rawTop);
      panelEl.style.left = left + 'px';
      panelEl.style.top  = top  + 'px';
      const vpRect = this.el.viewport.getBoundingClientRect();
      table.worldAnchor = this.renderer.screenToWorld(left - vpRect.left, top - vpRect.top);
    });
    window.addEventListener('mouseup', ()=>{ if(table.dragging){ table.dragging = false; this._autosaveSoon(); } });

    return table;
  },
  /** Shared cascade step for any new floating panel (Truth Table, K-map,
   *  or future panel types) — returns the next diagonal pixel offset and
   *  advances the one counter both panel types draw from, so interleaving
   *  "TT, KM, TT, ..." still cascades in the order panels were actually
   *  opened instead of each type re-overlapping its own first slot. */
  _nextPanelSpawnOffset(){
    const idx = this._panelSpawnCount % this._PANEL_SPAWN_RESET_AFTER;
    this._panelSpawnCount++;
    return idx * this._PANEL_SPAWN_OFFSET;
  },
  /** Called whenever a panel of either type closes — once no Truth Table
   *  or K-map panels remain open, restart the cascade from the base
   *  position so a user who opens/closes panels repeatedly doesn't end up
   *  with the offset creeping in one direction for the whole session. */
  _maybeResetPanelSpawnCascade(){
    if((this._ttPanels && this._ttPanels.length) || (this._kmPanels && this._kmPanels.length)) return;
    this._panelSpawnCount = 0;
  },
  _ttBringToFront(table){
    this._ttZTop += 1;
    table.panelEl.style.zIndex = String(this._ttZTop);
  },
  /** Confines a panel's position to the design workspace (the canvas
   *  viewport between the top toolbar and the status bar) — like any
   *  circuit element, the table can't be dragged or spawned up under the
   *  menu bar or below the status bar. */
  _ttClampToWorkspace(panelEl, left, top){
    const vp = this.el.viewport.getBoundingClientRect();
    const rect = panelEl.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    // The vertical elements rail is a position:fixed overlay (not part of
    // the layout grid #canvas-viewport sizes against), so it isn't already
    // excluded from vp's own bounds — subtract its width here so a pinned
    // table can't end up partially hidden underneath it either.
    const rail = document.getElementById('elements-rail');
    const railW = (rail && rail.offsetParent !== null) ? rail.getBoundingClientRect().width : 0;
    const minLeft = vp.left, maxLeft = Math.max(vp.left, vp.right - railW - w);
    const minTop  = vp.top,  maxTop  = Math.max(vp.top,  vp.bottom - h);
    return {
      left: Utils.clamp(left, minLeft, maxLeft),
      top:  Utils.clamp(top,  minTop,  maxTop)
    };
  },
  /** Horizontal-and-vertical counterpart to _ttClampToWorkspace, used once
   *  a panel is already on the workspace (dragging, or tracking its world
   *  anchor through pan/zoom). Left/right stay clamped so a panel can't end
   *  up stuck under the elements rail. Top/bottom are clamped against the
   *  full viewport (not just the workspace) so the panel can still be
   *  dragged partway under the top toolbar or status bar and gets cropped
   *  there by the #floating-panels-clip wrapper — but the header/drag-handle
   *  itself always stays on-screen and grabbable, so a panel can never be
   *  dragged fully off-screen and lost. Shared by both the Truth Table and
   *  K-map panels (drag handlers + pan/zoom sync for each call this). */
  _ttClampHorizontal(panelEl, left, top){
    const vp = this.el.viewport.getBoundingClientRect();
    const rect = panelEl.getBoundingClientRect();
    const w = rect.width;
    const rail = document.getElementById('elements-rail');
    const railW = (rail && rail.offsetParent !== null) ? rail.getBoundingClientRect().width : 0;
    const minLeft = vp.left, maxLeft = Math.max(vp.left, vp.right - railW - w);
    const header = panelEl.querySelector('[id$="-panel-header"]');
    const headerH = (header ? header.getBoundingClientRect().height : 0) || 46;
    const minTop = 0, maxTop = Math.max(0, window.innerHeight - headerH);
    return {
      left: Utils.clamp(left, minLeft, maxLeft),
      top:  Utils.clamp(top,  minTop,  maxTop)
    };
  },
  _ttClosePanel(table){
    this._ttStopPlay(table);
    table.panelEl.remove();
    const idx = this._ttPanels.indexOf(table);
    if(idx !== -1) this._ttPanels.splice(idx, 1);
    if(this._ttActiveTable === table) this._ttActiveTable = null;
    this._maybeResetPanelSpawnCascade();
    this._autosaveSoon();
  },
  /** Called every animation frame for every open table panel:
   *  1) Always rescales the panel relative to the zoom level it was
   *     created at, so its on-screen size tracks the canvas zoom exactly
   *     like a circuit element — zoom out and it shrinks with everything
   *     else, zoom in and it grows with everything else, instead of
   *     staying a fixed CSS pixel size and ending up mismatched.
   *  2) If pinned, also re-derives its screen position from its
   *     world-space anchor so it follows pan/zoom like a permanent
   *     element sitting on the sheet. If not pinned, position is left
   *     alone (it stays wherever it was placed/dragged on screen). */
  _ttSyncPanels(){
    if(!this._ttPanels) return;
    for(const table of this._ttPanels){
      const panel = table.panelEl;
      if(!panel || panel.style.display !== 'block') continue;
      const scale = this.renderer.zoom || 1;
      panel.style.transform = `scale(${scale})`;
      if(table.pinned && table.worldAnchor && !table.dragging){
        const vpRect = this.el.viewport.getBoundingClientRect();
        const screen = this.renderer.worldToScreen(table.worldAnchor.x, table.worldAnchor.y);
        const rawLeft = vpRect.left + screen.x, rawTop = vpRect.top + screen.y;
        // Pan/zoom can carry a world-anchored panel toward the top toolbar
        // or status bar — left/right stay clamped so it can't end up stuck
        // under the rail, and top/bottom are clamped against the viewport
        // so the header always stays visible/grabbable (the body can still
        // crop against #floating-panels-clip, same as a gate panned under
        // the canvas viewport's own edges).
        const { left, top } = this._ttClampHorizontal(panel, rawLeft, rawTop);
        panel.style.left = left + 'px';
        panel.style.top  = top  + 'px';
      }
    }
  },
  _ttRunGeneration(io, names, tableName, anchorScreenPos){
    document.getElementById('tt-setup-form').style.display = 'none';
    document.getElementById('tt-setup-loading').style.display = 'flex';
    this.el.ttSetupOverlay.style.display = 'flex';
    setTimeout(()=>{
      const rawRows = this._ttCompute(io);
      const filtered = this._ttFilterConstantProbes(io, names, rawRows);
      io = filtered.io; names = filtered.names;
      const rows = filtered.rows;
      this.el.ttSetupOverlay.style.display = 'none';
      const table = this._ttCreatePanelInstance();
      table.io = io; table.names = names; table.rows = rows; table.tableName = tableName || '';
      this._ttPanels.push(table);
      this._ttRenderPanel(table, anchorScreenPos);
      this._autosaveSoon();
    }, 650 + Math.random()*350);
  },
  /** Drops any PROBE output column whose value never changes across every
   *  input combination (always stuck at 0, or always stuck at 1) — a
   *  probe that never toggles carries no logical information in a truth
   *  table, so it's excluded rather than shown as a dead, uninformative
   *  column. LED outputs are always kept, since they represent the
   *  circuit's actual observable outputs rather than a debugging probe.
   *  If every output happens to be a constant probe, the first one is
   *  kept anyway so a table is never generated with zero columns. */
  _ttFilterConstantProbes(io, names, rows){
    if(!io.outputs || io.outputs.length === 0) return { io, names, rows };
    const keepIdx = [];
    io.outputs.forEach((o, idx)=>{
      if(o.type !== 'PROBE'){ keepIdx.push(idx); return; }
      const first = rows.length ? rows[0].outs[idx] : null;
      const constant = rows.every(r=> r.outs[idx] === first);
      if(!constant) keepIdx.push(idx);
    });
    if(keepIdx.length === io.outputs.length) return { io, names, rows };
    const finalIdx = keepIdx.length ? keepIdx : [0];
    const newOutputs = finalIdx.map(i=> io.outputs[i]);
    const newNames = finalIdx.map(i=> names[i]);
    const newRows = rows.map(r=> ({ bits: r.bits, outs: finalIdx.map(i=> r.outs[i]) }));
    return { io: { ...io, outputs: newOutputs }, names: newNames, rows: newRows };
  },
  _ttCompute(io){
    const orig = new Map();
    for(const inp of io.inputs){
      for(const c of this.model.components.values()){
        if(c.type === 'VARIABLE' && (c.label||'').trim().toUpperCase() === inp.label){
          orig.set(inp.label, c.state.value); break;
        }
      }
    }
    const n = io.inputs.length;
    const total = 1 << n;
    const rows = [];
    for(let mask=0; mask<total; mask++){
      const bits = [];
      for(let i=0;i<n;i++){
        const bit = (mask >> (n-1-i)) & 1;
        bits.push(bit);
        this._ttSetVar(io.inputs[i].label, bit === 1);
      }
      SimulationEngine.evaluate(this.model);
      const outs = io.outputs.map(o=>{
        const comp = this.model.getComponent(o.id);
        return comp && comp.inputValues ? comp.inputValues[0] : null;
      });
      rows.push({ bits, outs });
    }
    for(const inp of io.inputs) this._ttSetVar(inp.label, orig.get(inp.label));
    this.runSimulation();
    this._refreshAll();
    return rows;
  },
  /** Recreates a truth-table panel from saved data (io/names/tableName/
   *  worldAnchor) — used when restoring a snapshot (file-open, autosave,
   *  undo/redo) so tables persist as part of the design instead of being
   *  thrown away on reload. Reuses _ttRenderPanel for the actual DOM/table
   *  build, then snaps the panel to its saved world position. */
  _ttRestorePanel(saved){
    if(!saved || !saved.io) return;
    const rows = this._ttCompute(saved.io);
    const table = this._ttCreatePanelInstance();
    table.io = saved.io;
    table.names = saved.names;
    table.rows = rows;
    table.tableName = saved.tableName || '';
    this._ttPanels.push(table);
    this._ttRenderPanel(table);
    if(saved.worldAnchor){
      table.worldAnchor = saved.worldAnchor;
      const vpRect = this.el.viewport.getBoundingClientRect();
      const screen = this.renderer.worldToScreen(saved.worldAnchor.x, saved.worldAnchor.y);
      table.panelEl.style.left = (vpRect.left + screen.x) + 'px';
      table.panelEl.style.top  = (vpRect.top  + screen.y) + 'px';
    }
  },
  _ttRenderPanel(table, anchorScreenPos){
    const { io, names, rows } = table;
    const panel = table.panelEl;
    const body = panel.querySelector('#tt-panel-body');
    const headCells = io.inputs.map(i=>
      `<th style="padding:9px 16px; background:#0f2a4a; color:#f5f8fc; font-size:12.5px; font-weight:800; letter-spacing:0.03em; border-right:1px solid rgba(255,255,255,0.15); position:sticky; top:30px;">${this._ttEscape(i.label)}</th>`
    ).join('');
    const outHeadCells = names.map(nm=>
      `<th style="padding:9px 16px; background:#1e5fcc; color:#fff; font-size:12.5px; font-weight:800; letter-spacing:0.03em; border-right:1px solid rgba(255,255,255,0.18); position:sticky; top:30px;">${this._ttEscape(nm)}</th>`
    ).join('');
    const bodyRows = rows.map((row, ridx)=>{
      const zebra = ridx % 2 === 0 ? '#ffffff' : '#f4f6f9';
      const inCells = row.bits.map(b=>
        `<td style="padding:9px 16px; text-align:center; font-weight:700; font-size:13.5px; color:#16233a; border-right:1px solid #e3e7ec;">${b}</td>`
      ).join('');
      const outCells = row.outs.map(v=>{
        const txt = v === null ? '–' : v;
        const color = v === 1 ? '#1fae5c' : (v === 0 ? '#51607a' : '#c4cbd4');
        return `<td style="padding:9px 16px; text-align:center; font-weight:800; font-size:13.5px; color:${color}; border-right:1px solid #e3e7ec;">${txt}</td>`;
      }).join('');
      return `<tr data-mask="${ridx}" data-zebra="${zebra}" style="background:${zebra};">${inCells}${outCells}</tr>`;
    }).join('');
    body.innerHTML = `<table style="border-collapse:collapse; width:100%; font-family:var(--font-ui);">
      <thead>
        <tr>
          <th colspan="${io.inputs.length}" style="padding:7px 16px; background:#0a1d33; color:#9fd8ff; font-size:10.5px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; border-right:2px solid rgba(255,255,255,0.18); position:sticky; top:0;">Inputs</th>
          <th colspan="${names.length}" style="padding:7px 16px; background:#123e91; color:#cfe2ff; font-size:10.5px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; position:sticky; top:0;">Outputs</th>
        </tr>
        <tr>${headCells}${outHeadCells}</tr>
      </thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
    const nameEl = panel.querySelector('#tt-panel-name');
    if(nameEl){
      if(table.tableName){
        nameEl.textContent = table.tableName;
        nameEl.style.display = 'block';
      } else {
        nameEl.style.display = 'none';
      }
    }
    // Stagger each new table's default spawn position slightly so
    // generating several in a row — even interleaved with K-map panels —
    // doesn't stack them in an identical spot.
    let left, top;
    if(anchorScreenPos){
      left = anchorScreenPos.x + 16;
      top  = anchorScreenPos.y;
    } else {
      const offset = this._nextPanelSpawnOffset();
      const vp0 = this.el.viewport.getBoundingClientRect();
      left = vp0.right - 420 - offset;
      top  = vp0.top + 24 + offset;
    }
    panel.style.left = left + 'px';
    panel.style.top  = top  + 'px';
    panel.style.display = 'block';
    // Confine the spawn position to the design workspace itself (between
    // the top toolbar and status bar) — like any circuit element, a table
    // can't appear stuck under the menu bar or hanging off the bottom edge.
    const clamped = this._ttClampToWorkspace(panel, left, top);
    panel.style.left = clamped.left + 'px';
    panel.style.top  = clamped.top  + 'px';
    // Lock in the zoom level and natural (content-driven) width at the
    // moment this table is generated. From now on its CSS size is fixed
    // and a uniform scale() transform tracks the canvas zoom relative to
    // this baseline — exactly like a circuit element, so it never looks
    // mismatched in size against the design whether you zoom in or out.
    const naturalW = panel.getBoundingClientRect().width;
    table.baseZoom = this.renderer.zoom || 1;
    table.baseW = naturalW;
    panel.style.width = naturalW + 'px';
    panel.style.maxWidth = 'none';
    panel.style.transformOrigin = 'top left';
    // Anchor it to the design sheet at this exact spot right away — every
    // table is permanently pinned, so it must start tracking pan/zoom the
    // moment it appears, not just once a user manually pins it.
    const vpRect = this.el.viewport.getBoundingClientRect();
    table.worldAnchor = this.renderer.screenToWorld(clamped.left - vpRect.left, clamped.top - vpRect.top);
    this._ttBringToFront(table);
    this._ttUpdateHighlightOne(table);
  },
  _ttEscape(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },

  _ttTogglePlay(table){
    if(table.playing) this._ttStopPlay(table);
    else this._ttStartPlay(table);
  },
  _ttStartPlay(table){
    const io = table.io;
    if(!io || io.inputs.length === 0) return;
    const total = 1 << io.inputs.length;
    table.playing = true;
    table.playIndex = 0;
    const playBtn = table.panelEl.querySelector('#tt-panel-play');
    if(playBtn){
      playBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="1.5" width="4" height="13" rx="1"/><rect x="9" y="1.5" width="4" height="13" rx="1"/></svg>';
      playBtn.title = 'Pause';
    }
    const step = ()=>{
      const n = io.inputs.length;
      const mask = table.playIndex;
      for(let i=0;i<n;i++){
        const bit = (mask >> (n-1-i)) & 1;
        this._ttSetVar(io.inputs[i].label, bit === 1);
      }
      this.runSimulation();
      this._refreshAll();
      table.playIndex = (table.playIndex + 1) % total;
    };
    step(); // show the first combination immediately
    table.playTimer = setInterval(step, 900);
  },
  _ttStopPlay(table){
    if(table.playTimer){ clearInterval(table.playTimer); table.playTimer = null; }
    table.playing = false;
    const playBtn = table.panelEl && table.panelEl.querySelector('#tt-panel-play');
    if(playBtn){
      playBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1.7C3 1 3.8 0.6 4.4 1L14 7.1C14.5 7.4 14.5 8.1 14 8.4L4.4 14.5C3.8 14.9 3 14.5 3 13.8V1.7Z"/></svg>';
      playBtn.title = 'Play through all combinations';
    }
  },
  _ttCurrentMask(io){
    if(!io || !io.inputs.length) return null;
    let mask = 0;
    const n = io.inputs.length;
    for(let i=0;i<n;i++){
      let val = null;
      for(const c of this.model.components.values()){
        if(c.type === 'VARIABLE' && (c.label||'').trim().toUpperCase() === io.inputs[i].label){
          val = c.state.value; break;
        }
      }
      if(val === null || val === undefined) return null; // floating variable — no exact row to highlight
      if(val) mask |= (1 << (n-1-i));
    }
    return mask;
  },
  _ttUpdateHighlightOne(table){
    const panel = table.panelEl;
    if(!panel || panel.style.display !== 'block') return;
    const mask = this._ttCurrentMask(table.io);
    const rowsEl = panel.querySelectorAll('#tt-panel-body tr[data-mask]');
    rowsEl.forEach(tr=>{
      const isActive = mask !== null && Number(tr.dataset.mask) === mask;
      tr.style.background = isActive ? '#cdeffe' : tr.dataset.zebra;
      tr.style.outline = isActive ? '2px solid #14c8c4' : 'none';
      tr.style.outlineOffset = isActive ? '-1px' : '0';
    });
  },
  /** Refreshes the active-row highlight on every open table panel — each
   *  one highlights against its own captured input/output set. */
  _ttUpdateHighlight(){
    if(!this._ttPanels) return;
    for(const table of this._ttPanels) this._ttUpdateHighlightOne(table);
  },

  // WINDOW EVENTS / AUTOSAVE
  // =====================================================================
  _bindWindow(){
    window.addEventListener('resize', ()=>{
      this.renderer.resize();
      this.renderer.drawWires(this.model, (c,p,s)=>this._pinScreenPos(c,p,s), this.activeWireDrag);
    });
    // Safety-net saves: the periodic loop in _startAutosaveLoop() only
    // writes every few seconds, so a refresh/close/tab-switch that lands
    // in that gap right after drawing a wire or generating a truth table
    // (actions that, unlike most component edits, don't otherwise trigger
    // an immediate save) could lose that last bit of work. These fire a
    // synchronous save at every point the page might actually go away —
    // covering desktop refresh/close (beforeunload/pagehide) and mobile
    // tab-switch/refresh, where beforeunload is unreliable and
    // visibilitychange→hidden is the dependable signal instead.
    const flush = ()=>{ try{ this._dtAutosaveAll(); }catch(e){ /* non-critical */ } };
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', ()=>{ if(document.hidden) flush(); });
  },
  /** Debounced immediate autosave — called after any committed edit so
   *  changes are persisted within a fraction of a second instead of
   *  waiting on the periodic loop below. Coalesces bursts of rapid edits
   *  (e.g. dragging) into a single write ~300ms after they settle. */
  _autosaveSoon(){
    clearTimeout(this._autosaveSoonT);
    this._autosaveSoonT = setTimeout(()=>{
      this._dtAutosaveAll();
      this._blinkAutosaveIndicator();
    }, 300);
  },
  _blinkAutosaveIndicator(){
    const ind = document.getElementById('autosave-indicator');
    if(!ind) return;
    ind.style.opacity='1';
    clearTimeout(this._autosaveBlinkT);
    this._autosaveBlinkT = setTimeout(()=>{ ind.style.opacity='0.6'; }, 600);
  },
  _startAutosaveLoop(){
    // Kept as a fallback net (catches anything that doesn't go through
    // history.commit() or _autosaveSoon(), e.g. drag-in-progress state).
    setInterval(()=>{
      this._dtAutosaveAll();
      this._blinkAutosaveIndicator();
    }, 4000);
  },

  // =====================================================================
  // KARNAUGH MAP TOOL
  // Each generated K-map gets its own floating panel cloned from the
  // #km-panel template, exactly like Truth Table panels. Panels live in
  // this._kmPanels, sync to canvas zoom/pan in _tick() via
  // _kmSyncPanels(), and are independently draggable.
  // =====================================================================
  openKMapTool(){
    const io = this._ttCollectIO();
    this._kmIO = io;
    const body = document.getElementById('km-setup-body');
    const subtitle = document.getElementById('km-setup-subtitle');
    const genBtn = document.getElementById('km-setup-generate');
    body.innerHTML = '';
    document.getElementById('km-setup-error').style.display = 'none';
    document.getElementById('km-setup-loading').style.display = 'none';
    document.getElementById('km-setup-form').style.display = 'flex';
    if(io.inputs.length === 0){
      subtitle.textContent = io.scoped
        ? 'No VARIABLE elements found in your current selection. Select the circuit you want to map (including its variables), or click empty canvas to use the whole sheet.'
        : 'No VARIABLE elements found on the canvas. Add at least one input variable to generate a Karnaugh map.';
      genBtn.style.display = 'none';
    } else if(io.inputs.length > 6){
      subtitle.textContent = `This circuit has ${io.inputs.length} input variables. Karnaugh maps only support 2–6 variables — simplify the circuit or select a smaller sub-circuit first.`;
      genBtn.style.display = 'none';
    } else if(io.inputs.length === 1){
      subtitle.textContent = 'Karnaugh maps need at least 2 input variables — this circuit only has 1.';
      genBtn.style.display = 'none';
    } else if(io.outputs.length === 0){
      subtitle.textContent = io.scoped
        ? 'No LED or Probe outputs found in your current selection. Make sure the selected circuit includes its output(s).'
        : 'No LED or Probe outputs found on the canvas. Add at least one output to analyze.';
      genBtn.style.display = 'none';
    } else {
      subtitle.textContent = (io.scoped ? `Selected circuit — inputs: ${io.inputs.map(i=> i.label).join(', ')}.` : `Inputs detected: ${io.inputs.map(i=> i.label).join(', ')}.`) + ' Choose the output(s) to map:';
      genBtn.style.display = 'inline-block';
      io.outputs.forEach((o, idx)=>{
        const row = document.createElement('label');
        row.style.cssText = 'display:flex; align-items:center; gap:9px; padding:9px 10px; border:1.5px solid #e3e7ec; border-radius:8px; cursor:pointer; font-size:12.5px; font-weight:700; color:#16233a;';
        row.innerHTML = `<input type="checkbox" class="km-output-pick" value="${idx}" ${idx===0?'checked':''} style="accent-color:#14c8c4; width:15px; height:15px;">
          <span>${this._ttEscape(o.defaultName)} <span style="color:#8a93a1; font-weight:600;">(${o.type})</span></span>`;
        body.appendChild(row);
      });
    }
    document.getElementById('km-setup-overlay').style.display = 'flex';
  },

  _bindKMapTool(){
    // Setup dialog
    document.getElementById('km-setup-cancel').onclick = ()=>{ document.getElementById('km-setup-overlay').style.display = 'none'; };
    document.getElementById('km-setup-error-close').onclick = ()=>{ document.getElementById('km-setup-overlay').style.display = 'none'; };
    document.getElementById('km-setup-overlay').addEventListener('click', (e)=>{
      if(e.target === document.getElementById('km-setup-overlay')) document.getElementById('km-setup-overlay').style.display = 'none';
    });
    document.getElementById('km-setup-dialog').addEventListener('click', (e)=> e.stopPropagation());
    document.getElementById('km-setup-generate').onclick = ()=>{
      const io = this._kmIO;
      if(!io) return;
      const picked = [...document.querySelectorAll('.km-output-pick:checked')];
      const outIdxs = picked.map(cb=> parseInt(cb.value, 10));
      if(outIdxs.length === 0) return;
      this._kmRunGeneration(io, outIdxs);
    };
    // Context menu (right-click on panel)
    document.getElementById('km-ctx-delete').onclick = ()=>{
      document.getElementById('km-panel-ctxmenu').style.display = 'none';
      if(this._kmActivePanel) this._kmClosePanel(this._kmActivePanel);
    };
    document.addEventListener('mousedown', (e)=>{
      const menu = document.getElementById('km-panel-ctxmenu');
      if(menu && menu.style.display === 'block' && !menu.contains(e.target)) menu.style.display = 'none';
    });
    // Store template and initialise panel pool
    this._kmPanelTemplate = this.el.kmPanel.outerHTML;
    this._kmPanelsContainer = document.getElementById('floating-panels-clip');
    this.el.kmPanel.remove();
    this._kmPanels = [];
    this._kmZTop = 50;
  },

  /** Clones the panel template, wires all per-instance handlers, returns
   *  the panel object. Mirrors _ttCreatePanelInstance(). */
  _kmCreatePanelInstance(){
    const wrap = document.createElement('div');
    wrap.innerHTML = this._kmPanelTemplate;
    const panelEl = wrap.firstElementChild;
    panelEl.removeAttribute('id');
    this._kmPanelsContainer.appendChild(panelEl);
    panelEl.classList.add('tt-pinned');

    const panel = {
      id: 'km' + Date.now() + Math.random().toString(36).slice(2,7),
      panelEl, result: null, io: null, outIdx: null, pinned: true, dragging: false, worldAnchor: null, baseZoom: 1
    };

    const q = (sel)=> panelEl.querySelector(sel);

    panelEl.addEventListener('mousedown', ()=> this._kmBringToFront(panel), true);

    const openCtxMenu = (x, y)=>{
      this._kmActivePanel = panel;
      const menu = document.getElementById('km-panel-ctxmenu');
      menu.style.left = Utils.clamp(x, 4, window.innerWidth - 160) + 'px';
      menu.style.top  = Utils.clamp(y, 4, window.innerHeight - 60) + 'px';
      menu.style.display = 'block';
    };
    panelEl.addEventListener('contextmenu', (e)=>{ e.preventDefault(); e.stopPropagation(); openCtxMenu(e.clientX, e.clientY); });
    q('#km-panel-props').onclick = (e)=>{
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      openCtxMenu(r.left, r.bottom + 6);
    };

    q('#km-panel-play').onclick = (e)=>{
      e.stopPropagation();
      if(panel.result) this._kmTogglePlay(panel);
    };

    let offX = 0, offY = 0;
    panelEl.addEventListener('mousedown', (e)=>{
      if(e.target.closest('button')) return; // let play/props/export buttons handle their own clicks
      this._kmBringToFront(panel);
      panel.dragging = true;
      const rect = panelEl.getBoundingClientRect();
      offX = e.clientX - rect.left; offY = e.clientY - rect.top;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e)=>{
      if(!panel.dragging) return;
      const { left, top } = this._ttClampHorizontal(panelEl, e.clientX - offX, e.clientY - offY);
      panelEl.style.left = left + 'px'; panelEl.style.top = top + 'px';
      const vp = this.el.viewport.getBoundingClientRect();
      panel.worldAnchor = this.renderer.screenToWorld(left - vp.left, top - vp.top);
    });
    window.addEventListener('mouseup', ()=>{ if(panel.dragging){ panel.dragging = false; this._autosaveSoon(); } });

    return panel;
  },

  _kmBringToFront(panel){
    this._kmZTop += 1;
    panel.panelEl.style.zIndex = String(this._kmZTop);
  },

  _kmClosePanel(panel){
    this._kmStopPlay(panel);
    panel.panelEl.remove();
    const idx = this._kmPanels.indexOf(panel);
    if(idx !== -1) this._kmPanels.splice(idx, 1);
    if(this._kmActivePanel === panel) this._kmActivePanel = null;
    this._maybeResetPanelSpawnCascade();
    this._autosaveSoon();
  },

  /** Called each frame from _tick(): keeps every K-map panel locked to
   *  its world-space anchor so it follows canvas pan/zoom. */
  _kmSyncPanels(){
    if(!this._kmPanels) return;
    for(const panel of this._kmPanels){
      const el = panel.panelEl;
      if(!el || el.style.display !== 'flex') continue;
      el.style.transform = `scale(${this.renderer.zoom || 1})`;
      if(panel.pinned && panel.worldAnchor && !panel.dragging){
        const vpRect = this.el.viewport.getBoundingClientRect();
        const screen = this.renderer.worldToScreen(panel.worldAnchor.x, panel.worldAnchor.y);
        const rawLeft = vpRect.left + screen.x, rawTop = vpRect.top + screen.y;
        // Pan/zoom can carry a world-anchored panel toward the top toolbar
        // or status bar — left/right stay clamped so it can't end up stuck
        // under the rail, and top/bottom are clamped against the viewport
        // so the header always stays visible/grabbable (the body can still
        // crop against #floating-panels-clip, same as a gate panned under
        // the canvas viewport's own edges).
        const { left, top } = this._ttClampHorizontal(el, rawLeft, rawTop);
        el.style.left = left + 'px';
        el.style.top  = top  + 'px';
      }
    }
  },

  /** Recreates a K-map panel from saved data (io/outIdx/worldAnchor) —
   *  mirrors _ttRestorePanel. Re-runs the same analysis _kmRunGeneration
   *  does, synchronously and without the setup-dialog/loading UI, then
   *  snaps the panel to its saved world position. */
  _kmRestorePanel(saved){
    if(!saved || !saved.io || saved.outIdx == null) return;
    const io = saved.io;
    const rows = this._ttCompute(io);
    const n = io.inputs.length;
    const values = new Array(1 << n).fill(null);
    rows.forEach(row=>{
      const mask = KMapEngine.bitsToMask(row.bits);
      values[mask] = row.outs[saved.outIdx];
    });
    const labels = io.inputs.map(i=> i.label);
    const result = KMapEngine.analyze(n, labels, values);
    if(result.error || !io.outputs[saved.outIdx]) return;
    result.outputName = io.outputs[saved.outIdx].defaultName;
    this._kmSpawnPanel(result, io, saved.outIdx);
    const panel = this._kmPanels[this._kmPanels.length - 1];
    if(saved.worldAnchor){
      panel.worldAnchor = saved.worldAnchor;
      const vpRect = this.el.viewport.getBoundingClientRect();
      const screen = this.renderer.worldToScreen(saved.worldAnchor.x, saved.worldAnchor.y);
      panel.panelEl.style.left = (vpRect.left + screen.x) + 'px';
      panel.panelEl.style.top  = (vpRect.top  + screen.y) + 'px';
    }
  },
  _kmRunGeneration(io, outIdxs){
    // Accept either a single index (legacy callers, e.g. restore-from-save)
    // or an array of indices (multi-select from the setup dialog).
    const idxList = Array.isArray(outIdxs) ? outIdxs : [outIdxs];
    document.getElementById('km-setup-form').style.display = 'none';
    document.getElementById('km-setup-error').style.display = 'none';
    document.getElementById('km-setup-loading').style.display = 'flex';
    setTimeout(()=>{
      try{
        const rows = this._ttCompute(io);
        const n = io.inputs.length;
        const labels = io.inputs.map(i=> i.label);
        const errors = [];
        let spawned = 0;
        idxList.forEach(outIdx=>{
          const values = new Array(1 << n).fill(null);
          rows.forEach(row=>{
            const mask = KMapEngine.bitsToMask(row.bits);
            values[mask] = row.outs[outIdx];
          });
          const result = KMapEngine.analyze(n, labels, values);
          if(result.error){
            errors.push(`${io.outputs[outIdx].defaultName}: ${result.error}`);
            return;
          }
          // A K-map that's all-0 or all-1 across every input combination
          // isn't really implementing any logic — flag it instead of
          // drawing a map with a single "0"/"1" group on it.
          if(result.minimized && (result.minimized.allZero || result.minimized.allOnes)){
            const constVal = result.minimized.allOnes ? '1' : '0';
            errors.push(`${io.outputs[outIdx].defaultName} is always ${constVal} for every input combination — there's no logic operation happening for this output, so no K-map was generated.`);
            return;
          }
          result.outputName = io.outputs[outIdx].defaultName;
          this._kmSpawnPanel(result, io, outIdx);
          spawned++;
        });
        document.getElementById('km-setup-overlay').style.display = 'none';
        if(errors.length){
          this._kmShowSetupError(errors.join(' '));
        }
      }catch(err){
        document.getElementById('km-setup-overlay').style.display = 'flex';
        this._kmShowSetupError('Unexpected error: ' + err.message);
      }
    }, 450 + Math.random()*250);
  },

  _kmShowSetupError(msg){
    document.getElementById('km-setup-loading').style.display = 'none';
    document.getElementById('km-setup-form').style.display = 'none';
    document.getElementById('km-setup-error').style.display = 'flex';
    document.getElementById('km-setup-error-msg').textContent = msg;
    document.getElementById('km-setup-overlay').style.display = 'flex';
  },

  /** Creates a panel instance, fills it with the K-map result, places
   *  it on the canvas and anchors it to world-space. */
  _kmSpawnPanel(result, io, outIdx){
    const panel = this._kmCreatePanelInstance();
    panel.result = result;
    panel.io = io;
    panel.outIdx = outIdx;
    this._kmPanels.push(panel);
    const el = panel.panelEl;
    const q = (sel)=> el.querySelector(sel);

    q('#km-panel-subtitle').textContent =
      `${result.outputName} · ${result.n} var (${result.inputLabels.join(', ')})`;

    // 1 — K-map grid
    this._kmRenderGrid(result, q('#km-panel-grid'));

    // 2 — Simplified expression
    const exprEl = q('#km-panel-expr');
    const exprText = `${result.outputName} = ${result.simplified}`;
    exprEl.textContent = exprText;
    exprEl.style.cursor = 'pointer';
    exprEl.title = 'Click to copy';
    exprEl.onclick = ()=>{
      const finish = ()=>{
        const original = exprText;
        exprEl.textContent = 'Copied!';
        setTimeout(()=>{ exprEl.textContent = original; }, 900);
      };
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(exprText).then(finish).catch(finish);
      } else {
        const ta = document.createElement('textarea');
        ta.value = exprText;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try{ document.execCommand('copy'); }catch(e){}
        document.body.removeChild(ta);
        finish();
      }
    };

    // 3 — Group legend (color swatch + term + cell count)
    const legendEl = q('#km-panel-legend');
    if(result.groups.length){
      legendEl.innerHTML = result.groups.map(g=>
        `<div style="display:inline-flex;align-items:center;gap:5px;padding:2px 0;min-width:0;flex:0 0 calc(25% - 11px);">
          <span style="width:10px;height:10px;border-radius:2px;background:${g.color};flex:none;display:inline-block;"></span>
          <span style="font-family:'Courier New',monospace;font-weight:800;font-size:11px;color:#16233a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${this._ttEscape(g.term)}</span>
        </div>`
      ).join('');
    } else {
      legendEl.style.display = 'none';
    }

    // Spawn position (staggered via the shared cascade counter — same one
    // Truth Table panels use — clamped to workspace)
    const offset = this._nextPanelSpawnOffset();
    const vp0 = this.el.viewport.getBoundingClientRect();
    // Let the panel grow to its natural content height — it shouldn't be
    // force-capped to the viewport, since that's what was producing the
    // internal scrollbar instead of showing the whole map.
    let left = vp0.right - 440 - offset;
    let top  = vp0.top   +  30 + offset;
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.style.display = 'flex';
    const clamped = this._ttClampToWorkspace(el, left, top);
    el.style.left = clamped.left + 'px'; el.style.top = clamped.top + 'px';

    // Freeze natural width; anchor to world-space so pan/zoom syncs
    el.style.width = el.getBoundingClientRect().width + 'px';
    el.style.maxWidth = 'none';
    el.style.transformOrigin = 'top left';
    const vpRect = this.el.viewport.getBoundingClientRect();
    panel.worldAnchor = this.renderer.screenToWorld(clamped.left - vpRect.left, clamped.top - vpRect.top);
    this._kmBringToFront(panel);
    this._autosaveSoon();
  },

  /** Renders the Gray-coded K-map grid table into `container`. */
  _kmRenderGrid(result, container){
    const { grid } = result;
    const ra = grid.rowLabels.join(''), ca = grid.colLabels.join('');
    let html = `<table class="km-table" style="border-collapse:collapse;"><thead><tr>`;
    html += `<th class="km-cell" style="background:#0a1d33;vertical-align:middle;"><span class="km-axis-label" style="color:#9fd8ff;font-size:9.5px;">${this._ttEscape(ra)}\\${this._ttEscape(ca)}</span></th>`;
    grid.colHeaderLabels.forEach(c=> html += `<th class="km-cell" style="background:#123e91;color:#cfe2ff;">${c}</th>`);
    html += '</tr></thead><tbody>';
    for(let r=0;r<grid.rows;r++){
      html += `<tr><th class="km-cell" style="background:#0f2a4a;color:#f5f8fc;">${grid.rowHeaderLabels[r]}</th>`;
      for(let c=0;c<grid.cols;c++){
        const cell = grid.cells.find(cc=> cc.r===r && cc.c===c);
        const v = cell.value;
        const txt = v===null?'X':v;
        const valColor = v===1?'#0f2a4a':(v===0?'#8a93a1':'#c4892f');
        const chips = cell.groups.map(col=>`<span class="km-chip" style="background:${col};"></span>`).join('');
        const bg = cell.groups.length ? this._kmTint(cell.groups[0]) : '#fff';
        html += `<td class="km-cell" data-mask="${cell.mask}" style="background:${bg};">
          <span class="km-cell-mt">${cell.mask}</span>
          <span class="km-cell-val" style="color:${valColor};">${txt}</span>
          <span class="km-cell-chips">${chips}</span>
        </td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  },

  _kmTint(hex){
    const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},0.22)`;
  },

  /** Plays through every input combination on this K-map's panel, driving
   *  the live circuit variables (mirrors _ttStartPlay/_ttStopPlay) and
   *  highlighting the active cell on the grid as it steps. */
  _kmTogglePlay(panel){
    if(panel.playing) this._kmStopPlay(panel);
    else this._kmStartPlay(panel);
  },
  _kmStartPlay(panel){
    const result = panel.result;
    const labels = result && result.inputLabels;
    if(!labels || labels.length === 0) return;
    const n = labels.length;
    const total = 1 << n;
    panel.playing = true;
    panel.playIndex = 0;
    const playBtn = panel.panelEl.querySelector('#km-panel-play');
    if(playBtn){
      playBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><rect x="3" y="1.5" width="4" height="13" rx="1"/><rect x="9" y="1.5" width="4" height="13" rx="1"/></svg>';
      playBtn.title = 'Pause';
    }
    const step = ()=>{
      const mask = panel.playIndex;
      for(let i=0;i<n;i++){
        const bit = (mask >> (n-1-i)) & 1;
        this._ttSetVar(labels[i], bit === 1);
      }
      this.runSimulation();
      this._refreshAll();
      this._kmUpdateHighlight(panel, mask);
      panel.playIndex = (panel.playIndex + 1) % total;
    };
    step(); // show the first combination immediately
    panel.playTimer = setInterval(step, 900);
  },
  _kmStopPlay(panel){
    if(panel.playTimer){ clearInterval(panel.playTimer); panel.playTimer = null; }
    panel.playing = false;
    const playBtn = panel.panelEl && panel.panelEl.querySelector('#km-panel-play');
    if(playBtn){
      playBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M3 1.7C3 1 3.8 0.6 4.4 1L14 7.1C14.5 7.4 14.5 8.1 14 8.4L4.4 14.5C3.8 14.9 3 14.5 3 13.8V1.7Z"/></svg>';
      playBtn.title = 'Play through all combinations';
    }
    if(panel.panelEl) this._kmUpdateHighlight(panel, null);
  },
  /** Outlines the K-map cell matching `mask` (the current playback
   *  combination) and clears the outline on every other cell. */
  _kmUpdateHighlight(panel, mask){
    const panelEl = panel.panelEl;
    if(!panelEl) return;
    const cells = panelEl.querySelectorAll('#km-panel-grid td[data-mask]');
    cells.forEach(td=>{
      const isActive = mask !== null && Number(td.dataset.mask) === mask;
      td.style.outline = isActive ? '2px solid #14c8c4' : 'none';
      td.style.outlineOffset = isActive ? '-2px' : '0';
    });
  },



};

