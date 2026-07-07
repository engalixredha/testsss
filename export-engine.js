// =========================================================================
// 2c. EXPORT ENGINE
// -------------------------------------------------------------------------
// Renders the current circuit to PNG, JPG, SVG, or PDF.
//
// FIX NOTES (v3.7):
//   1. PNG/JPG gate shapes: SVG blob URLs can taint the canvas in some
//      browsers, making toBlob() return a black image.  We now encode each
//      SVG as a base64 data URI ("data:image/svg+xml;base64,…") so the
//      image is same-origin with the page and the canvas is never tainted.
//   2. PDF black screen: the old code mixed raw binary bytes (from atob())
//      into a JS string then stuffed it into a Blob.  Concatenating binary
//      data as a JS string corrupts multi-byte characters.  We now build
//      the PDF as a Uint8Array so every byte is preserved exactly.
//   3. Export Preview modal: a live canvas preview lets the user toggle
//      labels, pin-state dots, grid, wire colours, and switch display mode
//      before downloading in any format.
// =========================================================================

// Shared 7-segment display data, used by both SEVENSEG and BCDSEG so the
// canvas/PDF/JPG export pipeline renders the exact same hexagonal segment
// shapes (viewBox 0 0 32 56) as the live DOM/SVG view (see ComponentView's
// .sevenseg-svg / .bcdseg-display markup).
const SEVENSEG_POLYGONS = {
  a: [[8,2],[24,2],[27,5],[24,8],[8,8],[5,5]],
  f: [[3,7],[6,10],[6,25],[3,28],[0,25],[0,10]],
  b: [[29,7],[32,10],[32,25],[29,28],[26,25],[26,10]],
  g: [[8,27],[24,27],[27,30],[24,33],[8,33],[5,30]],
  e: [[3,29],[6,32],[6,47],[3,50],[0,47],[0,32]],
  c: [[29,29],[32,32],[32,47],[29,50],[26,47],[26,32]],
  d: [[8,49],[24,49],[27,52],[24,55],[8,55],[5,52]],
};
const SEGCOLOR_MAP = {
  green:  { lit:'#00ff6a', unlit:'#d4ead9' },
  red:    { lit:'#ff2020', unlit:'#ead4d4' },
  blue:   { lit:'#3a8fff', unlit:'#d4dcea' },
  yellow: { lit:'#ffe600', unlit:'#eae9d4' },
  orange: { lit:'#ff8c00', unlit:'#eaddd4' },
  white:  { lit:'#ffffff', unlit:'#e8eaed' },
};
/**
 * Draw the 7-segment face onto a canvas 2d context.
 * left,top = position (in the current transformed space) of the viewBox's
 * (0,0) corner; scale = px-per-viewBox-unit; vals = [a,b,c,d,e,f,g] (1/0/null);
 * col = {lit, unlit} hex colors (from SEGCOLOR_MAP).
 */
function drawSevenSegFace(ctx, left, top, scale, vals, col){
  const order = ['a','b','c','d','e','f','g'];
  ctx.save();
  ctx.translate(left, top);
  ctx.scale(scale, scale);
  order.forEach((seg, idx)=>{
    const pts = SEVENSEG_POLYGONS[seg];
    ctx.beginPath();
    pts.forEach(([x,y], i)=>{ if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.closePath();
    ctx.fillStyle = vals[idx]===1 ? col.lit : col.unlit;
    ctx.fill();
  });
  ctx.restore();
}
/** Same as drawSevenSegFace but returns an SVG markup string of <polygon> elements. */
function sevenSegFaceSVG(vals, col){
  const order = ['a','b','c','d','e','f','g'];
  return order.map((seg, idx)=>{
    const pts = SEVENSEG_POLYGONS[seg].map(p=>p.join(',')).join(' ');
    const fill = vals[idx]===1 ? col.lit : col.unlit;
    return `<polygon points="${pts}" fill="${fill}"/>`;
  }).join('');
}

// =========================================================================
const ExportEngine = {
  PADDING: 48,
  BG_WHITE: '#ffffff',

  /** Returns {minX,minY,maxX,maxY} world-space bounding box of all components. */
  _bounds(model){
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const c of model.components.values()){
      const s=c.renderedSize();
      minX=Math.min(minX,c.x); minY=Math.min(minY,c.y);
      maxX=Math.max(maxX,c.x+s.w); maxY=Math.max(maxY,c.y+s.h);
    }
    if(!isFinite(minX)){ minX=0;minY=0;maxX=400;maxY=300; }
    return {minX,minY,maxX,maxY};
  },

  _wireColor(v, colorize){ return colorize ? (v===1?'#1fae5c':'#e0364a') : '#0f2a4a'; },

  _pinColor(v, colorize){ return colorize ? (v===1?'#1fae5c':'#e0364a') : '#0f2a4a'; },

  /** World-space stub entry/exit point for a pin (mirrors WireRouter._pinStubPoint). */
  _pinStubPos(c, pinDef, side){
    const pinPos = this._pinPos(c, pinDef, side);
    const rad = ((c.rotation%360)+360)%360 * Math.PI / 180;
    const dx = Math.cos(rad), dy = Math.sin(rad);
    const sign = side === 'out' ? 1 : -1;
    const STUB = 16; // must match WireRouter.STUB_LENGTH
    return {
      x: pinPos.x + sign * dx * STUB,
      y: pinPos.y + sign * dy * STUB,
    };
  },

  _drawWire(ctx, x1,y1,x2,y2,color){
    const mx=(x1+x2)/2;
    ctx.beginPath();
    ctx.strokeStyle=color; ctx.lineWidth=this.wireWidth;
    ctx.lineCap='round'; ctx.lineJoin='round'; ctx.setLineDash([]);
    ctx.moveTo(x1,y1);
    if(Math.abs(y1-y2)<1){
      ctx.lineTo(x2,y2);
    } else if(Math.abs(x1-x2)<1){
      ctx.lineTo(x2,y2);
    } else {
      ctx.lineTo(mx,y1);
      ctx.lineTo(mx,y2);
      ctx.lineTo(x2,y2);
    }
    ctx.stroke();
  },

  _pinPos(c,pinDef,side){
    // NODE: both pins sit at the exact center (see pinWorldPos for why).
    const localX=c.type==='NODE' ? c.w/2 : (side==='in'?0:c.w);
    const localY=pinDef.dy*c.h;
    const cx=c.w/2,cy=c.h/2,dx=localX-cx,dy=localY-cy;
    let rx,ry;
    const r=(((c.rotation%360)+360)%360);
    switch(r){
      case 90:  rx=-dy;ry=dx;  break;
      case 180: rx=-dx;ry=-dy; break;
      case 270: rx=dy; ry=-dx; break;
      default:  rx=dx; ry=dy;  break;
    }
    return {x:c.x+cx+rx,y:c.y+cy+ry};
  },

  /**
   * Encode an SVG string as a base64 data URI.
   * Only used for the SVG file export (not canvas rendering).
   */
  _svgToDataURI(svgStr){
    const encoded = btoa(unescape(encodeURIComponent(svgStr)));
    return 'data:image/svg+xml;base64,' + encoded;
  },

  /**
   * Draw a gate shape directly onto a canvas 2d context using Path2D.
   * This completely avoids the SVG→Image pipeline which is fragile across
   * browsers (CORS taint, zero-size images, async timing, preserveAspectRatio).
   * All shapes are drawn in a normalised 100×100 space then scaled to the
   * component's actual pixel dimensions via ctx.transform.
   */
  _drawGateShape(ctx, c, cx, cy){
    // cx/cy = top-left corner of the component in canvas space
    const scaleX = c.w / 100;
    const scaleY = c.h / 100;

    ctx.save();
    // Translate to component center, rotate, scale to component dimensions,
    // then shift back so paths drawn in 0..100 space land at the right place.
    ctx.translate(cx + c.w/2, cy + c.h/2);
    ctx.rotate(c.rotation * Math.PI / 180);
    if(c._flipX) ctx.scale(-1, 1);
    if(c._flipY) ctx.scale(1, -1);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-50, -50);

    ctx.strokeStyle = '#0f2a4a';
    ctx.lineWidth   = 2.5 / Math.max(scaleX, scaleY); // keep stroke width in screen px
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.fillStyle   = '#ffffff';

    const t = c.type;

    if(t==='AND'){
      // Flat back + D-shaped front
      ctx.beginPath();
      ctx.moveTo(8,6); ctx.lineTo(50,6);
      ctx.arc(50, 50, 44, -Math.PI/2, Math.PI/2);
      ctx.lineTo(8,94); ctx.closePath();
      ctx.fill(); ctx.stroke();

    } else if(t==='NAND'){
      // Same D-arc as AND but shifted left (center at 42 vs 50) to leave room for bubble
      ctx.beginPath();
      ctx.moveTo(8,6); ctx.lineTo(42,6);
      ctx.arc(42, 50, 44, -Math.PI/2, Math.PI/2);
      ctx.lineTo(8,94); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(89,50,8,0,Math.PI*2); ctx.fill(); ctx.stroke();

    } else if(t==='OR'){
      // Concave back + pointed front
      ctx.beginPath();
      ctx.moveTo(8,6);
      ctx.quadraticCurveTo(34,6, 50,6);
      ctx.bezierCurveTo(78,6, 96,32, 98,50);
      ctx.bezierCurveTo(96,68, 78,94, 50,94);
      ctx.quadraticCurveTo(34,94, 8,94);
      ctx.quadraticCurveTo(22,72, 22,50);
      ctx.quadraticCurveTo(22,28, 8,6);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

    } else if(t==='NOR'){
      // Narrower concave back + pointed front (room for bubble)
      ctx.beginPath();
      ctx.moveTo(8,6);
      ctx.quadraticCurveTo(30,6, 42,6);
      ctx.bezierCurveTo(68,6, 86,32, 88,50);
      ctx.bezierCurveTo(86,68, 68,94, 42,94);
      ctx.quadraticCurveTo(30,94, 8,94);
      ctx.quadraticCurveTo(22,72, 22,50);
      ctx.quadraticCurveTo(22,28, 8,6);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(92,50,7,0,Math.PI*2); ctx.fill(); ctx.stroke();

    } else if(t==='XOR'){
      // OR body + extra back curve
      ctx.beginPath();
      ctx.moveTo(14,6);
      ctx.quadraticCurveTo(40,6, 50,6);
      ctx.bezierCurveTo(78,6, 96,32, 98,50);
      ctx.bezierCurveTo(96,68, 78,94, 50,94);
      ctx.quadraticCurveTo(40,94, 14,94);
      ctx.quadraticCurveTo(28,72, 28,50);
      ctx.quadraticCurveTo(28,28, 14,6);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // Extra back line
      ctx.beginPath();
      ctx.moveTo(6,6);
      ctx.quadraticCurveTo(20,28, 20,50);
      ctx.quadraticCurveTo(20,72, 6,94);
      ctx.stroke();

    } else if(t==='XNOR'){
      // Narrower OR body + extra back curve (room for bubble)
      ctx.beginPath();
      ctx.moveTo(14,6);
      ctx.quadraticCurveTo(36,6, 42,6);
      ctx.bezierCurveTo(68,6, 86,32, 88,50);
      ctx.bezierCurveTo(86,68, 68,94, 42,94);
      ctx.quadraticCurveTo(36,94, 14,94);
      ctx.quadraticCurveTo(28,72, 28,50);
      ctx.quadraticCurveTo(28,28, 14,6);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // Extra back line
      ctx.beginPath();
      ctx.moveTo(6,6);
      ctx.quadraticCurveTo(20,28, 20,50);
      ctx.quadraticCurveTo(20,72, 6,94);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(92,50,7,0,Math.PI*2); ctx.fill(); ctx.stroke();

    } else if(t==='NOT'){
      ctx.beginPath();
      ctx.moveTo(10,8); ctx.lineTo(10,92); ctx.lineTo(82,50); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(90,50,8,0,Math.PI*2); ctx.fill(); ctx.stroke();

    } else if(t==='BUFFER'){
      ctx.beginPath();
      ctx.moveTo(10,8); ctx.lineTo(10,92); ctx.lineTo(92,50); ctx.closePath();
      ctx.fill(); ctx.stroke();
    }

    ctx.restore();
  },

  /**
   * Build an offscreen canvas with the circuit drawn at the requested scale.
   * opts: { showLabels, showPins, showGrid, wireColor, switchMode, transparent }
   * Returns Promise<HTMLCanvasElement>.
   */
  _buildCanvas(model, scale=2, opts={}){
    const {
      showLabels = true,
      showPins   = true,
      showGrid   = false,
      wireColor  = true,
      switchMode = 'state',   // 'state' | 'symbol'
      transparent = false
    } = opts;
    // In natural/neutral mode wires are always black — signal colors are
    // meaningless when switch states are hidden.
    const effectiveWireColor = (switchMode === 'natural') ? false : wireColor;

    return new Promise(resolve=>{
      const pad = this.PADDING;
      const b = this._bounds(model);
      const W = (b.maxX - b.minX + pad*2);
      const H = (b.maxY - b.minY + pad*2);
      const cvs = document.createElement('canvas');
      cvs.width  = Math.ceil(W*scale);
      cvs.height = Math.ceil(H*scale);
      const ctx = cvs.getContext('2d');
      ctx.scale(scale, scale);

      // Background
      if(!transparent){
        ctx.fillStyle = this.BG_WHITE;
        ctx.fillRect(0,0,W,H);
      }

      // Optional grid
      if(showGrid){
        const g = 20;
        ctx.strokeStyle = 'rgba(180,190,200,0.45)';
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        for(let x=0;x<W;x+=g){ ctx.moveTo(x,0); ctx.lineTo(x,H); }
        for(let y=0;y<H;y+=g){ ctx.moveTo(0,y); ctx.lineTo(W,y); }
        ctx.stroke();
      }

      const ox = pad - b.minX, oy = pad - b.minY;

      // Wires — draw from pin dot → stub point → (routed body) → stub point → pin dot
      // so the departure and arrival angles always match the gate's facing direction.
      for(const wire of model.wires.values()){
        const src=model.getComponent(wire.fromComp);
        const dst=model.getComponent(wire.toComp);
        if(!src||!dst) continue;
        const fromR=src.resolvePin(wire.fromPin);
        const toR  =dst.resolvePin(wire.toPin);
        if(!fromR||!toR) continue;
        const fp  =this._pinPos(src,fromR.pinDef,fromR.side);
        const tp  =this._pinPos(dst,toR.pinDef,toR.side);
        const fpS =this._pinStubPos(src,fromR.pinDef,fromR.side);
        const tpS =this._pinStubPos(dst,toR.pinDef,toR.side);
        const col = this._wireColor(wire.value, effectiveWireColor);
        // Axis-aligned stub from source pin dot to stub point
        this._drawWire(ctx, fp.x+ox,fp.y+oy, fpS.x+ox,fpS.y+oy, col);
        // Routed body between stub start points
        this._drawWire(ctx, fpS.x+ox,fpS.y+oy, tpS.x+ox,tpS.y+oy, col);
        // Axis-aligned stub from stub point to destination pin dot
        this._drawWire(ctx, tpS.x+ox,tpS.y+oy, tp.x+ox,tp.y+oy, col);
      }

      // Components (all async due to SVG rendering)
      const tasks = [];
      for(const c of model.components.values()){
        tasks.push(this._drawComponent(ctx, c, ox, oy, {showLabels, showPins, wireColor: effectiveWireColor, switchMode}));
      }
      Promise.all(tasks).then(()=> resolve(cvs));
    });
  },

  /** Draw one component onto ctx. Now fully synchronous — no image loading. */
  _drawComponent(ctx, c, ox, oy, opts){
    const {showLabels, showPins, wireColor, switchMode} = opts;
    const s  = c.renderedSize();
    const cx = c.x + ox;   // top-left x of component in canvas coords
    const cy = c.y + oy;   // top-left y
    const shape = GateShapes[c.type];

    // ── Pin state dots ─────────────────────────────────────────────────────
    if(showPins && c.type !== 'NODE'){
      [...c.def.inputs.map(p=>({p,side:'in'})),
       ...c.def.outputs.map(p=>({p,side:'out'}))].forEach(({p,side})=>{
        const pos = this._pinPos(c, p, side);
        const vals = side==='in' ? c.inputValues : c.outputValues;
        const idx  = side==='in' ? c.def.inputs.indexOf(p) : c.def.outputs.indexOf(p);
        const v    = vals && vals[idx];
        ctx.beginPath();
        ctx.arc(pos.x+ox, pos.y+oy, 4, 0, Math.PI*2);
        ctx.fillStyle = this._pinColor(v, wireColor);
        ctx.fill();
        ctx.strokeStyle='#fff'; ctx.lineWidth=1.5; ctx.stroke();
      });
    }

    // ── NODE (junction dot) ────────────────────────────────────────────────
    if(c.type === 'NODE'){
      const v = c.inputValues && c.inputValues[0];
      const dotColor = v===1 ? '#1fae5c' : v===0 ? '#e0364a' : '#0f2a4a';
      ctx.save();
      ctx.translate(cx + c.w/2, cy + c.h/2);
      ctx.rotate(c.rotation * Math.PI/180);
      if(c._flipX) ctx.scale(-1, 1);
      if(c._flipY) ctx.scale(1, -1);
      // junction dot — single connection point, no wire stubs
      ctx.beginPath(); ctx.arc(0, 0, 6, 0, Math.PI*2);
      ctx.fillStyle = dotColor; ctx.fill();
      ctx.restore();
      return Promise.resolve();
    }

    // ── TEXT (free-floating label) ─────────────────────────────────────────
    if(c.type === 'TEXT'){
      const fontSize = (c.state && c.state.fontSize) || 18;
      const text = (c.state && c.state.text) || 'Text';
      ctx.save();
      ctx.translate(cx + c.w/2, cy + c.h/2);
      ctx.rotate(c.rotation * Math.PI/180);
      if(c._flipX) ctx.scale(-1, 1);
      if(c._flipY) ctx.scale(1, -1);
      ctx.font = `600 ${fontSize}px "Segoe UI",Arial,sans-serif`;
      ctx.fillStyle = '#0f2a4a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = text.split('\n');
      const lineH = fontSize * 1.35;
      const startY = -((lines.length-1)*lineH)/2;
      lines.forEach((line,i)=> ctx.fillText(line, 0, startY + i*lineH));
      ctx.restore();
      return Promise.resolve();
    }

    // ── Gate shape (AND/OR/NOT/etc.) ───────────────────────────────────────
    if(shape){
      this._drawGateShape(ctx, c, cx, cy);
      // Draw type label centered inside the gate body
      if(showLabels){
        const def = c.def;
        const isOutputOnly = def && def.category === 'output';
        const hasCustomVisual = (c.type==='SWITCH' || c.type==='VARIABLE');
        if(!isOutputOnly && !hasCustomVisual){
          // Per-gate interior: [leftX, rightX] in 0..100 viewBox space
          // Used to center text inside the actual drawn body (not the bounding box)
          const interiorX = {
            AND:    [8,  94], NAND:  [8,  86],
            OR:     [22, 98], NOR:   [22, 85],
            XOR:    [28, 98], XNOR:  [28, 85],
            NOT:    [10, 82], BUFFER:[10, 92],
          };
          const [lx, rx] = interiorX[c.type] || [8, 94];
          // Center of interior in 0..100 space; shift from viewBox center (50)
          const interiorCenterX = (lx + rx) / 2;
          const interiorWidthPx = (rx - lx) * (c.w / 100);
          // Font size: fit label text within 80% of interior width
          const label = def ? def.label : c.type;
          const approxCharW = 0.65; // bold font char-width ≈ 0.65× font-size
          const maxFs = Math.floor((interiorWidthPx * 0.80) / (label.length * approxCharW));
          const fs = Math.max(7, Math.min(maxFs, Math.round(Math.min(c.w, c.h) * 0.18)));
          // Convert viewBox offset to screen pixels
          const txOff = (interiorCenterX - 50) * (c.w / 100);
          ctx.save();
          ctx.translate(cx + c.w/2, cy + c.h/2);
          ctx.rotate(c.rotation * Math.PI / 180);
          ctx.font = `bold ${fs}px "Segoe UI",Arial,sans-serif`;
          ctx.fillStyle = '#0f2a4a';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, txOff, 0);
          ctx.restore();
        }
      }
      return Promise.resolve();   // still returns Promise so callers are uniform

    // ── Box component (SWITCH, LED, PROBE, HIGH, LOW) ──────────────────────
    } else {
      ctx.save();
      ctx.translate(cx + c.w/2, cy + c.h/2);
      ctx.rotate(c.rotation * Math.PI/180);
      if(c._flipX) ctx.scale(-1, 1);
      if(c._flipY) ctx.scale(1, -1);

      const hw=c.w/2, hh=c.h/2, rr=10;
      const boxPath = ()=>{
        ctx.beginPath();
        ctx.moveTo(-hw+rr,-hh); ctx.lineTo(hw-rr,-hh); ctx.quadraticCurveTo(hw,-hh,hw,-hh+rr);
        ctx.lineTo(hw,hh-rr);   ctx.quadraticCurveTo(hw,hh,hw-rr,hh);
        ctx.lineTo(-hw+rr,hh);  ctx.quadraticCurveTo(-hw,hh,-hw,hh-rr);
        ctx.lineTo(-hw,-hh+rr); ctx.quadraticCurveTo(-hw,-hh,-hw+rr,-hh);
        ctx.closePath();
      };
      // Default body: subtle white→light-gray gradient, light navy-gray border
      // (mirrors the live .comp-body CSS). VARIABLE draws its own colored
      // body below instead of this generic one.
      if(c.type!=='VARIABLE'){
        const bodyGrad = ctx.createLinearGradient(0,-hh,0,hh);
        if(c.type==='HIGH'){
          bodyGrad.addColorStop(0,'#d9f7e4'); bodyGrad.addColorStop(1,'#9fe8bb');
          ctx.strokeStyle = '#14893f';
        } else if(c.type==='LOW'){
          bodyGrad.addColorStop(0,'#ffe2e6'); bodyGrad.addColorStop(1,'#ffb9c2');
          ctx.strokeStyle = '#c8273c';
        } else {
          bodyGrad.addColorStop(0,'#ffffff'); bodyGrad.addColorStop(1,'#f2f5fb');
          ctx.strokeStyle = '#b8c4d8';
        }
        boxPath();
        ctx.fillStyle = bodyGrad; ctx.lineWidth = 1.5;
        ctx.fill(); ctx.stroke();
      }

      ctx.font = 'bold 13px "Segoe UI",Arial,sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';

      if(c.type==='SWITCH'){

        const isOn = !!(c.state && c.state.value);
        if(switchMode==='state' || switchMode==='natural'){
          // iOS-style track + thumb (mirrors the live .sw-track/.sw-thumb CSS)
          const trackW = c.w * 0.80, trackH = c.h * 0.50;
          const trackX = -trackW/2, trackY = -trackH/2;
          const trackR = trackH/2;
          ctx.beginPath();
          ctx.moveTo(trackX+trackR, trackY);
          ctx.lineTo(trackX+trackW-trackR, trackY);
          ctx.arc(trackX+trackW-trackR, trackY+trackR, trackR, -Math.PI/2, Math.PI/2);
          ctx.lineTo(trackX+trackR, trackY+trackH);
          ctx.arc(trackX+trackR, trackY+trackR, trackR, Math.PI/2, -Math.PI/2, false);
          ctx.closePath();
          if(switchMode==='natural'){
            ctx.fillStyle = '#d8dde4';
          } else if(isOn){
            const grad = ctx.createLinearGradient(trackX,0,trackX+trackW,0);
            grad.addColorStop(0,'#16a556'); grad.addColorStop(1,'#22d468');
            ctx.fillStyle = grad;
          } else {
            const grad = ctx.createLinearGradient(trackX,0,trackX+trackW,0);
            grad.addColorStop(0,'#c41f35'); grad.addColorStop(1,'#e0364a');
            ctx.fillStyle = grad;
          }
          ctx.fill();

          // Thumb: 82% of track height, padded 3px inside track
          // Natural: centered; state: slides left/right
          const thumbR = (trackH * 0.82)/2;
          const pad = 3;
          const thumbCx = switchMode==='natural'
            ? 0
            : isOn ? (trackX + trackW - pad - thumbR) : (trackX + pad + thumbR);
          const thumbCy = 0;
          ctx.beginPath();
          ctx.arc(thumbCx, thumbCy, thumbR, 0, Math.PI*2);
          const tgrad = ctx.createRadialGradient(thumbCx-thumbR*0.3, thumbCy-thumbR*0.35, thumbR*0.1, thumbCx, thumbCy, thumbR);
          tgrad.addColorStop(0,'#ffffff'); tgrad.addColorStop(1,'#dde3ee');
          ctx.fillStyle = tgrad;
          ctx.fill();

          if(switchMode!=='natural'){
            ctx.fillStyle = isOn ? '#1fae5c' : '#c4243a';
            ctx.font = `bold ${Math.max(6, Math.round(thumbR*0.9))}px "Segoe UI",Arial,sans-serif`;
            ctx.fillText(isOn ? '1' : '0', thumbCx, thumbCy);
          }
        } else {
          ctx.fillStyle = '#0f2a4a';
          ctx.font = 'bold 11px "Segoe UI",Arial,sans-serif';
          const isOn = !!(c.state && c.state.value);
          ctx.font = `bold ${Math.max(8, Math.round(Math.min(hw,hh)*0.32))}px "Segoe UI",Arial,sans-serif`;
          ctx.fillText(isOn ? 'SWITCH ON' : 'SWITCH OFF', 0, 0);
        }
      } else if(c.type==='LED'){
        const v = c.inputValues && c.inputValues[0];
        const lr = Math.min(hw,hh) * 0.56;
        if(switchMode === 'natural'){
          // Natural/neutral mode: draw "LED" text label instead of a colored bulb
          ctx.fillStyle = '#0f2a4a';
          ctx.font = `bold ${Math.max(9, Math.round(Math.min(hw,hh) * 0.38))}px "Segoe UI",Arial,sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('LED', 0, 0);
        } else {
          const isOn = v===1;
          const grad = ctx.createRadialGradient(-lr*0.36, -lr*0.30, lr*0.1, 0, 0, lr);
          if(isOn){
            grad.addColorStop(0,'#80ffb0'); grad.addColorStop(0.5,'#1fae5c'); grad.addColorStop(1,'#0d7a3a');
            ctx.shadowColor = 'rgba(31,174,92,0.55)'; ctx.shadowBlur = 14;
          } else {
            grad.addColorStop(0,'#ffaabd'); grad.addColorStop(0.5,'#e0364a'); grad.addColorStop(1,'#9e1a2a');
            ctx.shadowColor = 'rgba(224,54,74,0.48)'; ctx.shadowBlur = 11;
          }
          ctx.beginPath(); ctx.arc(0,0,lr,0,Math.PI*2);
          ctx.fillStyle = grad; ctx.fill();
          ctx.shadowBlur = 0;
        }
      } else if(c.type==='SEVENSEG'){
        // White panel background already painted by the generic box above.
        const vals = c.inputValues || [];
        const col = SEGCOLOR_MAP[(c.state&&c.state.segColor)||'red'];
        // svgWrap is 62% width x 72% height of body, top-padded 6px (matches live CSS)
        const dispW = c.w*0.62, dispH = c.h*0.72;
        const vbW = 32, vbH = 56;
        const s = Math.min(dispW/vbW, dispH/vbH);
        const left = -(vbW*s)/2, top = -hh + 6;
        drawSevenSegFace(ctx, left, top, s, vals, col);
      } else if(c.type==='BCDSEG'){
        // "BCD" label + A/B/C/D pin labels on left half (matches live layout)
        ctx.fillStyle = '#14c8c4';
        ctx.font = `bold ${Math.max(7,hw*0.20)}px monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('BCD', -hw*0.55, -hh*0.62);
        ctx.fillStyle = '#1a3a5c';
        ctx.font = `bold ${Math.max(6,hw*0.16)}px monospace`;
        const lblY = [-hh*0.30, -hh*0.05, hh*0.20, hh*0.45];
        ['A','B','C','D'].forEach((l,i)=>{ ctx.fillText(l, -hw*0.55, lblY[i]); });

        // 7-seg face on right half (34% width x 80% height, matches live)
        const vals = c.outputValues || [];
        const col = SEGCOLOR_MAP[(c.state&&c.state.segColor)||'red'];
        const dispW = c.w*0.34, dispH = c.h*0.80;
        const vbW = 32, vbH = 56;
        const s = Math.min(dispW/vbW, dispH/vbH);
        const left = hw*0.18, top = -(vbH*s)/2;
        drawSevenSegFace(ctx, left, top, s, vals, col);
        ctx.textAlign='center';
      } else if(c.type==='VARIABLE'){
        const isOn = !!(c.state && c.state.value);
        const grad = ctx.createLinearGradient(-hw,-hh,hw,hh);
        grad.addColorStop(0,'#f5f6f8'); grad.addColorStop(1,'#e2e6ec');
        boxPath();
        ctx.fillStyle = grad;
        ctx.strokeStyle = '#b0b8c8';
        ctx.lineWidth = 1.5;
        ctx.fill(); ctx.stroke();

        ctx.fillStyle = '#16233a';
        ctx.font = `italic bold ${Math.max(11,Math.round(hh*0.62))}px Georgia,"Times New Roman",serif`;
        ctx.fillText((c.label||'?').toUpperCase(), 0, -hh*0.12);

        const dotR = Math.max(3, hw*0.08);
        ctx.beginPath();
        ctx.arc(0, hh*0.42, dotR, 0, Math.PI*2);
        ctx.fillStyle = switchMode==='natural' ? '#b0b8c8' : (isOn ? '#1fae5c' : '#e0364a');
        ctx.fill();
      } else {
        const disp = c.type==='PROBE'
          ? (c.inputValues&&c.inputValues[0]===1?'1':c.inputValues&&c.inputValues[0]===0?'0':'X')
          : c.def.label;
        if(c.type==='HIGH')      ctx.fillStyle = '#0d6b30';
        else if(c.type==='LOW')  ctx.fillStyle = '#9e1a2a';
        else                     ctx.fillStyle = '#0f2a4a';
        ctx.fillText(disp, 0, 0);
      }
      ctx.restore();
      return Promise.resolve();
    }
  },

  // -----------------------------------------------------------------------
  // PUBLIC EXPORT METHODS
  // -----------------------------------------------------------------------

  async exportPNG(model, filename, opts={}){
    const cvs = await this._buildCanvas(model, 4, opts);
    cvs.toBlob(blob=>{
      this._download(blob, (filename||'circuit')+'.png');
    }, 'image/png');
  },

  async exportJPG(model, filename, opts={}){
    const cvs = await this._buildCanvas(model, 4, {...opts, transparent:false});
    cvs.toBlob(blob=>{
      this._download(blob, (filename||'circuit')+'.jpg');
    }, 'image/jpeg', 0.95);
  },

  exportSVG(model, filename, opts={}){
    const {showLabels=true, showPins=true, showGrid=false, wireColor=true, switchMode='state'} = opts;
    const effectiveWireColor = (switchMode === 'natural') ? false : wireColor;
    const pad=this.PADDING;
    const b=this._bounds(model);
    const W=b.maxX-b.minX+pad*2;
    const H=b.maxY-b.minY+pad*2;
    const ox=pad-b.minX, oy=pad-b.minY;

    let body='';

    // Grid
    if(showGrid){
      body+='<g opacity="0.45" stroke="rgba(180,190,200,1)" stroke-width="0.75">';
      for(let x=0;x<W;x+=20) body+=`<line x1="${x}" y1="0" x2="${x}" y2="${H}"/>`;
      for(let y=0;y<H;y+=20) body+=`<line x1="0" y1="${y}" x2="${W}" y2="${y}"/>`;
      body+='</g>';
    }

    // Wires
    for(const wire of model.wires.values()){
      const src=model.getComponent(wire.fromComp),dst=model.getComponent(wire.toComp);
      if(!src||!dst) continue;
      const fromR=src.resolvePin(wire.fromPin);
      const toR  =dst.resolvePin(wire.toPin);
      if(!fromR||!toR) continue;
      const fp=this._pinPos(src,fromR.pinDef,fromR.side),tp=this._pinPos(dst,toR.pinDef,toR.side);
      const x1=fp.x+ox,y1=fp.y+oy,x2=tp.x+ox,y2=tp.y+oy,mid=(x1+x2)/2;
      const col=this._wireColor(wire.value,effectiveWireColor);
      body+=`<path d="M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}" fill="none" stroke="${col}" stroke-width="2.6" stroke-linecap="round"/>`;
    }

    // Components
    for(const c of model.components.values()){
      const s=c.renderedSize();
      const compCX=c.x+ox+s.w/2, compCY=c.y+oy+s.h/2;
      const shape=GateShapes[c.type];

      if(showPins && c.type !== 'NODE'){
        [...c.def.inputs.map(p=>({p,side:'in'})),
         ...c.def.outputs.map(p=>({p,side:'out'}))].forEach(({p,side})=>{
          const pos=this._pinPos(c,p,side);
          const vals=side==='in'?c.inputValues:c.outputValues;
          const idx=side==='in'?c.def.inputs.indexOf(p):c.def.outputs.indexOf(p);
          const v=vals&&vals[idx];
          const col=this._pinColor(v,effectiveWireColor);
          body+=`<circle cx="${pos.x+ox}" cy="${pos.y+oy}" r="4" fill="${col}" stroke="#fff" stroke-width="1.5"/>`;
        });
      }

      if(shape){
        const colored=shape
          .replace(/class="gate-outline"/g,'fill="#ffffff" stroke="#0f2a4a" stroke-width="2.5"')
          .replace(/class="gate-bubble"/g, 'fill="#ffffff" stroke="#0f2a4a" stroke-width="2.5"')
          .replace(/class="gate-leadline"/g,'stroke="#0f2a4a" stroke-width="2.5"');
        const inner=colored.replace(/<svg[^>]*>/i,'').replace(/<\/svg>/i,'').trim();
        const scaleX = (c._flipX ? -1 : 1) * c.w/100;
        const scaleY = (c._flipY ? -1 : 1) * c.h/100;
        body+=`<g transform="translate(${compCX},${compCY}) rotate(${c.rotation}) scale(${scaleX},${scaleY}) translate(-50,-50)">${inner}</g>`;
        // Draw label inside gate body (on top of shape)
        if(showLabels){
          const def2=c.def;
          const isOutputOnly2=def2&&def2.category==='output';
          const hasCustomVisual2=(c.type==='SWITCH'||c.type==='VARIABLE');
          if(!isOutputOnly2&&!hasCustomVisual2){
            const interiorX2={AND:[8,94],NAND:[8,86],OR:[22,98],NOR:[22,85],XOR:[28,98],XNOR:[28,85],NOT:[10,82],BUFFER:[10,92]};
            const [lx2,rx2]=interiorX2[c.type]||[8,94];
            const interiorCenterX2=(lx2+rx2)/2;
            const interiorWidthPx2=(rx2-lx2)*(c.w/100);
            const label2=def2?def2.label:c.type;
            const maxFs2=Math.floor((interiorWidthPx2*0.80)/(label2.length*0.65));
            const fs2=Math.max(7,Math.min(maxFs2,Math.round(Math.min(c.w,c.h)*0.18)));
            const txOff2=(interiorCenterX2-50)*(c.w/100);
            body+=`<g transform="translate(${compCX},${compCY}) rotate(${c.rotation})"><text x="${txOff2}" y="0" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI,Arial,sans-serif" font-size="${fs2}" font-weight="bold" fill="#0f2a4a">${label2}</text></g>`;
          }
        }
      } else {
        const hw=c.w/2,hh=c.h/2,rr=10;
        let inner='';
        let skipGenericBox = false;
        if(c.type==='SWITCH'){
          if(switchMode==='state' || switchMode==='natural'){
            const isOn=c.state&&c.state.value;
            const trackW=c.w*0.80, trackH=c.h*0.50, trackR=trackH/2;
            const tx=-trackW/2, ty=-trackH/2;
            const thumbR=(trackH*0.82)/2, pad=3;
            const thumbCx = switchMode==='natural' ? 0 : isOn ? (tx+trackW-pad-thumbR) : (tx+pad+thumbR);
            if(switchMode==='natural'){
              inner = `<rect x="${tx}" y="${ty}" width="${trackW}" height="${trackH}" rx="${trackR}" ry="${trackR}" fill="#d8dde4"/>
                <circle cx="${thumbCx}" cy="0" r="${thumbR}" fill="#eef1f6"/>`;
            } else {
              const trackFill = isOn ? 'url(#sw-on-grad-'+c.id+')' : '#c4cbd4';
              inner = `<defs><linearGradient id="sw-on-grad-${c.id}" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stop-color="#16a556"/><stop offset="1" stop-color="#22d468"/>
                </linearGradient></defs>
                <rect x="${tx}" y="${ty}" width="${trackW}" height="${trackH}" rx="${trackR}" ry="${trackR}" fill="${trackFill}"/>
                <circle cx="${thumbCx}" cy="0" r="${thumbR}" fill="#eef1f6"/>
                <text x="${thumbCx}" y="0" text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI,Arial,sans-serif" font-size="${Math.max(6,Math.round(thumbR*0.9))}" font-weight="bold" fill="${isOn?'#1fae5c':'#8a93a1'}">${isOn?'1':'0'}</text>`;
            }
          } else {
            const isOnSym=!!(c.state&&c.state.value);
            inner=`<text text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI,Arial,sans-serif" font-size="10" font-weight="bold" fill="#0f2a4a">${isOnSym?'SWITCH ON':'SWITCH OFF'}</text>`;
          }
        } else if(c.type==='NODE'){
          skipGenericBox = true;
          const v=c.inputValues&&c.inputValues[0];
          const dotColor = v===1?'#1fae5c':v===0?'#e0364a':'#0f2a4a';
          inner = `<circle cx="0" cy="0" r="6" fill="${dotColor}"/>`;
        } else if(c.type==='LED'){
          const v=c.inputValues&&c.inputValues[0];
          const lr=Math.min(hw,hh)*0.56;
          if(switchMode==='natural'){
            const fs=Math.max(9, Math.round(Math.min(hw,hh)*0.38));
            inner=`<text text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI,Arial,sans-serif" font-size="${fs}" font-weight="bold" fill="#0f2a4a">LED</text>`;
          } else {
            const ledOn=v===1;
            const gid='led-grad-'+c.id;
            const stops = ledOn
              ? `<stop offset="0" stop-color="#80ffb0"/><stop offset="0.5" stop-color="#1fae5c"/><stop offset="1" stop-color="#0d7a3a"/>`
              : `<stop offset="0" stop-color="#ffaabd"/><stop offset="0.5" stop-color="#e0364a"/><stop offset="1" stop-color="#9e1a2a"/>`;
            inner = `<defs><radialGradient id="${gid}" cx="36%" cy="32%" r="70%">${stops}</radialGradient></defs>
              <circle r="${lr}" fill="url(#${gid})"/>`;
          }
        } else if(c.type==='VARIABLE'){
          skipGenericBox = true;
          const isOn=!!(c.state&&c.state.value);
          const gid='var-grad-'+c.id;
          const stops=`<stop offset="0" stop-color="#f5f6f8"/><stop offset="1" stop-color="#e2e6ec"/>`;
          const strokeCol='#b0b8c8';
          const dotFill = switchMode==='natural' ? '#b0b8c8' : (isOn ? '#1fae5c' : '#e0364a');
          const dotR = Math.max(3, hw*0.08);
          const fs = Math.max(11, Math.round(hh*0.62));
          inner = `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">${stops}</linearGradient></defs>
            <rect x="${-hw}" y="${-hh}" width="${c.w}" height="${c.h}" rx="${rr}" fill="url(#${gid})" stroke="${strokeCol}" stroke-width="1.5"/>
            <text x="0" y="${-hh*0.12}" text-anchor="middle" dominant-baseline="middle" font-family="Georgia,'Times New Roman',serif" font-style="italic" font-size="${fs}" font-weight="bold" fill="#16233a">${(c.label||'?').toUpperCase()}</text>
            <circle cx="0" cy="${hh*0.42}" r="${dotR}" fill="${dotFill}"/>`;
        } else if(c.type==='SEVENSEG'){
          const vals=c.inputValues||[];
          const col = SEGCOLOR_MAP[(c.state&&c.state.segColor)||'red'];
          const dispW=c.w*0.62, dispH=c.h*0.72;
          const s=Math.min(dispW/32, dispH/56);
          const left=-(32*s)/2, top=-hh+6;
          inner = `<g transform="translate(${left},${top}) scale(${s})">${sevenSegFaceSVG(vals,col)}</g>`;
        } else if(c.type==='BCDSEG'){
          const fs=Math.max(6,hw*0.16);
          const fsLbl=Math.max(7,hw*0.20);
          inner = `<text x="${-hw*0.55}" y="${-hh*0.62}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="${fsLbl}" font-weight="bold" fill="#14c8c4">BCD</text>`
            + ['A','B','C','D'].map((l,i)=>{
                const y=[-hh*0.30,-hh*0.05,hh*0.20,hh*0.45][i];
                return `<text x="${-hw*0.55}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="${fs}" font-weight="bold" fill="#1a3a5c">${l}</text>`;
              }).join('');
          const vals=c.outputValues||[];
          const col = SEGCOLOR_MAP[(c.state&&c.state.segColor)||'red'];
          const dispW=c.w*0.34, dispH=c.h*0.80;
          const s=Math.min(dispW/32, dispH/56);
          const left=hw*0.18, top=-(56*s)/2;
          inner += `<g transform="translate(${left},${top}) scale(${s})">${sevenSegFaceSVG(vals,col)}</g>`;
        } else {
          const disp=c.type==='PROBE'?(c.inputValues&&c.inputValues[0]===1?'1':c.inputValues&&c.inputValues[0]===0?'0':'X'):c.def.label;
          inner=`<text text-anchor="middle" dominant-baseline="middle" font-family="Segoe UI,Arial,sans-serif" font-size="13" font-weight="bold" fill="#0f2a4a">${disp}</text>`;
        }
        const genericBox = skipGenericBox ? '' :
          `<defs><linearGradient id="box-grad-${c.id}" x1="0" y1="0" x2="0" y2="1">
             <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#f2f5fb"/>
           </linearGradient></defs>
           <rect x="${-hw}" y="${-hh}" width="${c.w}" height="${c.h}" rx="${rr}" fill="url(#box-grad-${c.id})" stroke="#b8c4d8" stroke-width="1.5"/>`;
        const flipXSvg = c._flipX ? 'scaleX(-1)' : '';
        const flipYSvg = c._flipY ? 'scaleY(-1)' : '';
        body+=`<g transform="translate(${compCX},${compCY}) rotate(${c.rotation}) ${flipXSvg} ${flipYSvg}">
          ${genericBox}
          ${inner}
        </g>`;
      }
    }

    const svgStr=`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n  <rect width="${W}" height="${H}" fill="#ffffff"/>\n  ${body}\n</svg>`;
    const blob=new Blob([svgStr],{type:'image/svg+xml'});
    this._download(blob, (filename||'circuit')+'.svg');
  },

  /** Build a valid PDF as a Uint8Array and download it.
   *  Key fix: all PDF binary objects are encoded as Uint8Arrays and
   *  concatenated without going through JS strings, so JPEG bytes are
   *  never corrupted by UTF-16 string handling. */
  async exportPDF(model, filename, opts={}){
    const cvs = await this._buildCanvas(model, 4, {...opts, transparent:false});
    // Get PNG bytes (lossless, universally supported by PDF readers)
    const blob = await new Promise(r=> cvs.toBlob(r, 'image/png'));
    const imgBytes = new Uint8Array(await blob.arrayBuffer());

    const W = cvs.width/4, H = cvs.height/4;
    const pt = 72/96;
    const pw = +(W*pt).toFixed(2), ph = +(H*pt).toFixed(2);

    const enc = new TextEncoder();

    // PDF object strings (text parts)
    const o1 = enc.encode('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    const o2 = enc.encode(`2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`);
    const o3 = enc.encode(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>\nendobj\n`);
    const stream4 = `q ${pw} 0 0 ${ph} 0 0 cm /Im1 Do Q`;
    const o4 = enc.encode(`4 0 obj\n<< /Length ${stream4.length} >>\nstream\n${stream4}\nendstream\nendobj\n`);

    const o5head = enc.encode(
      `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${cvs.width} /Height ${cvs.height}` +
      ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${imgBytes.length} >>\nstream\n`
    );
    // Note: /FlateDecode with raw PNG byte data won't decode correctly in all readers.
    // Better: strip PNG to raw RGB or use /DCTDecode (JPEG). We'll embed as JPEG instead.
    // Re-export as JPEG for PDF embedding:
    const jpegBlob = await new Promise(r=> cvs.toBlob(r,'image/jpeg',0.95));
    const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

    const o5headJ = enc.encode(
      `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${cvs.width} /Height ${cvs.height}` +
      ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
    );
    const streamEnd = enc.encode('\nendstream\nendobj\n');
    const header = enc.encode('%PDF-1.4\n');

    // Compute byte offsets for xref
    const parts = [header, o1, o2, o3, o4, o5headJ, jpegBytes, streamEnd];
    const offsets = [];
    let pos = 0;
    for(let i=0;i<parts.length;i++){
      if(i>=1 && i<=5) offsets.push(pos);  // objects 1-5 start positions
      pos += parts[i].length;
    }
    // Object 5's offset is after o4 (index 4 in parts = o5headJ)
    // Let me recalculate cleanly:
    let bytePos = header.length;
    const objOffsets = [];
    objOffsets.push(bytePos); bytePos += o1.length;       // obj 1
    objOffsets.push(bytePos); bytePos += o2.length;       // obj 2
    objOffsets.push(bytePos); bytePos += o3.length;       // obj 3
    objOffsets.push(bytePos); bytePos += o4.length;       // obj 4
    objOffsets.push(bytePos);                             // obj 5
    bytePos += o5headJ.length + jpegBytes.length + streamEnd.length;

    const xrefPos = bytePos;
    const xrefStr =
      `xref\n0 6\n0000000000 65535 f \n` +
      objOffsets.map(o=> o.toString().padStart(10,'0') + ' 00000 n ').join('\n') +
      `\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
    const xrefBytes = enc.encode(xrefStr);

    // Concatenate all Uint8Arrays into one buffer
    const allParts = [header, o1, o2, o3, o4, o5headJ, jpegBytes, streamEnd, xrefBytes];
    const total = allParts.reduce((s,p)=>s+p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for(const p of allParts){ out.set(p, offset); offset += p.length; }

    const pdfBlob = new Blob([out], {type:'application/pdf'});
    this._download(pdfBlob, (filename||'circuit')+'.pdf');
  },

  _download(blob, filename){
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
};

