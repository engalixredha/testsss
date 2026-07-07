// =========================================================================
// 5. SIMULATION ENGINE
// -------------------------------------------------------------------------
// Evaluates the entire circuit whenever something changes. For Version 1
// (purely combinational, no feedback-loop support beyond simple iteration)
// we use a fixed-point iteration: repeatedly evaluate every component until
// no output values change (or an iteration cap is hit, which gracefully
// marks unstable nets as floating rather than infinite-looping on cycles).
//
// [EXTENSION POINT] Stateful components (flip-flops, registers, RAM):
// add a `tickClockEdge(component)` pass here that runs BEFORE the
// combinational fixed-point loop on a rising/falling clock edge, mutating
// `component.state` rather than recomputing purely from inputs. The
// `stateful` flag on GateLibrary entries is already reserved for this.
// =========================================================================
const SimulationEngine = {
  MAX_ITERATIONS: 64,

  /** Runs a full propagation pass over the given CircuitModel. Mutates
   *  component.inputValues/outputValues and wire.value in place.
   *
   *  Wiring is now unrestricted — any pin can connect to any other pin,
   *  regardless of input/output role. So instead of assuming each wire
   *  is "an output driving an input" (the old model), every pin that's
   *  touched by at least one wire is grouped into an electrical "net"
   *  via union-find: a net is just the connected set of pins reachable
   *  by following wires. A net's value is the OR-merge (1 beats 0 beats
   *  null/floating) of every OUTPUT pin that happens to sit on that net —
   *  this is exactly the same merge rule NODE always used for its single
   *  junction, generalized to apply to every pin everywhere. Every INPUT
   *  pin on a net simply reads that net's merged value. */
  evaluate(model){
    const comps = [...model.components.values()];
    for(const c of comps){
      if(!c.outputValues || c.outputValues.length !== c.def.outputs.length){
        c.outputValues = c.def.outputs.map(()=>null);
      }
    }

    // ---- Build pin nets (union-find over wire endpoints) ----------------
    const key = (compId,pinId)=> compId+'\u0000'+pinId;
    const parent = new Map();
    const find = (k)=>{
      if(!parent.has(k)) parent.set(k,k);
      let r = k;
      while(parent.get(r) !== r) r = parent.get(r);
      let cur = k;
      while(parent.get(cur) !== r){ const next = parent.get(cur); parent.set(cur, r); cur = next; }
      return r;
    };
    const union = (a,b)=>{ const ra=find(a), rb=find(b); if(ra!==rb) parent.set(ra, rb); };
    for(const w of model.wires.values()){
      union(key(w.fromComp,w.fromPin), key(w.toComp,w.toPin));
    }
    // A NODE's 'in' and 'a' pins are drawn as a single coincident dot and
    // are meant to always be the exact same electrical point — a plain
    // junction, not a one-way relay. Union them unconditionally here so
    // that holds true no matter which of the two pins a wire happens to
    // reference (including wires from before this pairing was enforced at
    // draw-time): every wire touching a given junction ends up on the
    // same net, all the way around, not just in whichever section
    // happened to reference the same pin id.
    for(const c of comps){
      if(c.type === 'NODE') union(key(c.id,'in'), key(c.id,'a'));
    }

    // Map: net root -> list of {comp, idx} for every OUTPUT pin on that net.
    // NODE is deliberately excluded here: it's a passive junction (its 'in'
    // and 'a' pins are unioned together above so anything wired to either
    // one shares the net), not an active source. If its own computed
    // output were allowed to register as a driver, it would become a
    // feedback source on its own net — the "own output value" it computed
    // last tick would keep feeding back into "own input" every tick after,
    // latching the net at whatever value it last saw even once every real
    // driver (e.g. both switches) goes back to 0. Skipping NODE here is
    // what keeps a junction purely transparent instead of a tiny latch.
    const netDrivers = new Map();
    for(const c of comps){
      if(c.type === 'NODE') continue;
      c.def.outputs.forEach((p, idx)=>{
        const k = key(c.id, p.id);
        if(!parent.has(k)) return; // this output isn't wired to anything
        const root = find(k);
        if(!netDrivers.has(root)) netDrivers.set(root, []);
        netDrivers.get(root).push({ comp:c, idx });
      });
    }
    const netValue = (root)=>{
      const drivers = netDrivers.get(root);
      if(!drivers || drivers.length===0) return null; // no driver on this net = floating
      let merged = null;
      for(const {comp, idx} of drivers){
        const v = (comp.outputValues||[])[idx];
        if(v !== null && v !== undefined && (merged===null || v>merged)) merged = v;
      }
      return merged;
    };

    let changed = true, iterations = 0;
    while(changed && iterations < this.MAX_ITERATIONS){
      changed = false;
      iterations++;
      for(const c of comps){
        const def = c.def;
        const inputValues = def.inputs.map(pin=>{
          const k = key(c.id, pin.id);
          if(!parent.has(k)) return null; // unconnected input = floating
          return netValue(find(k));
        });
        c.inputValues = inputValues;
        const newOutputs = def.evaluate(inputValues, c.state) || [];
        for(let kk=0;kk<newOutputs.length;kk++){
          if(c.outputValues[kk] !== newOutputs[kk]){ c.outputValues[kk] = newOutputs[kk]; changed = true; }
        }
      }
    }

    // Final pass: cache each wire's net value for rendering (color). Both
    // ends of a wire sit on the same net by construction, so either
    // endpoint's net lookup gives the same answer.
    for(const w of model.wires.values()){
      const k = key(w.fromComp, w.fromPin);
      w.value = parent.has(k) ? netValue(find(k)) : null;
    }
  }
};

