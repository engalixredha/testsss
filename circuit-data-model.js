// =========================================================================
// 3 & 4. DATA MODEL — Component, Wire, CircuitModel
// -------------------------------------------------------------------------
// Components and wires are plain-data-ish classes. All geometry helpers
// (pin world positions) account for rotation (0/90/180/270).
// =========================================================================

/** Represents one placed instance of a GateLibrary type. */
class CircuitComponent{
  constructor(type, x, y, id){
    this.id = id || Utils.uid('c');
    this.type = type;                 // key into GateLibrary
    this.x = x; this.y = y;           // world-space top-left at rotation 0
    this.rotation = 0;                // 0, 90, 180, 270 (degrees, clockwise)
    this.label = GateLibrary[type].label;
    this.state = GateLibrary[type].initState ? GateLibrary[type].initState() : {};
    // Runtime-only (not persisted as part of the *logical* identity, but
    // saved in .ARLC for restore convenience): computed pin values each tick.
    this.inputValues = [];   // values currently present at each input pin (1/0/null)
    this.outputValues = [];  // values this component is currently driving
    // Per-instance input count override (only meaningful for ExpandableGates
    // types — AND/OR/NAND/NOR/XOR/XNOR). null/undefined = use the
    // GateLibrary default (2). Two instances of the same gate type can have
    // different input counts; this is why `def` is computed per-instance
    // below rather than just returning the shared GateLibrary entry.
    this.inputCount = null;
    // Linked-copy group id (only meaningful for SWITCH components). Two or
    // more switches sharing the same non-null linkGroup id are "operationally
    // linked": toggling any one of them toggles all the others in the same
    // group to match. null means this switch is independent (a normal copy,
    // or never linked). See App.toggleLinkedSwitch / App._linkedCopySelection.
    this.linkGroup = null;
    // 'block' (default, plain labeled box) or 'circuit' (x-ray view showing
    // the internal gates/wires) — only meaningful for KIT_NETLISTS types.
    this.viewMode = 'block';
  }
  /**
   * Per-instance definition. For non-expandable types (or expandable types
   * still at the default count) this is just the shared GateLibrary entry,
   * unchanged — zero extra cost for the common case. For an expandable gate
   * whose inputCount has been customized, this synthesizes a new `inputs`
   * array (evenly spaced down the left edge) and a taller `h` so the extra
   * pins have room, while reusing the base entry's evaluate/outputs/shape.
   */
  get def(){
    const base = GateLibrary[this.type];
    // VARIABLE: widen the per-instance def (never the shared GateLibrary
    // entry) so a longer custom name gets a wider body to sit in. `w`/`h`
    // below are plain getters with no setter, so this is the only place
    // that can actually change a VARIABLE's effective width — assigning to
    // `component.w` directly is a silent no-op.
    if(this.type === 'VARIABLE'){
      const label = (this.label || '?').toUpperCase();
      const charW = 11;   // approx px per character of the bold italic var-letter font
      const padding = 22; // left+right breathing room inside the body
      const desiredW = Math.max(base.w, Math.round(label.length * charW + padding));
      if(desiredW === base.w) return base;
      if(!this._defCache || this._defCache._varW !== desiredW){
        this._defCache = Object.assign({}, base, { w: desiredW, _varW: desiredW });
      }
      return this._defCache;
    }
    // TEXT: auto-size the box to fit the current text + font size, so
    // changing either in the Properties panel is all "resizing" ever takes —
    // there's no drag-a-corner resize handle anywhere else in the app either.
    if(this.type === 'TEXT'){
      const fontSize = (this.state && this.state.fontSize) || 18;
      const text = (this.state && this.state.text) || 'Text';
      const longestLine = text.split('\n').reduce((m,l)=>Math.max(m,l.length), 1);
      const lineCount = Math.max(1, text.split('\n').length);
      const charW = fontSize * 0.58;
      const padding = 18;
      const desiredW = Math.max(30, Math.round(longestLine * charW + padding));
      const desiredH = Math.max(22, Math.round(lineCount * fontSize * 1.35 + 10));
      if(desiredW === base.w && desiredH === base.h) return base;
      if(!this._defCache || this._defCache._textW !== desiredW || this._defCache._textH !== desiredH){
        this._defCache = Object.assign({}, base, { w: desiredW, h: desiredH, _textW: desiredW, _textH: desiredH });
      }
      return this._defCache;
    }
    // Kit "Full Circuit" view: swap in an enlarged footprint sized to fit
    // the internal gate schematic (see _buildKitLayout). Inputs/outputs
    // keep their original dy fractions, so pins stay evenly spread down
    // the taller edge and every existing wire still lands in the same
    // relative spot.
    if(this.viewMode === 'circuit' && KIT_NETLISTS[this.type]){
      if(!this._defCache || this._defCache._kitCircuit !== true){
        const layout = _buildKitLayout(this.type, base);
        this._defCache = Object.assign({}, base, { w: layout.W, h: layout.H, _kitCircuit:true });
      }
      return this._defCache;
    }
    if(!ExpandableGates.has(this.type)) return base;
    const n = this.inputCount || base.inputs.length;
    if(n === base.inputs.length) return base;
    if(!this._defCache || this._defCache._n !== n){
      const inputs = [];
      for(let k=0;k<n;k++){
        inputs.push({ id: String.fromCharCode(97+k), dy: (k+1)/(n+1) });
      }
      // Taller body so pins stay comfortably spaced as N grows — base height
      // covers 2 inputs; add the same per-pin spacing for each extra input.
      const perPin = base.h / (base.inputs.length + 1);
      const h = Math.round(perPin * (n + 1));
      this._defCache = Object.assign({}, base, { inputs, h, _n:n });
    }
    return this._defCache;
  }
  get w(){ return this.def.w; }
  get h(){ return this.def.h; }

  /** Returns {x,y} world-space center of this component (rotation-agnostic). */
  centerWorld(){ return { x:this.x + this.w/2, y:this.y + this.h/2 }; }

  /**
   * Computes the world-space position of a given pin (input or output) of
   * this component, accounting for current rotation. Rotation is applied
   * around the component's own center.
   * Inputs: pin descriptor {id, dy} (dx implied 0=left edge for inputs,
   *         1=right edge for outputs — see PIN_SIDE below), side: 'in'|'out'
   * Output: {x, y} in world space.
   */
  pinWorldPos(pinDef, side){
    // NODE is a true single-point junction: both its input and output pin
    // live at the component's exact center (not the left/right edges like
    // every other component), so wires always terminate precisely on the dot.
    let localX;
    if(this.type === 'NODE'){
      localX = this.w/2;
    } else if(this.viewMode === 'circuit' && KIT_NETLISTS[this.type]){
      // Full Circuit x-ray view: pull the real, wireable pin in from the
      // raw edge so it lands exactly where the internal schematic's own
      // wiring already ends (KIT_PIN_INSET, shared with _buildKitLayout) —
      // comfortably inside the board's thick border instead of straddling it.
      localX = side === 'in' ? KIT_PIN_INSET : this.w - KIT_PIN_INSET;
    } else {
      localX = side === 'in' ? 0 : this.w;
    }
    const localY = pinDef.dy * this.h;
    return this._rotateLocalToWorld(localX, localY);
  }
  /** Looks up a pin by id regardless of whether it happens to be an input
   *  or an output of this component, returning its descriptor + actual
   *  side ({pinDef, side, index}), or null if no such pin exists. Wires
   *  can now connect ANY pin to ANY other pin (input-input, output-output,
   *  output-input, even two pins on the same component) — there is no
   *  fixed "from is always an output / to is always an input" rule, so
   *  geometry and simulation must always resolve a pin's real side from
   *  its own component definition rather than from the wire's stored
   *  from/to role. */
  resolvePin(pinId){
    let idx = this.def.inputs.findIndex(p=>p.id===pinId);
    if(idx !== -1) return { pinDef: this.def.inputs[idx], side:'in', index:idx };
    idx = this.def.outputs.findIndex(p=>p.id===pinId);
    if(idx !== -1) return { pinDef: this.def.outputs[idx], side:'out', index:idx };
    return null;
  }
  _rotateLocalToWorld(localX, localY){
    const cx = this.w/2, cy = this.h/2;
    let dx = localX - cx, dy = localY - cy;
    // Apply flips before rotation
    if(this._flipX) dx = -dx;
    if(this._flipY) dy = -dy;
    let rx, ry;
    switch(((this.rotation % 360)+360)%360){
      case 90:  rx = -dy; ry =  dx; break;
      case 180: rx = -dx; ry = -dy; break;
      case 270: rx =  dy; ry = -dx; break;
      default:  rx =  dx; ry =  dy; break;
    }
    return { x: this.x + cx + rx, y: this.y + cy + ry };
  }
  /** Effective rendered width/height after rotation (swaps on 90/270). */
  renderedSize(){
    const r = ((this.rotation%360)+360)%360;
    return (r===90||r===270) ? {w:this.h, h:this.w} : {w:this.w, h:this.h};
  }
  toJSON(){
    return { id:this.id, type:this.type, x:this.x, y:this.y, rotation:this.rotation,
             label:this.label, state:this.state, inputCount:this.inputCount||undefined,
             linkGroup:this.linkGroup||undefined,
             linkedSourceName:this.linkedSourceName||undefined,
             bankGroup:this.bankGroup||undefined,
             flipX:this._flipX||undefined, flipY:this._flipY||undefined,
             viewMode:this.viewMode!=='block'?this.viewMode:undefined };
  }
  static fromJSON(o){
    const c = new CircuitComponent(o.type, o.x, o.y, o.id);
    c.rotation = o.rotation||0; c.label = o.label!==undefined?o.label:c.label;
    // Deep-clone state rather than assigning o.state by reference. Without
    // this, every paste of a copied component (and every load of a saved
    // file) would share the exact same state object as its source — so
    // toggling one SWITCH/VARIABLE would silently flip every other copy
    // ever made from it, regardless of whether they were meant to be
    // linked. Each component must own its own independent state object;
    // intentional linking is handled separately via linkGroup.
    c.state = o.state ? JSON.parse(JSON.stringify(o.state)) : c.state;
    if(o.inputCount && ExpandableGates.has(o.type)) c.inputCount = o.inputCount;
    if(o.linkGroup) c.linkGroup = o.linkGroup;
    if(o.linkedSourceName) c.linkedSourceName = o.linkedSourceName;
    if(o.bankGroup) c.bankGroup = o.bankGroup;
    if(o.flipX) c._flipX = o.flipX;
    if(o.flipY) c._flipY = o.flipY;
    if(o.viewMode) c.viewMode = o.viewMode;
    return c;
  }
}

/** Represents one wire connecting an output pin to an input pin. */
class CircuitWire{
  constructor(fromCompId, fromPinId, toCompId, toPinId, id){
    this.id = id || Utils.uid('w');
    this.fromComp = fromCompId; this.fromPin = fromPinId;
    this.toComp = toCompId; this.toPin = toPinId;
    this.value = null; // cached signal value (1/0/null) for rendering
    // Custom waypoints (world-space {x,y} array). When set, the wire follows
    // these points exactly instead of the auto-router. First/last points are
    // always overridden by the actual pin positions at draw time.
    this.waypoints = null; // null = use auto-router
  }
  toJSON(){
    const j = { id:this.id, fromComp:this.fromComp, fromPin:this.fromPin, toComp:this.toComp, toPin:this.toPin };
    if(this.waypoints) j.waypoints = this.waypoints.map(p=>({x:Math.round(p.x*100)/100, y:Math.round(p.y*100)/100}));
    return j;
  }
  static fromJSON(o){
    const w = new CircuitWire(o.fromComp, o.fromPin, o.toComp, o.toPin, o.id);
    if(o.waypoints && Array.isArray(o.waypoints) && o.waypoints.length >= 2) w.waypoints = o.waypoints;
    return w;
  }
}

/**
 * CircuitModel owns the authoritative set of components + wires for the
 * current circuit, plus derived adjacency lookups used by the simulation
 * engine and renderer. It has no knowledge of DOM/canvas — purely data.
 */
class CircuitModel{
  constructor(){
    this.components = new Map();  // id -> CircuitComponent
    this.wires = new Map();       // id -> CircuitWire
  }
  addComponent(c){ this.components.set(c.id, c); return c; }
  removeComponent(id){
    this.components.delete(id);
    // cascade: remove any wire touching this component
    for(const [wid, w] of this.wires){
      if(w.fromComp===id || w.toComp===id) this.wires.delete(wid);
    }
  }
  addWire(w){
    // A wire must join two distinct pins — connecting a pin to itself is a
    // degenerate zero-length loop and is silently ignored.
    if(w.fromComp===w.toComp && w.fromPin===w.toPin) return null;
    // No restriction on what kind of pin can sit at either end: inputs,
    // outputs, two inputs, two outputs, pins on the same component — all
    // allowed. Any pin may now carry any number of wires (the old "an
    // input pin gets at most one driving wire, except NODE" rule is gone —
    // every pin behaves like NODE's junction: multiple connections merge
    // via OR-semantics in SimulationEngine). We only guard against an
    // exact literal duplicate of the same pin-pair, checked in both
    // directions since a wire's from/to order no longer carries meaning.
    for(const existing of this.wires.values()){
      const sameDir = existing.fromComp===w.fromComp && existing.fromPin===w.fromPin &&
                       existing.toComp===w.toComp && existing.toPin===w.toPin;
      const revDir  = existing.fromComp===w.toComp && existing.fromPin===w.toPin &&
                       existing.toComp===w.fromComp && existing.toPin===w.fromPin;
      if(sameDir || revDir) this.wires.delete(existing.id);
    }
    this.wires.set(w.id, w);
    return w;
  }
  removeWire(id){ this.wires.delete(id); }
  getComponent(id){ return this.components.get(id); }

  /** All wires that have this exact (compId, pinId) as their "from" endpoint.
   *  Note: since wiring is unrestricted, a "from" pin isn't necessarily an
   *  output — these are simple lookups by stored role, not by electrical
   *  meaning. SimulationEngine no longer relies on these (it builds nets
   *  directly from all wires); kept as general-purpose lookups for UI code. */
  wiresFrom(compId, pinId){
    return [...this.wires.values()].filter(w=>w.fromComp===compId && w.fromPin===pinId);
  }
  /** The first wire (or undefined) with this (compId, pinId) as its "to"
   *  endpoint. See note on wiresFrom above. */
  wireTo(compId, pinId){
    return [...this.wires.values()].find(w=>w.toComp===compId && w.toPin===pinId);
  }
  /** ALL wires with this (compId, pinId) as their "to" endpoint. */
  wiresTo(compId, pinId){
    return [...this.wires.values()].filter(w=>w.toComp===compId && w.toPin===pinId);
  }
  clear(){ this.components.clear(); this.wires.clear(); }

  serialize(viewState){
    return {
      format:'ARLC', version:1,
      generatedAt: new Date().toISOString(),
      view: viewState || {pan:{x:0,y:0}, zoom:1, gridSize:20},
      components: [...this.components.values()].map(c=>c.toJSON()),
      wires: [...this.wires.values()].map(w=>w.toJSON()),
      // [EXTENSION POINT] future versions can add top-level keys here
      // (e.g. "clockSettings", "busDefinitions") without breaking old files —
      // PersistenceManager.load() ignores unknown keys gracefully.
    };
  }
  static deserialize(data){
    const model = new CircuitModel();
    (data.components||[]).forEach(o=>model.addComponent(CircuitComponent.fromJSON(o)));
    (data.wires||[]).forEach(o=>model.addWire(CircuitWire.fromJSON(o)));
    return model;
  }
}

