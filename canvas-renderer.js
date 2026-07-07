// =========================================================================
// 8. CANVAS RENDERER
// -------------------------------------------------------------------------
// Owns the three stacked <canvas> elements (grid, wires, overlay). The
// component bodies themselves are DOM nodes (see ComponentView) inside
// #world, transformed via CSS transform for pan/zoom — this keeps gate
// rendering crisp (real DOM text/borders) while wires/grid use canvas for
// performance with large wire counts.
// =========================================================================
class CanvasRenderer{
  constructor(viewport, grid, wireC, overlay, world){
    this.viewport = viewport;
    this.gridCanvas = grid; this.wireCanvas = wireC; this.overlayCanvas = overlay;
    this.world = world;
    this.gridCtx = grid.getContext('2d');
    this.wireCtx = wireC.getContext('2d');
    this.overlayCtx = overlay.getContext('2d');
    this.pan = {x:0, y:0};
    this.zoom = 1;
    this.gridSize = 20;
    this.snapEnabled = true;
    this.gridVisible = true;
    // Bounded design canvas (in grid squares). null = infinite (legacy
    // Excel-style open-ended sheet, unchanged default behavior). Set via
    // setCanvasSize() from the View ▸ Canvas Size menu.
    this.canvasCols = null;
    this.canvasRows = null;
    // Wire stroke width in CONSTANT screen pixels — intentionally NOT
    // multiplied by `this.zoom` anywhere (wires are drawn on a screen-space
    // canvas, not inside the zoom-scaled #world), so the line stays visually
    // the same thickness whether the user is zoomed all the way in or out.
    // Default chosen to match the visual weight of a pin (10px dot) / probe.
    this.wireWidth = 3.0;
    // resize() is called explicitly from App.init() after the DOM has fully
    // laid out, so getBoundingClientRect() returns the real dimensions.
    this.viewportSize = {w:0, h:0};
  }
  resize(){
    const r = this.viewport.getBoundingClientRect();
    [this.gridCanvas, this.wireCanvas, this.overlayCanvas].forEach(cv=>{
      cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio;
      cv.style.width = r.width+'px'; cv.style.height = r.height+'px';
    });
    // Keep the visual centre stable when the viewport changes size at runtime
    // (browser zoom, window resize). Skip on the very first call (w/h = 0).
    if(this.viewportSize.w > 0 && this.viewportSize.h > 0){
      this.pan.x += (r.width  - this.viewportSize.w) * 0.5;
      this.pan.y += (r.height - this.viewportSize.h) * 0.5;
    }
    this.viewportSize = {w:r.width, h:r.height};
    this.draw();
  }
  /** Converts a screen-space (viewport-relative) point to world coordinates. */
  screenToWorld(sx, sy){
    return { x:(sx - this.pan.x)/this.zoom, y:(sy - this.pan.y)/this.zoom };
  }
  worldToScreen(wx, wy){
    return { x: wx*this.zoom + this.pan.x, y: wy*this.zoom + this.pan.y };
  }
  applyWorldTransform(){
    this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.zoom})`;
  }
  /** Excel-style workspace bound: world (0,0) is the fixed top-left corner
   *  ("cell A1") and the sheet is open-ended to the right/down, but pan can
   *  never go positive — that would mean the viewport's top-left corner is
   *  showing negative world space (left of column 0 / above row 0), which
   *  doesn't exist. Called once from draw() so every pan mutation (drag,
   *  wheel-zoom, resize re-centre, loaded file, reset) is clamped in one
   *  place before the frame is rendered. */
  /** Minimum zoom allowed when the canvas is bounded: the canvas sheet is
   *  never allowed to shrink (on screen) below the viewport's own size,
   *  which means zooming out always keeps the sheet filling the view —
   *  you can't zoom out "past" the corner and see empty space beyond it.
   *  Infinite Canvas (no bounds) keeps the original 0.15 floor. */
  minZoomForBounds(){
    if(!this.canvasCols || !this.canvasRows || !this.viewportSize.w || !this.viewportSize.h) return 0.15;
    const zx = this.viewportSize.w / (this.canvasCols * this.gridSize);
    const zy = this.viewportSize.h / (this.canvasRows * this.gridSize);
    return Math.max(zx, zy, 0.15);
  }
  _clampZoom(){
    const minZ = this.minZoomForBounds();
    if(this.zoom < minZ) this.zoom = minZ;
    if(this.zoom > 4) this.zoom = 4;
  }
  _clampPan(){
    if(this.pan.x > 0) this.pan.x = 0;
    if(this.pan.y > 0) this.pan.y = 0;
    // When the canvas is bounded (not Infinite Canvas), also stop the pan
    // from scrolling past the canvas's right/bottom edge, the same way
    // the left/top edge is pinned at world (0,0) above.
    if(this.canvasCols){
      const worldW = this.canvasCols * this.gridSize * this.zoom;
      const minX = Math.min(0, this.viewportSize.w - worldW);
      if(this.pan.x < minX) this.pan.x = minX;
    }
    if(this.canvasRows){
      const worldH = this.canvasRows * this.gridSize * this.zoom;
      const minY = Math.min(0, this.viewportSize.h - worldH);
      if(this.pan.y < minY) this.pan.y = minY;
    }
  }
  /** Sets the bounded design canvas size in grid squares (View ▸ Canvas
   *  Size). Pass cols=null, rows=null for an Infinite Canvas. Immediately
   *  re-clamps the pan and redraws so the change is reflected at once. */
  setCanvasSize(cols, rows){
    this.canvasCols = cols;
    this.canvasRows = rows;
    this.draw();
  }
  /** Redraws grid (dot-grid, CAD style) + wires + overlay. Call after any
   *  pan/zoom/data change. Kept cheap: grid uses a single pattern loop,
   *  wires loop is O(wire count). */
  draw(){
    this._clampZoom();
    this._clampPan();
    this._drawGrid();
    this.applyWorldTransform();
  }
  _drawGrid(){
    const ctx = this.gridCtx;
    const {w,h} = this.viewportSize;
    ctx.save();
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0,0,w,h);
    // Bounded canvas: shade everything outside the sheet's on-screen rect
    // a muted gray, and clip the grid/sheet itself to that rect — so the
    // grid visibly stops at the canvas edge rather than continuing past
    // it forever (Infinite Canvas just leaves sheetRect null = no clip).
    let sheetRect = null;
    if(this.canvasCols && this.canvasRows){
      const x0 = Math.max(0, this.pan.x), y0 = Math.max(0, this.pan.y);
      const x1 = Math.min(w, this.pan.x + this.canvasCols*this.gridSize*this.zoom);
      const y1 = Math.min(h, this.pan.y + this.canvasRows*this.gridSize*this.zoom);
      sheetRect = {x0,y0,x1,y1};
      ctx.fillStyle = '#d6dade';
      ctx.fillRect(0,0,w,h);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(x0, y0, Math.max(0,x1-x0), Math.max(0,y1-y0));
    }
    if(this.gridVisible){
      const g = this.gridSize * this.zoom;
      if(g > 4){
        ctx.save();
        if(sheetRect){
          ctx.beginPath();
          ctx.rect(sheetRect.x0, sheetRect.y0, Math.max(0,sheetRect.x1-sheetRect.x0), Math.max(0,sheetRect.y1-sheetRect.y0));
          ctx.clip();
        }
        const offX = this.pan.x % g, offY = this.pan.y % g;
        ctx.strokeStyle = 'rgba(180,190,200,0.55)';
        ctx.lineWidth = 0.75;
        ctx.beginPath();
        for(let x = offX; x < w; x += g){
          ctx.moveTo(x, 0); ctx.lineTo(x, h);
        }
        for(let y = offY; y < h; y += g){
          ctx.moveTo(0, y); ctx.lineTo(w, y);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
    this._drawWorkspaceBounds(ctx, w, h);
    ctx.restore();
  }
  /** Draws the hard left/top workspace edge at world x=0 / y=0 once
   *  _clampPan() has pinned the pan there: a single flat-color band (no
   *  multi-tone strip breakdown) with one crisp inner seam line against
   *  the canvas, in the app's own navy tone. Each band is only ever
   *  on-screen exactly when that axis is panned all the way home, since
   *  pan.x/pan.y never go positive — drag (or zoom) away from the corner
   *  and it scrolls off naturally. */
  _drawWorkspaceBounds(ctx, w, h){
    const edgeX = this.pan.x, edgeY = this.pan.y;
    const showLeft = edgeX > -10 && edgeX < w;
    const showTop  = edgeY > -10 && edgeY < h;
    if(!showLeft && !showTop) return;
    const FRAME = 14;          // total band width
    const C_BAND  = '#0f2a4a'; // single flat navy band color
    const C_SEAM  = 'rgba(0,0,0,0.35)'; // inner seam line against canvas
    ctx.save();

    // ---- Left band -------------------------------------------------
    if(showLeft){
      ctx.fillStyle = C_BAND;
      ctx.fillRect(edgeX, 0, FRAME, h);
      ctx.strokeStyle = C_SEAM;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(edgeX + FRAME + 0.5, 0); ctx.lineTo(edgeX + FRAME + 0.5, h); ctx.stroke();
    }

    // ---- Top band ----------------------------------------------------
    if(showTop){
      ctx.fillStyle = C_BAND;
      ctx.fillRect(0, edgeY, w, FRAME);
      ctx.strokeStyle = C_SEAM;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, edgeY + FRAME + 0.5); ctx.lineTo(w, edgeY + FRAME + 0.5); ctx.stroke();
    }

    // ---- Right band (only when the canvas is bounded, i.e. not the
    // Infinite Canvas) — mirrors the left band, anchored to the canvas's
    // far edge at world x = canvasCols * gridSize instead of x = 0.
    if(this.canvasCols){
      const edgeXR = this.pan.x + this.canvasCols * this.gridSize * this.zoom;
      if(edgeXR > -10 && edgeXR < w + FRAME){
        ctx.fillStyle = C_BAND;
        ctx.fillRect(edgeXR - FRAME, 0, FRAME, h);
        ctx.strokeStyle = C_SEAM;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(edgeXR - FRAME - 0.5, 0); ctx.lineTo(edgeXR - FRAME - 0.5, h); ctx.stroke();
      }
    }

    // ---- Bottom band (only when bounded) — mirrors the top band.
    if(this.canvasRows){
      const edgeYB = this.pan.y + this.canvasRows * this.gridSize * this.zoom;
      if(edgeYB > -10 && edgeYB < h + FRAME){
        ctx.fillStyle = C_BAND;
        ctx.fillRect(0, edgeYB - FRAME, w, FRAME);
        ctx.strokeStyle = C_SEAM;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, edgeYB - FRAME - 0.5); ctx.lineTo(w, edgeYB - FRAME - 0.5); ctx.stroke();
      }
    }

    // ---- Corner: single flat fill where the two bands cross (no
    // mitered multi-tone split needed since it's one color throughout).
    if(showLeft && showTop){
      ctx.fillStyle = C_BAND;
      ctx.fillRect(edgeX, edgeY, FRAME, FRAME);
    }
    ctx.restore();
  }
  /** Renders all wires as orthogonal (H/V) electrical paths colored by signal state.
   *  Also draws an in-progress wire-drag preview when `dragWire` is supplied.
   *
   *  Four rendering passes for maximum visual quality:
   *    1. Glow     — wide soft-colored halo for selected / HIGH wires (depth cue)
   *    2. Shadow   — faint dark offset stroke for physical depth
   *    3. Color    — the wires in their signal color with rounded corners
   *    4. Hop bridges — at genuine crossings the "over" wire draws a smooth
   *                     semicircular bump (classic schematic / PCB style)
   */
  drawWires(model, getPinScreenPos, dragWire, hoverSeg){
    const ctx = this.wireCtx;
    const {w,h} = this.viewportSize;
    ctx.save();
    ctx.scale(devicePixelRatio, devicePixelRatio);
    ctx.clearRect(0,0,w,h);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // Collect wire geometry — route each wire using the orthogonal routing engine
    const wireEntries = [];
    for(const wire of model.wires.values()){
      // Resolve stub points: points one STUB_LENGTH away from each pin on the
      // gate's approach axis. The router runs between these stub points so the
      // final segment always arrives parallel to the gate face (never at an
      // oblique angle). The actual pin screen positions are appended afterward
      // as the true first/last points so the drawn line terminates on the dot.
      const fromStub = WireRouter._resolveStub(wire.fromComp, wire.fromPin, model);
      const toStub   = WireRouter._resolveStub(wire.toComp,   wire.toPin,   model);
      if(!fromStub || !toStub) continue;

      const fromW = fromStub.stubPos;   // routing origin  (stub entry point)
      const toW   = toStub.stubPos;     // routing destination (stub entry point)

      // Screen-space pin positions for the true wire endpoints (drawn on top
      // of the stub segment, connecting the last routed point to the dot).
      const from = getPinScreenPos(wire.fromComp, wire.fromPin, 'out');
      const to   = getPinScreenPos(wire.toComp,   wire.toPin,   'in');
      if(!from || !to) continue;

      // Route in world space, map result to screen space. Body obstacles
      // come from WireRouter._obstacles, which correctly KEEPS a component's
      // own body as an obstacle when both wire ends belong to that same
      // component (pin-to-pin wiring within one gate) — a hand-rolled filter
      // used to live here instead and had its same-component branch
      // backwards, silently dropping every obstacle (including unrelated
      // components, not just this one) for any same-component wire. That's
      // what let a wire between two adjacent pins draw as a bare straight
      // line right through the gap between them instead of bypassing the
      // gate body like every other same-component wire already does.
      const bodyObs = WireRouter._obstacles(model, wire.fromComp, wire.toComp);
      const pinObs = WireRouter._pinObstacles(model, wire.fromComp, wire.fromPin, wire.toComp, wire.toPin);
      const obs = bodyObs.concat(pinObs);
      let worldPts;
      if(wire.waypoints && wire.waypoints.length >= 2){
        // Custom waypoints: replace first/last with stub points (not raw pin
        // positions) so the axis-aligned approach constraint is preserved even
        // for manually-placed wires.
        const wps = wire.waypoints.map(p=>({x:p.x, y:p.y}));
        wps[0] = fromW;
        wps[wps.length-1] = toW;
        worldPts = [];
        for(let i = 0; i < wps.length - 1; i++){
          const seg = WireRouter.route(wps[i], wps[i+1], obs);
          if(i === 0) worldPts.push(...seg);
          else worldPts.push(...seg.slice(1)); // skip duplicate junction point
        }
      } else {
        worldPts = WireRouter.route(fromW, toW, obs);
      }
      // Convert each waypoint from world → screen
      const pts = worldPts.map(p => this.worldToScreen(p.x, p.y));
      // Prepend/append the exact pin screen positions so the path always
      // starts and ends precisely on the pin dot (the stub segment is thus
      // drawn as the very first / very last segment of the polyline).
      if(pts.length){
        pts.unshift(from);   // from pin dot → stub entry
        pts.push(to);        // stub entry → to pin dot
      }

      wireEntries.push({ id: wire.id, pts, value: wire.value, selected: wire._selected });
    }
    if(dragWire && dragWire.from){
      // Preview wire: if there are intermediate waypoints (multi-click drawing mode),
      // show the committed segments + a live segment from the last waypoint to cursor.
      // This is routed through the same orthogonal obstacle-avoiding engine used for
      // finished wires (see WireRouter._obstacles / _pinObstacles above) —
      // otherwise the live preview would draw a raw straight line straight
      // through a component's own other pins (e.g. dragging from input 1
      // toward input 4 on a multi-input gate used to cut a line right past
      // inputs 2 and 3, hugging the gate body). Routing the preview
      // identically means what's shown while dragging always matches what
      // you get once the wire is actually placed.
      //
      // Stub approach: if we know the source pin (dragWire.fromComp / fromPin),
      // start routing from its stub point so the departure angle is already
      // axis-aligned to the gate's facing direction, matching the finished wire.
      const dragFromComp = dragWire.fromComp;
      const dragToComp   = dragWire.toComp || dragFromComp;
      const dragToPin    = dragWire.toPin  || null;

      // Source: prefer stub point if fromComp/fromPin are known
      let worldFrom;
      if(dragFromComp && dragWire.fromPin){
        const fromStubInfo = WireRouter._resolveStub(dragFromComp, dragWire.fromPin, model);
        worldFrom = fromStubInfo ? fromStubInfo.stubPos : this.screenToWorld(dragWire.from.x, dragWire.from.y);
      } else {
        worldFrom = this.screenToWorld(dragWire.from.x, dragWire.from.y);
      }

      // Destination: if snapped to a target pin, use its stub point; otherwise raw cursor
      let worldTo;
      if(dragToComp && dragToPin){
        const toStubInfo = WireRouter._resolveStub(dragToComp, dragToPin, model);
        worldTo = toStubInfo ? toStubInfo.stubPos : this.screenToWorld(dragWire.to.x, dragWire.to.y);
      } else {
        worldTo = this.screenToWorld(dragWire.to.x, dragWire.to.y);
      }

      const dragObs = dragFromComp
        ? WireRouter._obstacles(model, dragFromComp, dragToComp)
            .concat(WireRouter._pinObstacles(model, dragFromComp, dragWire.fromPin, dragToComp, dragToPin))
        : [];
      const worldWps = [worldFrom, ...(dragWire.waypoints||[]), worldTo];
      let worldPts = [];
      for(let i=0;i<worldWps.length-1;i++){
        const seg = dragFromComp
          ? WireRouter.route(worldWps[i], worldWps[i+1], dragObs)
          : [worldWps[i], worldWps[i+1]];
        if(i===0) worldPts.push(...seg);
        else worldPts.push(...seg.slice(1));
      }
      const previewPts = worldPts.map(p => this.worldToScreen(p.x, p.y));
      // Prepend the exact from-pin screen pos and append the to-pin/cursor pos
      // so the preview's terminal segments match the finished wire's stub lines.
      if(previewPts.length){
        previewPts.unshift(dragWire.from);
        previewPts.push(dragWire.to);
      }
      wireEntries.push({ pts: previewPts, value: null, selected: false, isPreview: true });
    }

    // ── PASS 0: hover segment highlight ─────────────────────────────────────
    // Glows only the single segment under the cursor (not the whole wire) —
    // this is the "you can grab this" affordance shown before any drag starts.
    // hoverSeg.waypoints/segIndex come straight from the same waypoint list
    // _onMouseDown will edit, converted to screen space here directly (not
    // looked up in wireEntries[].pts), so there's no second index space that
    // could drift out of sync with what actually gets dragged.
    if(hoverSeg && hoverSeg.waypoints){
      const wp = hoverSeg.waypoints;
      const a = wp[hoverSeg.segIndex], b = wp[hoverSeg.segIndex + 1];
      if(a && b){
        const sa = this.worldToScreen(a.x, a.y), sb = this.worldToScreen(b.x, b.y);
        ctx.save();
        ctx.strokeStyle = 'rgba(20,200,196,0.30)';
        ctx.lineWidth   = (this.wireWidth + 6) * this.zoom;
        ctx.lineCap     = 'round';
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(sa.x, sa.y);
        ctx.lineTo(sb.x, sb.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    // ── PASS 1: selection glow ────────────────────────────────────────────────
    for(const e of wireEntries){
      if(!e.selected && e.value !== 1) continue;
      if(e.isPreview) continue;
      const glowColor = e.selected
        ? 'rgba(20,200,196,0.22)'
        : 'rgba(31,174,92,0.18)';
      ctx.save();
      ctx.strokeStyle = glowColor;
      ctx.lineWidth   = (this.wireWidth + 5) * this.zoom;
      ctx.setLineDash([]);
      ctx.beginPath();
      this._drawPath45(ctx, e.pts);
      ctx.stroke();
      ctx.restore();
    }

    // ── PASS 2: shadows ──────────────────────────────────────────────────────
    ctx.save();
    ctx.translate(1.2, 1.8);
    for(const e of wireEntries){
      if(e.isPreview) continue;
      const baseWidth = e.selected ? (this.wireWidth + 0.8) : this.wireWidth;
      ctx.strokeStyle = 'rgba(10,25,50,0.11)';
      ctx.lineWidth   = (baseWidth + 1.8) * this.zoom;
      ctx.setLineDash([]);
      ctx.beginPath();
      this._drawPath45(ctx, e.pts);
      ctx.stroke();
    }
    ctx.restore();

    // ── PASS 3: wire color ───────────────────────────────────────────────────
    for(const e of wireEntries){
      this._strokeWire45(ctx, e.pts, e.value, e.selected, e.isPreview||false);
    }

    // ── PASS 4: hop bridges ──────────────────────────────────────────────────
    // At every genuine crossing the OVER wire (index i) draws a smooth
    // semicircular hop bridge over the UNDER wire (j).
    if(wireEntries.length > 1){
      const HOP_R    = this.wireWidth * 2.0 * this.zoom;
      const GAP_HALF = this.wireWidth * 2.2 * this.zoom;

      const segIntersect = (p1,p2,p3,p4) => {
        const dx1=p2.x-p1.x, dy1=p2.y-p1.y;
        const dx2=p4.x-p3.x, dy2=p4.y-p3.y;
        const denom = dx1*dy2 - dy1*dx2;
        if(Math.abs(denom)<1e-9) return null;
        const t=((p3.x-p1.x)*dy2-(p3.y-p1.y)*dx2)/denom;
        const u=((p3.x-p1.x)*dy1-(p3.y-p1.y)*dx1)/denom;
        if(t>1e-4&&t<1-1e-4&&u>1e-4&&u<1-1e-4)
          return {x:p1.x+t*dx1, y:p1.y+t*dy1};
        return null;
      };

      const wireSegs = (e) => {
        const segs = [];
        for(let i=0;i<e.pts.length-1;i++) segs.push([e.pts[i], e.pts[i+1]]);
        return segs;
      };

      for(let i=1; i<wireEntries.length; i++){
        const eI = wireEntries[i];
        if(eI.isPreview) continue;
        const color = eI.selected ? '#14c8c4' : (eI.value===1 ? '#1fae5c' : '#e0364a');
        const wireW = (eI.selected ? (this.wireWidth+0.8) : this.wireWidth) * this.zoom;
        const segsI = wireSegs(eI);

        for(let j=0; j<i; j++){
          const eJ = wireEntries[j];
          if(eJ.isPreview) continue;
          const colorJ = eJ.selected ? '#14c8c4' : (eJ.value===1 ? '#1fae5c' : '#e0364a');
          const wireWJ = (eJ.selected ? (this.wireWidth+0.8) : this.wireWidth) * this.zoom;
          const segsJ = wireSegs(eJ);

          for(const [a,b] of segsI){
            for(const [c,d] of segsJ){
              const pt = segIntersect(a,b,c,d);
              if(!pt) continue;

              // Determine which segment is more "horizontal"
              const iHoriz = Math.abs(b.y - a.y) < Math.abs(b.x - a.x);

              ctx.save();
              ctx.setLineDash([]);

              // 1. Erase under-wire gap
              ctx.fillStyle = '#ffffff';
              ctx.beginPath();
              if(iHoriz){
                ctx.rect(pt.x - GAP_HALF, pt.y - wireWJ*2.2, GAP_HALF*2, wireWJ*4.4);
              } else {
                ctx.rect(pt.x - wireWJ*2.2, pt.y - GAP_HALF, wireWJ*4.4, GAP_HALF*2);
              }
              ctx.fill();

              // 2. Redraw under-wire with butt caps (gap on each side)
              ctx.strokeStyle = colorJ;
              ctx.lineWidth   = wireWJ;
              ctx.lineCap     = 'butt';
              ctx.beginPath();
              if(iHoriz){
                ctx.moveTo(pt.x, pt.y - GAP_HALF - wireWJ*2); ctx.lineTo(pt.x, pt.y - GAP_HALF);
                ctx.moveTo(pt.x, pt.y + GAP_HALF); ctx.lineTo(pt.x, pt.y + GAP_HALF + wireWJ*2);
              } else {
                ctx.moveTo(pt.x - GAP_HALF - wireWJ*2, pt.y); ctx.lineTo(pt.x - GAP_HALF, pt.y);
                ctx.moveTo(pt.x + GAP_HALF, pt.y); ctx.lineTo(pt.x + GAP_HALF + wireWJ*2, pt.y);
              }
              ctx.stroke();

              // 3. Draw over-wire arch (smooth semicircle hop)
              ctx.strokeStyle = color;
              ctx.lineWidth   = wireW;
              ctx.lineCap     = 'round';
              ctx.lineJoin    = 'round';
              ctx.beginPath();
              if(iHoriz){
                // Horizontal wire hops over vertical — arch upward
                ctx.moveTo(pt.x - HOP_R - wireW, pt.y);
                ctx.lineTo(pt.x - HOP_R, pt.y);
                ctx.arc(pt.x, pt.y, HOP_R, Math.PI, 0, true);
                ctx.lineTo(pt.x + HOP_R + wireW, pt.y);
              } else {
                // Vertical wire hops over horizontal — arch rightward
                ctx.moveTo(pt.x, pt.y - HOP_R - wireW);
                ctx.lineTo(pt.x, pt.y - HOP_R);
                ctx.arc(pt.x, pt.y, HOP_R, -Math.PI/2, Math.PI/2, false);
                ctx.lineTo(pt.x, pt.y + HOP_R + wireW);
              }
              ctx.stroke();

              ctx.restore();
            }
          }
        }
      }
    }

    ctx.restore();
  }

  /** Helper: get world-space pin position from model (for routing). */
  _pinWorldPos(compId, pinId, model){
    const c = model.components.get(compId);
    if(!c) return null;
    const resolved = c.resolvePin(pinId);
    if(!resolved) return null;
    return c.pinWorldPos(resolved.pinDef, resolved.side);
  }

  /** Draw an orthogonal polyline path onto ctx with rounded corners.
   *  Each segment transition is rounded with a small arc for polished look. */
  _drawPath45(ctx, pts){
    if(!pts || pts.length < 2) return;
    const R = Math.min(WireRouter.CORNER_R * this.zoom, 8 * this.zoom);

    ctx.moveTo(pts[0].x, pts[0].y);
    for(let i = 1; i < pts.length - 1; i++){
      const prev = pts[i-1], cur = pts[i], next = pts[i+1];
      // Vector from cur to prev and cur to next
      const dx1 = prev.x - cur.x, dy1 = prev.y - cur.y;
      const dx2 = next.x - cur.x, dy2 = next.y - cur.y;
      const d1 = Math.sqrt(dx1*dx1+dy1*dy1), d2 = Math.sqrt(dx2*dx2+dy2*dy2);
      if(d1 < 1 || d2 < 1){ ctx.lineTo(cur.x, cur.y); continue; }
      const r = Math.min(R, d1*0.45, d2*0.45);
      // Tangent points
      const tx1 = cur.x + (dx1/d1)*r, ty1 = cur.y + (dy1/d1)*r;
      const tx2 = cur.x + (dx2/d2)*r, ty2 = cur.y + (dy2/d2)*r;
      ctx.lineTo(tx1, ty1);
      ctx.arcTo(cur.x, cur.y, tx2, ty2, r);
    }
    ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
  }

  _strokeWire45(ctx, pts, value, selected, isPreview){
    if(!pts || pts.length < 2) return;
    const color = isPreview
      ? 'rgba(30,95,204,0.65)'
      : (value===1 ? '#1fae5c' : (value===0 ? '#e0364a' : '#e0364a'));
    ctx.strokeStyle = selected ? '#14c8c4' : color;
    ctx.lineWidth = (selected
      ? (this.wireWidth + 1.0)
      : (isPreview ? Math.max(1.5, this.wireWidth - 0.5) : this.wireWidth)) * this.zoom;
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    if(isPreview) ctx.setLineDash([7, 5]); else ctx.setLineDash([]);
    ctx.beginPath();
    this._drawPath45(ctx, pts);
    ctx.stroke();

    // Draw junction dots at T-intersections (pin endpoints where multiple
    // wires share the exact same point)
    if(!isPreview){
      ctx.fillStyle = selected ? '#14c8c4' : color;
      const dotR = this.wireWidth * 1.1 * this.zoom;
      [pts[0], pts[pts.length-1]].forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR, 0, Math.PI*2);
        ctx.fill();
      });
    } else {
      // On preview: draw small corner dots at intermediate waypoints
      if(pts.length > 2){
        ctx.fillStyle = 'rgba(30,95,204,0.75)';
        const dotR = this.wireWidth * 0.9 * this.zoom;
        for(let i = 1; i < pts.length - 1; i++){
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, dotR, 0, Math.PI*2);
          ctx.fill();
        }
      }
    }
  }
}

