// =========================================================================
// 2. GATE LIBRARY
// -------------------------------------------------------------------------
// Single source of truth for every placeable component "type". Each entry
// describes:
//   - category: which toolbox section it belongs to ('gate' | 'input' | 'output')
//   - width/height: default footprint in world units (grid-aligned)
//   - inputs: array of {id, dx, dy} pin offsets from the component's top-left
//             at rotation 0 (dx/dy are recalculated per-rotation at render time)
//   - outputs: array of {id, dx, dy} (same shape as inputs)
//   - evaluate(inputValues): given an array of input pin values (each is
//     1, 0, or null for floating/undefined), returns an array of output
//     values in the same order as `outputs`. Pure function — no side effects.
//   - stateful: false for all Version 1 components (combinational only).
//
// [EXTENSION POINT] Future versions add new entries here (e.g. 'DFF',
// 'CLOCK', 'MUX2', 'SEVEN_SEG', ...). Stateful components should set
// `stateful: true` and provide `initState()` / `evaluate(inputValues, state)`
// — SimulationEngine.evaluateComponent() already checks for `stateful` and
// is ready to branch on it; only this registry and SimulationEngine's
// clock-edge handling need to grow.
// =========================================================================
// =========================================================================
// 1b. EXPANDABLE GATES — which gate types support a configurable input
// count beyond the GateLibrary default of 2, and the allowed range.
// Only the commutative/associative binary-style gates make sense with N
// inputs (AND/OR/NAND/NOR/XOR/XNOR). NOT and BUFFER are strictly 1-input
// by definition; non-gate types (switches, LEDs, etc.) are never expandable.
// Upper bound of 6 is a practical ceiling: beyond that, pin spacing on a
// gate body this size gets cramped and the symbol stops reading clearly —
// 6 comfortably covers real teaching/hobby circuits without degrading the
// drawing.
// =========================================================================
const ExpandableGates = new Set(['AND','OR','NAND','NOR','XOR','XNOR']);
const GATE_MIN_INPUTS = 2;
const GATE_MAX_INPUTS = 6;

// Generous screen-space hit radius (px) used when picking/hovering a wire
// segment for editing. Kept larger than the visible stroke width on purpose —
// users should be able to grab a thin wire without pixel-perfect aim.
const WIRE_HIT_PX = 10;
// Radius (screen px) within which a real pin takes priority over tapping
// into a passing wire while drawing a new wire — deliberately a bit wider
// than WIRE_HIT_PX so a click/release aimed at a nearby pin, but not landed
// perfectly on it, doesn't get hijacked into an unwanted wire-to-wire tap.
const PIN_SNAP_PX = 16;

const GateLibrary = {
  // AND/OR/NAND/NOR evaluate already operate over the whole input array via
  // .every()/.some(), so they work unchanged for any input count N >= 2.
  AND:   { category:'gate', label:'AND',   w:90, h:60, inputs:[{id:'a',dy:0.28},{id:'b',dy:0.72}], outputs:[{id:'out',dy:0.5}],
           evaluate:(i)=>[ i.some(v=>v===null) && !i.every(v=>v===0) ? null : (i.every(v=>v===1) ? 1 : 0) ] },
  OR:    { category:'gate', label:'OR',    w:90, h:60, inputs:[{id:'a',dy:0.28},{id:'b',dy:0.72}], outputs:[{id:'out',dy:0.5}],
           evaluate:(i)=>[ i.some(v=>v===1) ? 1 : (i.some(v=>v===null) ? null : 0) ] },
  NOT:   { category:'gate', label:'NOT',   labelHTML:'<span class="lbl-overbar">NOT</span>', w:80, h:50, inputs:[{id:'a',dy:0.5}], outputs:[{id:'out',dy:0.5}],
           evaluate:(i)=>[ i[0]===null ? null : (i[0]===1 ? 0 : 1) ] },
  NAND:  { category:'gate', label:'NAND',  labelHTML:'<span class="lbl-overbar">NAND</span>', w:90, h:60, inputs:[{id:'a',dy:0.28},{id:'b',dy:0.72}], outputs:[{id:'out',dy:0.5}],
           evaluate:(i)=>{ const a=GateLibrary.AND.evaluate(i)[0]; return [ a===null ? null : (a===1?0:1) ]; } },
  NOR:   { category:'gate', label:'NOR',   labelHTML:'<span class="lbl-overbar">NOR</span>', w:90, h:60, inputs:[{id:'a',dy:0.28},{id:'b',dy:0.72}], outputs:[{id:'out',dy:0.5}],
           evaluate:(i)=>{ const o=GateLibrary.OR.evaluate(i)[0]; return [ o===null ? null : (o===1?0:1) ]; } },
  // N-input XOR generalizes to odd-parity: output is 1 iff an odd number of
  // inputs are 1 (this reduces to the familiar i[0]!==i[1] for exactly 2).
  XOR:   { category:'gate', label:'XOR',   w:90, h:60, inputs:[{id:'a',dy:0.28},{id:'b',dy:0.72}], outputs:[{id:'out',dy:0.5}],
           evaluate:(i)=>{
             if(i.some(v=>v===null)) return [null];
             const ones = i.reduce((n,v)=> n + (v===1?1:0), 0);
             return [ ones % 2 === 1 ? 1 : 0 ];
           } },
  XNOR:  { category:'gate', label:'XNOR',  labelHTML:'<span class="lbl-overbar">XNOR</span>', w:90, h:60, inputs:[{id:'a',dy:0.28},{id:'b',dy:0.72}], outputs:[{id:'out',dy:0.5}],
           evaluate:(i)=>{ const x=GateLibrary.XOR.evaluate(i)[0]; return [ x===null ? null : (x===1?0:1) ]; } },
  BUFFER:{ category:'gate', label:'BUF',   w:80, h:50, inputs:[{id:'a',dy:0.5}], outputs:[{id:'out',dy:0.5}],
           evaluate:(i)=>[ i[0] ] },

  SWITCH:  { category:'input', label:'',  w:76, h:46, inputs:[], outputs:[{id:'out',dy:0.5}],
             evaluate:(_i, state)=>[ state.value === null ? null : (state.value ? 1 : 0) ], initState:()=>({value:false}) },
  HIGH:    { category:'input', label:'1',   w:50, h:40, inputs:[], outputs:[{id:'out',dy:0.5}],
             evaluate:()=>[1] },
  LOW:     { category:'input', label:'0',   w:50, h:40, inputs:[], outputs:[{id:'out',dy:0.5}],
             evaluate:()=>[0] },
  VARIABLE:{ category:'input', label:'VAR', w:54, h:44, inputs:[], outputs:[{id:'out',dy:0.5}],
             evaluate:(_i, state)=>[ state.value === null ? null : (state.value ? 1 : 0) ], initState:()=>({value:false}) },

  LED:   { category:'output', label:'LED', w:50, h:50, inputs:[{id:'a',dy:0.5}], outputs:[],
           evaluate:(i)=>[] },
  PROBE: { category:'output', label:'PRB', w:60, h:40, inputs:[{id:'a',dy:0.5}], outputs:[],
           evaluate:(i)=>[] },
  // Seven-segment display: 7 independent segment inputs (a-g, standard
  // segment naming), each directly driving one lit/unlit segment. No
  // outputs — pure display sink, same pattern as LED/PROBE above.
  SEVENSEG: { category:'output', label:'7-SEG', w:64, h:128, inputs:[
                {id:'a',dy:0.10},{id:'b',dy:0.2333},{id:'c',dy:0.3667},{id:'d',dy:0.5},
                {id:'e',dy:0.6333},{id:'f',dy:0.7667},{id:'g',dy:0.90}
              ], outputs:[],
              initState:()=>({ segColor:'red' }),
              evaluate:(i)=>[] },

  // =======================================================================
  // Combinational MSI-style ICs (MUX / DEMUX / DECODER / ENCODER /
  // PRIORITY ENCODER). Plain data-driven
  // GateLibrary entries with no custom rendering — category 'ic' (not
  // 'gate' or 'output') so they fall through to the generic rounded-box
  // body + centered def.label text in ComponentView.create() and both
  // export paths (CanvasExport's box branch, SVG export's genericBox
  // branch), and are skipped by the 'gate'-only UI (Gate Type switcher,
  // Universal Converter, N-input expansion) and 'output'-only checks.
  // All inputs sit on the left edge, all outputs on the right edge —
  // this simulator has no bottom/top pin placement, so select/enable
  // lines are just additional left-edge pins, stacked evenly with
  // dy = k/(n+1), the same even-spacing formula used elsewhere in this file.
  // Every evaluate() follows the established null-propagation convention:
  // any floating/undefined control line makes the affected outputs null.
  // =======================================================================

  // 4-to-1 Multiplexer: 4 data lines + 2 select lines choose one data
  // line to route straight through to the single output Y.
  MUX: { category:'ic', label:'Multiplexer', w:100, h:150,
         desc:'Routes exactly one of 4 data lines (D0–D3) through to output Y, chosen by the 2-bit select code S1:S0. Built from 2 inverters and 4 three-input AND gates (one per data line, enabled only for its matching select code) feeding a 4-input OR gate.',
         inputs:[{id:'d0',dy:1/7},{id:'d1',dy:2/7},{id:'d2',dy:3/7},{id:'d3',dy:4/7},
                  {id:'s0',dy:5/7},{id:'s1',dy:6/7}],
         outputs:[{id:'y',dy:0.5}],
         evaluate:(i)=>{
           const [d0,d1,d2,d3,s0,s1] = i;
           if(s0===null || s1===null) return [null];
           const sel = (s1<<1)|s0;
           return [ [d0,d1,d2,d3][sel] ];
         } },

  // 1-to-4 Demultiplexer: routes the single data input D to exactly one
  // of 4 outputs (chosen by the 2 select lines); all other outputs are
  // held low.
  DEMUX: { category:'ic', label:'Demultiplexer', w:112, h:100,
           desc:'Routes the single data input D to exactly one of 4 outputs (Y0–Y3), chosen by the 2-bit select code S1:S0; every other output stays low. Built from 2 inverters and 4 three-input AND gates, one per output line.',
           inputs:[{id:'d',dy:0.25},{id:'s0',dy:0.5},{id:'s1',dy:0.75}],
           outputs:[{id:'y0',dy:0.2},{id:'y1',dy:0.4},{id:'y2',dy:0.6},{id:'y3',dy:0.8}],
           evaluate:(i)=>{
             const [d,s0,s1] = i;
             if(s0===null || s1===null) return [null,null,null,null];
             const sel = (s1<<1)|s0;
             const out = [0,0,0,0];
             out[sel] = d;
             return out;
           } },

  // 2-to-4 Line Decoder with active-high Enable: when EN is high, drives
  // exactly one of 4 outputs high (selected by A1:A0), all others low;
  // when EN is low, every output is held low regardless of A0/A1.
  DECODER: { category:'ic', label:'Decoder', w:88, h:100,
             desc:'Drives exactly one of 4 outputs (Y0–Y3) high, chosen by the 2-bit address A1:A0 — but only while Enable is high; when EN is low every output stays low. Built from 2 inverters and 4 three-input AND gates, one per output line.',
             inputs:[{id:'a0',dy:0.25},{id:'a1',dy:0.5},{id:'en',dy:0.75}],
             outputs:[{id:'y0',dy:0.2},{id:'y1',dy:0.4},{id:'y2',dy:0.6},{id:'y3',dy:0.8}],
             evaluate:(i)=>{
               const [a0,a1,en] = i;
               if(en===null) return [null,null,null,null];
               if(en===0) return [0,0,0,0];
               if(a0===null || a1===null) return [null,null,null,null];
               const sel = (a1<<1)|a0;
               const out = [0,0,0,0];
               out[sel] = 1;
               return out;
             } },

  // 4-to-2 Encoder: assumes at most one of D0–D3 is asserted at a time and
  // outputs its binary index on A1:A0. If zero or more than one input is
  // asserted at once (an invalid/ambiguous input for a plain encoder),
  // outputs default low — use PRIORITYENC below when that case needs to
  // resolve to a sensible answer instead.
  ENCODER: { category:'ic', label:'Encoder', w:88, h:100,
             desc:'Assumes exactly one of D0–D3 is asserted at a time and outputs its binary index on A1:A0 (e.g. D2 high → A1A0=10). Built from just 2 OR gates: A1 = D2 OR D3, A0 = D1 OR D3. If zero or more than one input is asserted, the real outputs default low, which this simplified 2-gate view does not model — see Priority Encoder for a version that resolves that case.',
             inputs:[{id:'d0',dy:0.2},{id:'d1',dy:0.4},{id:'d2',dy:0.6},{id:'d3',dy:0.8}],
             outputs:[{id:'a1',dy:1/3},{id:'a0',dy:2/3}],
             evaluate:(i)=>{
               if(i.some(v=>v===null)) return [null,null];
               const idx = i.reduce((acc,v,k)=> v===1 ? [...acc,k] : acc, []);
               if(idx.length !== 1) return [0,0];
               const k = idx[0];
               return [ (k>>1)&1, k&1 ];
             } },

  // 4-to-2 Priority Encoder: like ENCODER, but resolves multiple
  // simultaneously-asserted inputs by always favoring the highest-index
  // line (D3 highest priority, D0 lowest). Adds a Valid output V that's
  // high whenever any input is asserted, so "nothing asserted" (A1=A0=0)
  // can be told apart from "D0 asserted" (also A1=A0=0).
  PRIORITYENC: { category:'ic', label:'Priority Encoder', w:104, h:106,
                 desc:'Like Encoder, but resolves multiple simultaneously-asserted inputs by always favoring the highest-index line (D3 highest, D0 lowest), and adds a Valid output V that\'s high whenever any input is asserted. Built from: A1 = D3 OR D2; A0 = D3 OR (NOT D2 AND D1); V = D0 OR D1 OR D2 OR D3.',
                 inputs:[{id:'d0',dy:0.2},{id:'d1',dy:0.4},{id:'d2',dy:0.6},{id:'d3',dy:0.8}],
                 outputs:[{id:'a1',dy:0.25},{id:'a0',dy:0.5},{id:'v',dy:0.75}],
                 evaluate:(i)=>{
                   const [d0,d1,d2,d3] = i;
                   if(i.some(v=>v===null)) return [null,null,null];
                   if(d3===1) return [1,1,1];
                   if(d2===1) return [1,0,1];
                   if(d1===1) return [0,1,1];
                   if(d0===1) return [0,0,1];
                   return [0,0,0];
                 } },

  // NODE (junction): a single connection point. One input pin and one
  // output pin sit at the left/right edges of a tiny square footprint
  // (rendered as one dot, with the actual pin hit-targets made invisible) —
  // any number of wires can be dragged from the output (output pins already
  // support unlimited fan-out), and it can receive one incoming wire too.
  NODE: { category:'wiring', label:'', w:14, h:14,
          inputs:[{id:'in',dy:0.5}],
          outputs:[{id:'a',dy:0.5}],
          evaluate:(i)=>[ i[0] ] },

  // TEXT (annotation): a free-floating text label — no pins, no logic,
  // purely decorative. Placed like any other element (choose a spot on the
  // canvas), then double-click to edit its content in place. Its box
  // auto-sizes to fit the current text + font size (see CircuitComponent's
  // `def` getter, same pattern used for VARIABLE's auto-widening body) —
  // "choosing the size" is done via the font-size control in the
  // Properties panel rather than dragging a resize handle.
  TEXT: { category:'annotation', label:'Text', w:120, h:36,
          inputs:[], outputs:[],
          initState:()=>({ text:'Text', fontSize:18 }),
          evaluate:()=>[] },
};

// =========================================================================
// 2a-1. KIT INTERNAL SCHEMATICS ("Full Circuit" view for MSI-style ICs)
// -------------------------------------------------------------------------
// Each entry is a small logical netlist (NOT a re-implementation of
// evaluate() — purely descriptive/visual) expressing the IC's behavior as
// discrete AND/OR/NOT gates, referencing either an external input pin id
// (string matching def.inputs[].id) or a previous gate's own id as inputs.
// `outputs` maps each external output pin id to the gate id that drives it
// (or, if it's just a renamed input, directly to that input's id).
// A generic layered layout (see _buildKitLayout below) turns this into
// on-screen boxes + orthogonal wires with zero manual coordinate work —
// so adding a new kit's schematic later is just a few lines here.
// =========================================================================
// Shared inset (px, in the component's own local coordinate space) used both
// by _buildKitLayout below (where the x-ray schematic's own wiring ends) and
// by CircuitComponent.pinWorldPos (where the *real* connection pin sits, in
// Full Circuit view) so the two always land in exactly the same spot —
// the actual clickable/wireable pin, comfortably inside the board's border
// instead of straddling it.
const KIT_PIN_INSET = 42;

const KIT_NETLISTS = {
  MUX: {
    gates: [
      { id:'n_s0', type:'NOT', inputs:['s0'] },
      { id:'n_s1', type:'NOT', inputs:['s1'] },
      { id:'a0',   type:'AND', inputs:['d0','n_s0','n_s1'] },
      { id:'a1',   type:'AND', inputs:['d1','s0','n_s1'] },
      { id:'a2',   type:'AND', inputs:['d2','n_s0','s1'] },
      { id:'a3',   type:'AND', inputs:['d3','s0','s1'] },
      { id:'or_y', type:'OR',  inputs:['a0','a1','a2','a3'] },
    ],
    outputs: { y:'or_y' },
  },
  DEMUX: {
    gates: [
      { id:'n_s0', type:'NOT', inputs:['s0'] },
      { id:'n_s1', type:'NOT', inputs:['s1'] },
      { id:'y0',   type:'AND', inputs:['d','n_s0','n_s1'] },
      { id:'y1',   type:'AND', inputs:['d','s0','n_s1'] },
      { id:'y2',   type:'AND', inputs:['d','n_s0','s1'] },
      { id:'y3',   type:'AND', inputs:['d','s0','s1'] },
    ],
    outputs: { y0:'y0', y1:'y1', y2:'y2', y3:'y3' },
  },
  DECODER: {
    gates: [
      { id:'n_a0', type:'NOT', inputs:['a0'] },
      { id:'n_a1', type:'NOT', inputs:['a1'] },
      { id:'y0',   type:'AND', inputs:['en','n_a0','n_a1'] },
      { id:'y1',   type:'AND', inputs:['en','a0','n_a1'] },
      { id:'y2',   type:'AND', inputs:['en','n_a0','a1'] },
      { id:'y3',   type:'AND', inputs:['en','a0','a1'] },
    ],
    outputs: { y0:'y0', y1:'y1', y2:'y2', y3:'y3' },
  },
  ENCODER: {
    gates: [
      { id:'or_a1', type:'OR', inputs:['d2','d3'] },
      { id:'or_a0', type:'OR', inputs:['d1','d3'] },
    ],
    outputs: { a1:'or_a1', a0:'or_a0' },
  },
  PRIORITYENC: {
    gates: [
      { id:'or_a1', type:'OR',  inputs:['d3','d2'] },
      { id:'n_d2',  type:'NOT', inputs:['d2'] },
      { id:'and_t', type:'AND', inputs:['n_d2','d1'] },
      { id:'or_a0', type:'OR',  inputs:['d3','and_t'] },
      { id:'or_v',  type:'OR',  inputs:['d0','d1','d2','d3'] },
    ],
    outputs: { a1:'or_a1', a0:'or_a0', v:'or_v' },
  },
};

/** Turns a KIT_NETLISTS entry into on-screen geometry: gate boxes + input/
 *  output stub points + orthogonal wire paths. Pure function of (type,def)
 *  so its result is cached per type (kit types are never input-expandable,
 *  so this never needs to vary per instance).
 *
 *  Layout follows standard schematic-review conventions (grid-aligned rows/
 *  cols, functional layers left→right, no more than a handful of gates
 *  stacked in one strip): any dependency-depth "layer" that would otherwise
 *  stack too many gates in a single tall column gets wrapped into
 *  side-by-side sub-columns instead — keeps dense nets a sane, roughly-
 *  square shape instead of one towering strip of boxes. */
function _buildKitLayout(type, def){
  const net = KIT_NETLISTS[type];
  if(!net) return null;
  const GW = 32, GH = 22;         // gate box size (kept compact — labels use kg-glabel's opaque halo to stay legible at this size)
  const COL_GAP = 38, SUBCOL_GAP = 16, ROW_GAP = 12, MARGIN_X = 36, MARGIN_Y = 16;
  const MAX_ROWS_PER_LAYER = 6;    // wrap a layer into extra sub-columns beyond this many gates
  const PIN_PAD = KIT_PIN_INSET;  // inset of external I/O connection points from the board's raw edge — matches the real, wireable pin's position (see CircuitComponent.pinWorldPos) so the schematic's own wires end exactly where the real pin sits
  // 1) Depth (layer) of every gate = 1 + max depth of its gate-inputs (0 for pure external-input gates)
  const depthCache = {};
  const depthOf = (id) => {
    if(depthCache[id] !== undefined) return depthCache[id];
    const g = net.gates.find(g=>g.id===id);
    if(!g) return 0; // external input pin
    const d = 1 + Math.max(0, ...g.inputs.map(depthOf));
    depthCache[id] = d;
    return d;
  };
  net.gates.forEach(g=>depthOf(g.id));
  const maxDepth = Math.max(1, ...net.gates.map(g=>depthCache[g.id]));
  // 2) Group into layers, ordered top-to-bottom by the average external-pin
  //    dy of everything that ultimately feeds them (keeps wiring tidy).
  const inputDy = {}; def.inputs.forEach(p=> inputDy[p.id] = p.dy);
  const barycenter = {};
  const baryOf = (id) => {
    if(barycenter[id] !== undefined) return barycenter[id];
    if(inputDy[id] !== undefined){ barycenter[id]=inputDy[id]; return inputDy[id]; }
    const g = net.gates.find(g=>g.id===id);
    const v = g ? g.inputs.reduce((s,i)=>s+baryOf(i),0)/g.inputs.length : 0.5;
    barycenter[id] = v;
    return v;
  };
  net.gates.forEach(g=>baryOf(g.id));
  const layers = [];
  for(let d=1; d<=maxDepth; d++){
    layers.push(net.gates.filter(g=>depthCache[g.id]===d).sort((a,b)=>baryOf(a.id)-baryOf(b.id)));
  }
  // 2b) Split any over-tall layer into multiple sub-columns of at most
  //     MAX_ROWS_PER_LAYER gates each, filled top-to-bottom then wrapping —
  //     so e.g. 28 AND gates in one layer become ~5 sub-columns of ~6 rather
  //     than a single 28-row tower.
  const layerSlots = layers.map(layer=>{
    const subCount = Math.max(1, Math.ceil(layer.length / MAX_ROWS_PER_LAYER));
    const rowsPerSub = Math.ceil(layer.length / subCount);
    const subs = [];
    for(let s=0; s<subCount; s++) subs.push(layer.slice(s*rowsPerSub, (s+1)*rowsPerSub));
    return subs; // array of sub-columns, each an array of gates
  });
  const TITLE_H = 24; // reserved band at top for the board-style title text (see _kitInternalSVG)
  const maxRowsAnySlot = Math.max(1, ...layerSlots.flat().map(sub=>sub.length));
  const bodyH = Math.max(def.h - TITLE_H, MARGIN_Y*2 + maxRowsAnySlot*(GH+ROW_GAP) - ROW_GAP);
  const H = TITLE_H + bodyH;
  // 3) Assign coordinates, walking layers left→right and packing each
  //    layer's sub-columns tightly side by side.
  const gatePos = {};
  let cursorX = MARGIN_X;
  layerSlots.forEach(subs=>{
    subs.forEach(sub=>{
      const totalH = sub.length*(GH+ROW_GAP) - ROW_GAP;
      const startY = TITLE_H + (bodyH-totalH)/2;
      sub.forEach((g,ri)=>{
        const y = startY + ri*(GH+ROW_GAP);
        gatePos[g.id] = {x:cursorX, y, w:GW, h:GH, label:g.type, n:g.inputs.length,
          inputs:g.inputs, out:{x:cursorX+GW, y:y+GH/2}};
      });
      cursorX += GW + SUBCOL_GAP;
    });
    cursorX += COL_GAP - SUBCOL_GAP;
  });
  const W = cursorX - SUBCOL_GAP + 66; // +66 reserves room for the output stub run plus its port-id label
  const extInPins = {};
  const portPoint = (id) => {
    if(gatePos[id]) return gatePos[id].out;
    const pt = { x:PIN_PAD, y:(inputDy[id]!==undefined?inputDy[id]:0.5)*H };
    extInPins[id] = pt;
    return pt;
  };
  // 4) Wires: for every gate, from each named source to that gate's k-th input point
  const wires = [];
  net.gates.forEach(g=>{
    const p = gatePos[g.id];
    g.inputs.forEach((srcId,k)=>{
      const from = portPoint(srcId);
      const to = { x:p.x, y:p.y + (k+1)*p.h/(g.inputs.length+1) };
      wires.push([from,to]);
    });
  });
  // 5) Output stubs: external output pin -> its driving gate (or straight through if it's a passthrough)
  const outStubs = def.outputs.map(o=>{
    const driverId = net.outputs[o.id];
    const from = portPoint(driverId);
    const to = { x:W-PIN_PAD, y:o.dy*H };
    wires.push([from,to]);
    return to;
  });
  // 6) Explicit, ID-tagged port lists (built straight from def.inputs/
  //    def.outputs rather than the usage-order extInPins/outStubs above) so
  //    the x-ray SVG can print each pin's real name next to its dot —
  //    inputs stay pinned to the left edge, outputs to the right edge,
  //    exactly where their dots already sit.
  const inputPins = def.inputs.map(p=>({ id:p.id, x:PIN_PAD, y:p.dy*H }));
  const outputPins = def.outputs.map((o,i)=>({ id:o.id, x:outStubs[i].x, y:outStubs[i].y }));
  const extPins = [...inputPins, ...outputPins];
  // 7) Fan-out junction points: any source point (gate output or external
  //    input) feeding two or more destinations gets a solid dot marking the
  //    real electrical tie — standard schematic convention (a dot means
  //    "connected", no dot means "just passing"), so a shared internal
  //    signal split several ways reads unambiguously instead of looking
  //    like coincidentally-touching wires.
  const fanoutCount = {};
  wires.forEach(([from])=>{
    const key = `${from.x},${from.y}`;
    fanoutCount[key] = (fanoutCount[key]||0) + 1;
  });
  const junctions = Object.keys(fanoutCount)
    .filter(k=>fanoutCount[k] > 1)
    .map(k=>{ const [x,y] = k.split(',').map(Number); return {x,y}; });
  return { W, H, titleH:TITLE_H, gates: Object.keys(gatePos).map(id=>Object.assign({id},gatePos[id])), wires, extPins, inputPins, outputPins, junctions };
}

/** Orthogonal (Manhattan) wire path between two points, matching the app's
 *  own grid-wire aesthetic: a straight lead out of the source, a vertical
 *  run, then a straight lead into the destination. Corners are gently
 *  rounded rather than sharp right angles (echoing canvas-renderer.js's own
 *  rounded-corner wire drawing), and any genuine crossing of another wire's
 *  horizontal lead along the vertical run (passed in via hopYs, from
 *  _findWireCrossings) gets a small semicircular hop — the same "over-wire
 *  arches" convention already used on the live canvas — so a real crossing
 *  never looks like it might be a connection. */
function _orthoPath(a, b, hopYs, xOffset){
  const midX = a.x + (b.x-a.x)/2 + (xOffset||0);
  const r = Math.min(10, Math.abs(b.y-a.y)/2, Math.abs(midX-a.x)/2, Math.abs(b.x-midX)/2);
  const HOP_R = 4.5;
  if(r < 1.5 || a.y === b.y){
    return `M ${a.x} ${a.y} L ${midX} ${a.y} L ${midX} ${b.y} L ${b.x} ${b.y}`;
  }
  const dy = b.y > a.y ? 1 : -1;
  const dx2 = b.x > midX ? 1 : -1;
  const vy0 = a.y + r*dy, vy1 = b.y - r*dy;
  let vertical = '';
  const sortedHops = (hopYs||[]).filter(y=> (dy>0 ? (y>vy0 && y<vy1) : (y<vy0 && y>vy1)))
    .sort((p,q)=> dy>0 ? p-q : q-p);
  let cursorY = vy0;
  sortedHops.forEach(hy=>{
    vertical += `L ${midX} ${hy - HOP_R*dy} `;
    // Small semicircular arch bulging to the right, over the crossing wire
    vertical += `A ${HOP_R} ${HOP_R} 0 0 ${dy>0?1:0} ${midX} ${hy + HOP_R*dy} `;
  });
  vertical += `L ${midX} ${vy1} `;
  return `M ${a.x} ${a.y} `
       + `L ${midX - r} ${a.y} `
       + `Q ${midX} ${a.y} ${midX} ${vy0} `
       + vertical
       + `Q ${midX} ${b.y} ${midX + r*dx2} ${b.y} `
       + `L ${b.x} ${b.y}`;
}

/** Detects genuine crossings (not real connections) between this kit's own
 *  wires — a point where one wire's vertical run passes strictly through
 *  another wire's horizontal lead — and returns, per wire index, the list
 *  of y-values along its vertical run where a hop notch is needed. Two
 *  wires sharing an actual endpoint are never flagged as a crossing — real
 *  ties are covered separately by the junction dots from _buildKitLayout. */
function _findWireCrossings(wires){
  const segsOf = (path,i)=>{
    const [a,b] = path;
    const midX = a.x + (b.x-a.x)/2;
    return [
      { x1:a.x, y1:a.y, x2:midX, y2:a.y, orient:'h', wire:i },
      { x1:midX, y1:a.y, x2:midX, y2:b.y, orient:'v', wire:i },
      { x1:midX, y1:b.y, x2:b.x, y2:b.y, orient:'h', wire:i },
    ];
  };
  const allSegs = wires.flatMap((w,i)=>segsOf(w,i));
  const hopsByWire = {}; // wireIndex -> [y, y, ...]
  for(const v of allSegs){
    if(v.orient !== 'v') continue;
    const vy0 = Math.min(v.y1,v.y2), vy1 = Math.max(v.y1,v.y2);
    for(const h of allSegs){
      if(h.orient !== 'h' || h.wire === v.wire) continue;
      const hx0 = Math.min(h.x1,h.x2), hx1 = Math.max(h.x1,h.x2);
      if(v.x1 > hx0+0.5 && v.x1 < hx1-0.5 && h.y1 > vy0+0.5 && h.y1 < vy1-0.5){
        (hopsByWire[v.wire] = hopsByWire[v.wire] || []).push(h.y1);
      }
    }
  }
  return hopsByWire;
}

/** Pulls one gate's real symbol geometry out of GateShapes (the same
 *  outline used by the regular gate palette) and renames its classes so it
 *  can be safely embedded, unstyled by the live-simulation gate CSS, inside
 *  the kit x-ray board (see _kitInternalSVG's own <style> block). */
function _kitGateInner(label){
  const raw = GateShapes[label];
  if(!raw) return '';
  return raw
    .replace(/^<svg[^>]*>/,'').replace(/<\/svg>\s*$/,'')
    .replace(/class="gate-outline"/g,'class="kg-outline"')
    .replace(/class="gate-bubble"/g,'class="kg-bubble"')
    .replace(/class="gate-leadline"/g,'class="kg-lead"');
}

/** Renders a cached inline-SVG "x-ray" schematic for one kit type, styled to
 *  match the app's own component look (the light white/navy board face
 *  comes from the .kit-internal-wrap CSS class that hosts this SVG) holding
 *  the real AND/OR/NOT gate symbols (same shapes as the regular gate
 *  palette, via _kitGateInner), wired together with plain orthogonal wires.
 *  Connection points are marked with small solid dots — no numbering — so
 *  the wiring reads the same way the live canvas's own wires and junctions
 *  do. Sized to exactly fill the enlarged component footprint used in
 *  'circuit' view mode. */
const _kitSvgCache = {};
function _kitInternalSVG(type, def){
  if(_kitSvgCache[type]) return _kitSvgCache[type];
  const L = _buildKitLayout(type, def);
  if(!L) return '';
  const kitLabel = (def.label || type).toUpperCase();
  // Gate bodies are drawn as their own layer, separate from pin dots/labels,
  // so wires can be sandwiched in between: body → wires → pins/labels. That
  // way a wire lead that runs across a gate's footprint reads as passing
  // OVER the gate face instead of vanishing underneath it, while the pin
  // dots and text stay legible on the very top layer regardless.
  const gateBodies = L.gates.map(g=>
    `<svg x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" viewBox="0 0 100 100" preserveAspectRatio="none">${_kitGateInner(g.label)}</svg>`
  ).join('');
  const gatePins = L.gates.map(g=>{
    const inDots = g.inputs.map((_,k)=>{
      const py = g.y + (k+1)*g.h/(g.inputs.length+1);
      return `<circle cx="${g.x}" cy="${py}" r="1.8" class="kg-pin"/><circle cx="${g.x}" cy="${py}" r="0.75" class="kg-pin-core"/>`;
    }).join('');
    // Label sits centered inside the gate's own body (not underneath it) —
    // nudged slightly left of true center since every gate outline (AND/
    // OR/NAND/…) has its output nub/bubble eating into the right side of
    // its 100x100 viewBox, so a dead-center label would look off-balance.
    // A larger opaque halo (paint-order stroke, see .kg-glabel) keeps the
    // label legible even where a wire lead passes directly behind it.
    const labelX = g.x + g.w*0.44;
    const labelY = g.y + g.h/2 + 3;
    return `${inDots}
      <circle cx="${g.out.x}" cy="${g.out.y}" r="1.8" class="kg-pin"/><circle cx="${g.out.x}" cy="${g.out.y}" r="0.75" class="kg-pin-core"/>
      <text x="${labelX}" y="${labelY}" text-anchor="middle" class="kg-glabel">${g.label}</text>`;
  }).join('');
  // Lane-spreading: wires that run between the same two layers (same
  // rounded mid-x) otherwise all stack their vertical run on one exact
  // line, which reads as a single thick wire and makes real crossings
  // ambiguous. Spread each such group across a few parallel lanes instead —
  // still orthogonal/grid-like, but each signal keeps its own visible path.
  const laneGroups = {};
  L.wires.forEach(([a,b],i)=>{
    const bucket = Math.round((a.x + (b.x-a.x)/2) / 4) * 4;
    (laneGroups[bucket] = laneGroups[bucket] || []).push(i);
  });
  const laneOffset = {};
  Object.values(laneGroups).forEach(idxs=>{
    const n = idxs.length;
    const spread = Math.min(7, 30/n);
    idxs.forEach((wi,k)=>{ laneOffset[wi] = (k - (n-1)/2) * spread; });
  });
  // Real crossings between two independent wires get a small hop on the
  // vertical run (see _findWireCrossings); genuine electrical ties — one
  // point feeding several destinations — get a solid junction dot instead,
  // so "connected" vs. "just passing" is never ambiguous.
  const hopsByWire = _findWireCrossings(L.wires);
  const wirePaths = L.wires.map(([a,b],i)=>
    `<path d="${_orthoPath(a,b,hopsByWire[i],laneOffset[i]||0)}" fill="none" class="kg-wire"/>`
  ).join('');
  const junctionDots = (L.junctions||[]).map(j=>
    `<circle cx="${j.x}" cy="${j.y}" r="3" class="kg-junction"/>`
  ).join('');
  // External pin dots/labels are intentionally NOT drawn here: the app
  // already renders a real, interactive, correctly-colored .pin element and
  // a .pin-io-label name for every port (see ComponentView.createNode) —
  // both are positioned to land exactly at this same PIN_PAD inset when a
  // kit is in Full Circuit view (see CircuitComponent.pinWorldPos and the
  // .kit-circuit-view CSS overrides). Drawing a second dot+label pair here
  // used to double up with those, producing overlapping/garbled text.
  const svg = `<svg viewBox="0 0 ${L.W} ${L.H}" preserveAspectRatio="none" width="100%" height="100%"
      style="position:absolute;inset:0;pointer-events:none;">
      <style>
        .kg-outline{ fill:#ffffff; stroke:var(--c-navy); stroke-width:1.8; }
        .kg-bubble{ fill:#ffffff; stroke:var(--c-navy); stroke-width:1.8; }
        .kg-lead{ stroke:var(--c-navy); stroke-width:1.8; fill:none; }
        .kg-wire{ stroke:var(--c-navy); stroke-width:1.0; stroke-linecap:round; stroke-linejoin:round; opacity:0.82; }
        /* Pins mirror the live .pin look (a solid ring with a light core)
           instead of a single flat dot, so the x-ray connections read the
           same way the real click-to-wire pins do on the main canvas. */
        .kg-pin{ fill:var(--c-navy); }
        .kg-pin-core{ fill:#ffffff; }
        /* Junction dots mark a real electrical tie where one signal fans
           out to several destinations — solid and slightly larger than a
           pin dot so it reads distinctly from a genuine crossing hop. */
        .kg-junction{ fill:var(--c-navy); }
        .kg-glabel{ font-size:6.5px; font-family:'Segoe UI',Arial,sans-serif; fill:var(--c-navy); font-weight:800; letter-spacing:0.15px; paint-order:stroke; stroke:#ffffff; stroke-width:2.4px; stroke-linejoin:round; }
        .kg-title{ font-size:9.5px; font-family:'Segoe UI',Arial,sans-serif; fill:var(--c-navy); font-weight:800; letter-spacing:0.6px; }
        .kg-title-rule{ stroke:var(--c-teal); stroke-width:1.4; }
      </style>
      <text x="${L.W/2}" y="${L.titleH-6}" text-anchor="middle" class="kg-title">${kitLabel}</text>
      <line x1="${L.W*0.28}" y1="${L.titleH-2}" x2="${L.W*0.72}" y2="${L.titleH-2}" class="kg-title-rule"/>
      ${gateBodies}${wirePaths}${junctionDots}${gatePins}
    </svg>`;
  _kitSvgCache[type] = svg;
  return svg;
}

// =========================================================================
// 2a-2. UNIVERSAL GATE CONVERTER
// -------------------------------------------------------------------------
// Builds the network of NAND-only (or NOR-only) gates that implements any
// single gate type from GateLibrary's 'gate' category, for any input count
// N. Returns an abstract graph — a flat list of synthetic 2-(or N-)input
// `target` gates plus a reference to whichever one carries the final
// output — that the App layer turns into real CircuitComponents/wires.
// Each synthetic gate's inputs are `ref`s of one of two shapes:
//   { ext: i }  -> the i-th external input of the gate being replaced
//   { node: j } -> the output of previously-built synthetic gate j
// Identities used (A, B are inputs; N-ary forms generalize the same way):
//   NOT(A)      = NAND(A,A)                    = NOR(A,A)
//   AND(A,B)    = NOT(NAND(A,B))                = NOR(NOT A, NOT B)
//   OR(A,B)     = NAND(NOT A, NOT B)            = NOT(NOR(A,B))
//   NAND(A,B)   = NOT(AND(A,B) via NOR)         [only needed when target=NOR]
//   NOR(A,B)    = NOT(OR(A,B) via NAND)         [only needed when target=NAND]
//   XOR(A,B)    = 4-NAND network directly; via NOR it's NOT(the 4-NOR XNOR network)
//   XNOR(A,B)   = NOT(XOR) either way
//   N-input XOR/XNOR cascade N-1 binary XOR stages (matches GateLibrary's
//   odd-parity semantics), since ARCLogic treats XNOR as simply NOT(XOR_N).
// =========================================================================
const UniversalConverter = {
  // Which gate types a given target can rebuild. NAND and NOR are each
  // truly universal alone. AND and OR aren't universal by themselves, but
  // {AND, NOT} and {OR, NOT} each are — so those two targets rebuild every
  // 'gate'-category type too, just using a real separate NOT gate wherever
  // an inversion is needed instead of self-NANDing/self-NORing.
  isEligible(gateType, target){
    return gateType!==target;
  },
  build(gateType, n, target){
    if(target==='AND' || target==='OR') return this._buildWithNot(gateType, n, target);
    if(target!=='NAND' && target!=='NOR') return null;
    const nodes = [];
    const extRef = i => ({ext:i});
    const nodeRef = j => ({node:j});
    const addNary = (type, refs) => { nodes.push({type, in:refs}); return nodeRef(nodes.length-1); };
    const addBin = (a,b) => addNary(target, [a,b]);
    const invert = (ref) => addBin(ref, ref); // NAND(x,x) or NOR(x,x) == NOT(x)
    const ext = [...Array(n)].map((_,i)=>extRef(i));

    // Shared 2-input XOR building block: 4 `target` gates produce XOR
    // directly when target is NAND, or XNOR directly when target is NOR
    // (one extra inversion away from the other), per the identities above.
    const buildXor2 = (a,b) => {
      const n1 = addBin(a,b);
      const n2 = addBin(a,n1);
      const n3 = addBin(b,n1);
      const n4 = addBin(n2,n3);
      return target==='NAND' ? n4 : invert(n4);
    };

    let outRef;
    switch(gateType){
      case target: // already made entirely of the target gate — pass through
        outRef = addNary(target, ext);
        break;
      case 'NOT': case 'BUFFER': {
        const inv1 = invert(ext[0]);
        outRef = (gateType==='NOT') ? inv1 : invert(inv1);
        break;
      }
      case 'AND': {
        outRef = (target==='NAND') ? invert(addNary(target, ext))
                                    : addNary(target, ext.map(invert));
        break;
      }
      case 'OR': {
        outRef = (target==='NAND') ? addNary(target, ext.map(invert))
                                    : invert(addNary(target, ext));
        break;
      }
      case 'NAND': { // only reached when target === 'NOR'
        outRef = invert(addNary(target, ext.map(invert))); // NOT(AND_N)
        break;
      }
      case 'NOR': { // only reached when target === 'NAND'
        outRef = invert(addNary(target, ext.map(invert))); // NOT(OR_N)
        break;
      }
      case 'XOR': {
        let acc = ext[0];
        for(let i=1;i<n;i++) acc = buildXor2(acc, ext[i]);
        outRef = acc;
        break;
      }
      case 'XNOR': {
        let acc = ext[0];
        for(let i=1;i<n;i++) acc = buildXor2(acc, ext[i]);
        outRef = invert(acc);
        break;
      }
      default:
        return null; // not a 'gate'-category type — nothing to convert
    }
    return { nodes, outRef };
  },
  /** Rebuilds a gate using the {AND, NOT} or {OR, NOT} basis (whichever
   *  the person picked as `target`) — unlike NAND/NOR, inversion here is a
   *  real standalone NOT gate rather than a self-fed AND/OR, since AND and
   *  OR each need NOT alongside them to be functionally complete at all.
   *  `andG`/`orG` build an n-ary AND or OR purely out of `target` gates and
   *  NOT gates via De Morgan's laws whenever `target` is the other one. */
  _buildWithNot(gateType, n, target){
    const nodes = [];
    const extRef = i => ({ext:i});
    const addNary = (type, refs) => { nodes.push({type, in:refs}); return {node: nodes.length-1}; };
    const notG = ref => addNary('NOT', [ref]);
    const prim = refs => addNary(target, refs);
    const andG = refs => target==='AND' ? prim(refs) : notG(prim(refs.map(notG)));
    const orG  = refs => target==='OR'  ? prim(refs) : notG(prim(refs.map(notG)));
    const ext = [...Array(n)].map((_,i)=>extRef(i));

    const xor2 = (a,b) => orG([ andG([a, notG(b)]), andG([notG(a), b]) ]);

    let outRef;
    switch(gateType){
      case target: outRef = prim(ext); break; // already this basis's own gate
      case 'NOT': outRef = notG(ext[0]); break;
      case 'BUFFER': outRef = notG(notG(ext[0])); break;
      case 'AND': outRef = andG(ext); break;
      case 'OR': outRef = orG(ext); break;
      case 'NAND': outRef = notG(andG(ext)); break;
      case 'NOR': outRef = notG(orG(ext)); break;
      case 'XOR': {
        let acc = ext[0];
        for(let i=1;i<n;i++) acc = xor2(acc, ext[i]);
        outRef = acc;
        break;
      }
      case 'XNOR': {
        let acc = ext[0];
        for(let i=1;i<n;i++) acc = xor2(acc, ext[i]);
        outRef = notG(acc);
        break;
      }
      default:
        return null;
    }
    return { nodes, outRef };
  }
};

