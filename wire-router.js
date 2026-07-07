// =========================================================================
// WIRE ROUTER — orthogonal (H/V only) electrical routing engine
// -------------------------------------------------------------------------
// Generates schematic-quality wire paths using only horizontal and vertical
// segments (no 45° diagonals). Routing strategy (in priority order):
//   1. Straight  — same X or Y: single segment.
//   2. L-shape   — two segments (H then V, or V then H), obstacle-free.
//   3. Bypass    — detour around an obstacle via waypoints using L-bends.
// =========================================================================
const WireRouter = {
  CLEARANCE: 0,    // obstacle rects = exact component borders (no padding)
  MARGIN: 8,       // minimum clearance wires keep from component borders when routing around them
  CORNER_R: 6,     // rounding radius for corners (world-px)
  GRID: 20,        // one grid tile

  // ── Stub-approach helpers ─────────────────────────────────────────────────
  // Every wire's final segment (entering a pin) must arrive parallel to the
  // gate's facing direction — i.e. perpendicular to the gate face. Without
  // this a wire from a nearby point can arrive at an oblique angle, visually
  // "cutting across" the pin cluster or filling the gap between adjacent pins.
  //
  // Strategy: for each endpoint we compute a STUB_LENGTH-deep approach point
  // that lives on the gate's axis of entry/exit.  The router runs from
  //   [far endpoint stub point] → ... → [near endpoint stub point]
  // and the actual pin positions are appended as the very first/last points
  // of the final screen-space array, so the path always ends on the dot.

  STUB_LENGTH: 16, // world-px — at least half a GRID tile; must be > pin spacing

  /**
   * Returns the unit vector that a wire must travel when *approaching* a pin.
   * For an input pin the wire arrives from outside the gate (opposite to the
   * gate's "output" facing direction); for an output pin it departs in the
   * gate's facing direction.
   *
   * Gate "output" faces right at rotation 0; inputs are on the left.
   * After rotation R:
   *   output facing: { dx: cos(R), dy: sin(R) }
   *   approach to INPUT (from outside, going right into the left face):
   *     same as output facing (wire moves left→right to enter a right-facing gate)
   *   approach FROM OUTPUT (wire departs in output direction):
   *     same as output facing
   * So the approach vector is always { cos(R), sin(R) }, regardless of side.
   * The stub start point sits STUB_LENGTH in the *opposite* direction from
   * the pin, so the wire arrives into the pin in the correct direction.
   */
  _pinApproachVec(rotation){
    const rad = ((rotation%360)+360)%360 * Math.PI / 180;
    return { dx: Math.cos(rad), dy: Math.sin(rad) };
  },

  /**
   * Returns the world-space stub entry/exit point for a pin: the point
   * STUB_LENGTH away from the pin center, on the gate's approach axis.
   * Routing should start/end here; the actual pin center is then appended
   * as the very last point of the final path.
   *
   * `side` is 'in' or 'out'.
   * For inputs:  the wire approaches FROM outside → stub sits to the left
   *              of the pin (in the gate's local frame), i.e. in the
   *              *negative* approach direction.
   * For outputs: the wire departs rightward → stub sits to the right of
   *              the pin, i.e. in the *positive* approach direction.
   */
  _pinStubPoint(comp, pinDef, side){
    const pinPos = comp.pinWorldPos(pinDef, side);
    const { dx, dy } = this._pinApproachVec(comp.rotation);
    // For a gate facing right (rotation=0, dx=1, dy=0):
    //   output pin is on the RIGHT edge → stub extends further RIGHT  → +dx
    //   input  pin is on the LEFT  edge → stub sits further LEFT      → -dx
    // sign: output = +1 (stub in the facing direction), input = -1 (stub opposite)
    const sign = side === 'out' ? 1 : -1;
    return {
      x: pinPos.x + sign * dx * this.STUB_LENGTH,
      y: pinPos.y + sign * dy * this.STUB_LENGTH,
    };
  },

  /**
   * Convenience: resolve a (compId, pinId) pair from the model and return
   * { pinPos, stubPos, side, pinDef }.  Returns null if not found.
   */
  _resolveStub(compId, pinId, model){
    const c = model.components.get(compId);
    if(!c) return null;
    const resolved = c.resolvePin(pinId);
    if(!resolved) return null;
    const { pinDef, side } = resolved;
    const pinPos  = c.pinWorldPos(pinDef, side);
    const stubPos = this._pinStubPoint(c, pinDef, side);
    return { pinPos, stubPos, side, pinDef };
  },

  /** Build the list of obstacle rectangles from the model, excluding the
   *  two components this wire connects — UNLESS both ends belong to the
   *  *same* component (pin-to-pin wiring within one gate). In that case the
   *  component's own body must stay an obstacle too, otherwise the router
   *  just draws the shortest line straight through the gap between the two
   *  pins. Keeping the body blocked forces the wire to loop out and around
   *  the component instead, which is the only routing style allowed for
   *  same-component connections. Each rect is the exact component bounding
   *  box — no extra clearance here; MARGIN is applied when generating
   *  bypass waypoints so wires hug just outside the border. */
  _obstacles(model, fromCompId, toCompId){
    const sameComp = fromCompId === toCompId;
    const rects = [];
    for(const c of model.components.values()){
      if(!sameComp && (c.id === fromCompId || c.id === toCompId)) continue;
      const s = c.renderedSize();
      rects.push({ x: c.x, y: c.y, w: s.w, h: s.h });
    }
    return rects;
  },

  /** Build small no-go rectangles that block the *whole strip* of edge each
   *  component's pins sit on — not just isolated boxes around each pin.
   *  Disconnected per-pin boxes left real gaps a thin wire could still
   *  thread through between two adjacent pins (e.g. on a 2-input gate
   *  where pins are spaced wider than one grid tile). Instead, for each
   *  side (input edge / output edge) that has 2+ pins, this builds ONE
   *  rect spanning from one tile above the topmost pin to one tile below
   *  the bottommost pin, hugging that edge — a solid wall with no seams.
   *  Sides with only one pin still get a single tile-sized box (nothing to
   *  span). The wire's own two endpoint pins are excluded by removing them
   *  from the per-side pin list *before* the strip's bounds are computed,
   *  so the strip shrinks/splits around them rather than swallowing them. */
  _pinObstacles(model, fromCompId, fromPinId, toCompId, toPinId){
    const rects = [];
    const half = this.GRID / 2;
    for(const c of model.components.values()){
      const def = c.def;
      const sides = [
        { side:'in',  pins: def.inputs },
        { side:'out', pins: def.outputs }
      ];
      for(const {side, pins} of sides){
        // Drop this wire's own endpoint pin from this side's list, if present.
        const isThisCompEndpoint = (c.id === fromCompId) || (c.id === toCompId);
        const keptPins = isThisCompEndpoint
          ? pins.filter(p => !((c.id===fromCompId && p.id===fromPinId) || (c.id===toCompId && p.id===toPinId)))
          : pins;
        if(keptPins.length === 0) continue;
        // Find contiguous runs of pins (by their position in the full pins
        // array) so excluding one pin in the middle splits the strip into
        // two separate solid walls rather than leaving a single rect that
        // incorrectly covers the excluded pin's own position too.
        let runStart = 0;
        for(let i=1;i<=pins.length;i++){
          const continued = i<pins.length && keptPins.includes(pins[i]) && keptPins.includes(pins[i-1]);
          if(continued) continue;
          // Close out the run [runStart, i-1] if it actually contains kept pins.
          const run = pins.slice(runStart, i).filter(p=>keptPins.includes(p));
          if(run.length){
            const worldPts = run.map(p => c.pinWorldPos(p, side));
            rects.push(this._stripRect(worldPts, half));
          }
          runStart = i;
        }
      }
    }
    return rects;
  },

  /** Given a list of world-space pin points all on the same straight edge,
   *  builds one axis-aligned rect covering from `half` tile-radius before
   *  the first point to `half` tile-radius past the last, hugging that
   *  edge — i.e. a solid strip with no internal seams. Works for any of
   *  the four axis-aligned rotations since pins on the same side always
   *  share either their x or their y coordinate. */
  _stripRect(pts, half){
    if(pts.length === 1){
      return { x: pts[0].x-half, y: pts[0].y-half, w: half*2, h: half*2 };
    }
    const xs = pts.map(p=>p.x), ys = pts.map(p=>p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    // Pins on the same side share one coordinate exactly (the edge) and
    // vary along the other (their spacing). Pad both axes by `half` so the
    // strip's short ends also keep a full tile of clearance past the
    // outermost pin, matching a single pin's own no-go box size.
    return { x: minX-half, y: minY-half, w: (maxX-minX)+half*2, h: (maxY-minY)+half*2 };
  },

  /** Expanded rect (with margin) used for intersection testing so wires
   *  keep MARGIN pixels clear of every component border. */
  _expand(r, m){
    return { x: r.x - m, y: r.y - m, w: r.w + m*2, h: r.h + m*2 };
  },

  /** True if segment (p1→p2) intersects rectangle r (expanded by margin). */
  _segIntersectsRect(p1, p2, r){
    const er = this._expand(r, this.MARGIN);
    const x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y;
    const rX=er.x,rY=er.y,rX2=er.x+er.w,rY2=er.y+er.h;
    const code = (x,y) =>
      (x<rX?1:0)|(x>rX2?2:0)|(y<rY?4:0)|(y>rY2?8:0);
    let c1=code(x1,y1), c2=code(x2,y2);
    if(!c1 && !c2) return true;
    if(c1 & c2) return false;
    let ax=x1,ay=y1,bx=x2,by=y2;
    for(let iter=0;iter<8;iter++){
      const cx=code(ax,ay), dx=code(bx,by);
      if(!cx && !dx) return true;
      if(cx & dx) return false;
      const out = cx||dx;
      let nx,ny;
      if(out&1){ ny=ay+(ay-by)*((rX-ax)/(ax-bx)||0); nx=rX; }
      else if(out&2){ ny=ay+(ay-by)*((rX2-ax)/(ax-bx)||0); nx=rX2; }
      else if(out&4){ nx=ax+(ax-bx)*((rY-ay)/(ay-by)||0); ny=rY; }
      else { nx=ax+(ax-bx)*((rY2-ay)/(ay-by)||0); ny=rY2; }
      if(out===cx){ ax=nx; ay=ny; } else { bx=nx; by=ny; }
    }
    return false;
  },

  /** True if any segment of the polyline path intersects any obstacle rect. */
  _pathClear(pts, rects){
    for(let i=0;i<pts.length-1;i++){
      for(const r of rects){
        if(this._segIntersectsRect(pts[i], pts[i+1], r)) return false;
      }
    }
    return true;
  },

  /**
   * Build a pure orthogonal (H/V) L-shaped path from `from` to `to`.
   *
   * prefer='H' → horizontal segment first, then vertical to dest (corner at {to.x, from.y})
   * prefer='V' → vertical segment first, then horizontal to dest (corner at {from.x, to.y})
   *
   * If already axis-aligned, returns just the two endpoints.
   */
  _makeLPath(from, to, prefer='H'){
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if(Math.abs(dx) < 0.5 || Math.abs(dy) < 0.5) return [from, to];
    if(prefer === 'H'){
      return [ from, { x: to.x, y: from.y }, to ];
    } else {
      return [ from, { x: from.x, y: to.y }, to ];
    }
  },

  /**
   * Main routing entry point.
   * Guarantees wires never pass through (or within MARGIN of) any obstacle.
   */
  route(from, to, rects){
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);

    // 1. Straight line — only if clear
    if(adx < 0.5 || ady < 0.5){
      if(this._pathClear([from, to], rects)) return [from, to];
      // straight but blocked — fall through to bypass
    }

    // 2. Try H-first and V-first L-shaped paths
    const pathH = this._makeLPath(from, to, 'H');
    const pathV = this._makeLPath(from, to, 'V');
    const hClear = this._pathClear(pathH, rects);
    const vClear = this._pathClear(pathV, rects);

    if(hClear && vClear) return dx >= 0 ? pathH : pathV;
    if(hClear) return pathH;
    if(vClear) return pathV;

    // 3. Bypass: generate candidate detour waypoints around each obstacle.
    // For each obstacle, generate 8 corner/midpoint bypass positions just
    // outside the expanded border, then try routing through each one.
    const M = this.MARGIN;
    const candidates = [];
    for(const r of rects){
      const x0 = r.x - M, y0 = r.y - M;
      const x1 = r.x + r.w + M, y1 = r.y + r.h + M;
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
      // 4 corners + 4 edge midpoints
      candidates.push({x:x0, y:y0}, {x:x1, y:y0}, {x:x0, y:y1}, {x:x1, y:y1});
      candidates.push({x:mx, y:y0}, {x:mx, y:y1}, {x:x0, y:my}, {x:x1, y:my});
      // Extra points offset further out to help with tight clusters
      candidates.push({x:x0-M, y:my}, {x:x1+M, y:my}, {x:mx, y:y0-M}, {x:mx, y:y1+M});
    }
    // Classic L-bend detours
    candidates.push({x:from.x, y:to.y}, {x:to.x, y:from.y});

    let bestPath = null, bestLen = Infinity;
    for(const wp of candidates){
      // Try both H and V approach for each waypoint
      for(const prefA of ['H','V']){
        for(const prefB of ['H','V']){
          const segA = this._makeLPath(from, wp, prefA);
          const segB = this._makeLPath(wp, to, prefB);
          const full = [...segA, ...segB.slice(1)];
          if(!this._pathClear(full, rects)) continue;
          const len = this._pathLength(full);
          if(len < bestLen){ bestLen = len; bestPath = full; }
        }
      }
    }
    if(bestPath) return bestPath;

    // 4. Two-waypoint bypass: try pairs of bypass candidates for more
    //    complex obstacle arrangements (e.g. wire must go around a corner)
    const topN = candidates.slice(0, 16); // limit for performance
    for(const wpA of topN){
      for(const wpB of topN){
        if(wpA === wpB) continue;
        const segA = this._makeLPath(from, wpA, 'H');
        const segM = this._makeLPath(wpA, wpB, 'H');
        const segB = this._makeLPath(wpB, to, 'H');
        const full = [...segA, ...segM.slice(1), ...segB.slice(1)];
        if(!this._pathClear(full, rects)) continue;
        const len = this._pathLength(full);
        if(len < bestLen){ bestLen = len; bestPath = full; }
      }
    }
    if(bestPath) return bestPath;

    // 5. Last resort — direct L path (rare: only if all obstacles are very tightly packed)
    return pathH;
  },

  _pathLength(pts){
    let len = 0;
    for(let i=0;i<pts.length-1;i++){
      const dx=pts[i+1].x-pts[i].x, dy=pts[i+1].y-pts[i].y;
      len += Math.sqrt(dx*dx+dy*dy);
    }
    return len;
  }
};

