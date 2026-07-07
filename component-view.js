// =========================================================================
// 9. COMPONENT VIEW
// -------------------------------------------------------------------------
// Creates and updates the DOM representation of one CircuitComponent inside
// #world. Pin elements are positioned in *local* (unrotated) space using
// CSS, then the whole .comp-node is rotated via CSS transform — simpler
// and cheaper than recomputing rotated pin DOM positions every frame.
// (Note: SimulationEngine/CanvasRenderer use the rotation-aware
// `pinWorldPos` on CircuitComponent for wire endpoints, which is the
// authoritative geometry; the DOM rotation here is purely visual and kept
// in sync with the same `rotation` value so they always agree.)
// =========================================================================
const ComponentView = {
  /** Builds a fresh DOM node for a component and appends it to `world`. */
  create(component, world){
    const node = document.createElement('div');
    node.className = 'comp-node';
    node.dataset.id = component.id;
    node.dataset.ctype = component.type;
    node.style.width = component.w+'px';
    node.style.height = component.h+'px';

    // Keep comp-label in DOM (hidden via CSS) so sync() still finds it
    const label = document.createElement('div');
    label.className = 'comp-label';
    node.appendChild(label);

    const body = document.createElement('div');
    const shapeMarkup = GateShapes[component.type];
    const def = GateLibrary[component.type];
    if(shapeMarkup){
      body.className = 'comp-body is-gate-shape';
      body.innerHTML = shapeMarkup;
    } else if(def && def.category === 'ic'){
      // MSI-style kits (MUX/DEMUX/DECODER/ENCODER/PRIORITYENC/BCDSEG) in
      // Block Diagram mode get their own distinct "chip" look — rectangular
      // corners with a pin-1 notch, like a real IC outline — instead of the
      // generic rounded switch/LED box, so a block-diagram kit reads as an
      // integrated circuit at a glance rather than looking like any other
      // component (see .comp-body.is-ic-shape in app-styles.css).
      body.className = 'comp-body is-ic-shape';
    } else {
      body.className = 'comp-body';
    }

    // Overlay: type name + user label, centered inside the body
    const overlay = document.createElement('div');
    overlay.className = 'gate-name-text';

    const typeName = document.createElement('span');
    typeName.className = 'gate-type-name';
    // Gate shapes and custom-visual types don't show a text label in the body
    const isOutputOnly = def && def.category === 'output';
    const hasCustomVisual = (component.type === 'SWITCH' || component.type === 'VARIABLE' || component.type === 'NODE' || component.type === 'TEXT');
    if(!isOutputOnly && !hasCustomVisual){
      typeName.textContent = def ? def.label : component.type;
      // Per-gate interior centering: shift overlay so text aligns with actual body interior.
      // interiorX = [leftX, rightX] in 0..100 viewBox units.
      const interiorX = {AND:[8,94],NAND:[8,86],OR:[22,98],NOR:[22,85],XOR:[28,98],XNOR:[28,85],NOT:[10,82],BUFFER:[10,92]};
      const [lx,rx] = interiorX[component.type] || [8,94];
      const interiorCenterPct = (lx+rx)/2; // % of 100-unit box
      // shift from 50% center as a % of component width
      const shiftPct = (interiorCenterPct - 50);
      const interiorWidthPx = (rx-lx)*(component.w/100);
      const labelStr = def ? def.label : component.type;
      // Full multi-word names (e.g. "Priority Encoder") wrap onto their own
      // lines instead of being squeezed onto one — fit font size to the
      // longest individual word rather than the whole string, and let the
      // span wrap at its natural word boundaries within the interior width.
      const hasSpace = labelStr.indexOf(' ') !== -1;
      const widthBasis = hasSpace ? Math.max(...labelStr.split(' ').map(w=>w.length)) : labelStr.length;
      // Font size to fit within 82% of interior width
      const maxFs = Math.floor((interiorWidthPx*0.82)/(widthBasis*0.65));
      const fs = Math.max(7, Math.min(maxFs, 11));
      typeName.style.fontSize = fs+'px';
      if(hasSpace){
        typeName.style.whiteSpace = 'normal';
        typeName.style.width = interiorWidthPx+'px';
        typeName.style.lineHeight = '1.15';
      }
      if(Math.abs(shiftPct) > 1){
        overlay.style.paddingLeft = (shiftPct > 0 ? shiftPct*2 : 0) + '%';
        overlay.style.paddingRight = (shiftPct < 0 ? -shiftPct*2 : 0) + '%';
      }
    }
    overlay.appendChild(typeName);

    const userLbl = document.createElement('span');
    userLbl.className = 'gate-user-label';
    overlay.appendChild(userLbl);

    body.appendChild(overlay);

    // "Full Circuit" x-ray view (KIT_NETLISTS types only): a hidden-by-
    // default overlay holding the internal gate schematic, toggled on in
    // sync() when component.viewMode === 'circuit'. Built once per type
    // (see _kitInternalSVG's cache) then just shown/hidden per instance.
    if(KIT_NETLISTS[component.type]){
      const kitWrap = document.createElement('div');
      kitWrap.className = 'kit-internal-wrap';
      kitWrap.style.cssText = 'position:absolute;inset:0;display:none;';
      body.appendChild(kitWrap);
    }

    node.appendChild(body);

    // Special visuals per type
    if(component.type === 'LED'){
      const bulb = document.createElement('div');
      bulb.className = 'led-bulb';
      bulb.style.cssText = [
        'position:relative;z-index:1;width:56%;height:56%;border-radius:50%;',
        'background:radial-gradient(circle at 36% 33%,#d4d9e2 0%,#8a93a1 60%,#636c78 100%);',
        'box-shadow:0 0 0 3px rgba(138,147,161,0.15),inset 0 2px 4px rgba(255,255,255,0.5),inset 0 -2px 4px rgba(0,0,0,0.2);',
        'transition:background .18s ease,box-shadow .18s ease;'
      ].join('');
      body.appendChild(bulb);
    }
    if(component.type === 'PROBE'){
      const pv = document.createElement('div');
      pv.className = 'probe-value';
      pv.style.cssText = 'position:relative;z-index:1;font-weight:900;font-size:18px;color:var(--c-navy);line-height:1;';
      pv.textContent = 'X';
      body.appendChild(pv);
    }
    if(component.type === 'NODE'){
      // NODE renders as a single junction dot — transparent body, one SVG circle
      // centered in the tiny footprint. The real .pin-in/.pin-out hit-targets
      // are positioned on top of it but made visually invisible (see CSS),
      // so it reads as one connection point even though two pins exist
      // underneath for wiring purposes. Styled to read as a proper
      // connection point (white ring + soft shadow, like a real pin) rather
      // than a flat dot, so it's clearly identifiable as a wireable joint.
      body.style.cssText = [
        'background:transparent;border:none;box-shadow:none;border-radius:0;',
        'display:flex;align-items:center;justify-content:center;',
      ].join('');
      body.innerHTML = `<svg viewBox="0 0 16 16" width="100%" height="100%" overflow="visible" style="display:block;overflow:visible;filter:drop-shadow(0 1px 2px rgba(15,42,74,0.35));">
        <circle class="node-dot" cx="8" cy="8" r="6.5" fill="#0f2a4a" stroke="#ffffff" stroke-width="2.25"/>
      </svg>`;
    }
    if(component.type === 'TEXT'){
      // Free-floating label: transparent body (no border/background), just
      // the text itself. A faint dashed outline shows on hover/selection
      // only, so it's easy to find and grab but doesn't clutter the design.
      body.classList.add('is-text-shape');
      const fontSize = (component.state && component.state.fontSize) || 18;
      const txt = document.createElement('div');
      txt.className = 'text-el-content';
      txt.style.fontSize = fontSize + 'px';
      txt.textContent = (component.state && component.state.text) || 'Text';
      body.appendChild(txt);
    }
    if(component.type === 'SEVENSEG'){
      body.style.background = 'linear-gradient(160deg,#ffffff 0%,#f0f4f8 100%)';
      body.style.borderColor = '#c8d4e0';
      body.style.boxShadow = 'inset 0 1px 0 rgba(255,255,255,0.90), 0 2px 6px rgba(0,0,0,0.08)';
      body.style.display = 'flex';
      body.style.flexDirection = 'column';
      body.style.alignItems = 'center';
      body.style.justifyContent = 'flex-start';
      body.style.paddingTop = '6px';
      const svgWrap = document.createElement('div');
      svgWrap.style.cssText = 'position:relative;z-index:1;width:62%;height:72%;pointer-events:none;flex-shrink:0;';
      svgWrap.innerHTML = `<svg viewBox="0 0 32 56" width="100%" height="100%" class="sevenseg-svg">
        <polygon class="seg seg-a" points="8,2 24,2 27,5 24,8 8,8 5,5"/>
        <polygon class="seg seg-f" points="3,7 6,10 6,25 3,28 0,25 0,10"/>
        <polygon class="seg seg-b" points="29,7 32,10 32,25 29,28 26,25 26,10"/>
        <polygon class="seg seg-g" points="8,27 24,27 27,30 24,33 8,33 5,30"/>
        <polygon class="seg seg-e" points="3,29 6,32 6,47 3,50 0,47 0,32"/>
        <polygon class="seg seg-c" points="29,29 32,32 32,47 29,50 26,47 26,32"/>
        <polygon class="seg seg-d" points="8,49 24,49 27,52 24,55 8,55 5,52"/>
      </svg>`;
      body.appendChild(svgWrap);
      // Internal label at bottom, below segments
      const intLbl = document.createElement('div');
      intLbl.className = 'sevenseg-int-label';
      body.appendChild(intLbl);
    }
    if(component.type === 'BCDSEG'){
      // Left half: chip label + input pin labels A B C D
      // Right half: 7-segment display face showing decoded digit
      body.style.background = 'linear-gradient(160deg,#ffffff 0%,#f0f4f8 100%)';
      body.style.borderColor = '#c8d4e0';
      body.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08), inset 0 1px 0 rgba(255,255,255,0.90)';
      body.style.display = 'flex';
      body.style.alignItems = 'center';
      body.style.justifyContent = 'space-around';
      body.style.padding = '0 4px';

      // Left: chip label + BCD bit labels
      const chipLabel = document.createElement('div');
      chipLabel.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:1px;pointer-events:none;';
      chipLabel.innerHTML = `
        <div style="font-weight:900;font-size:9px;color:#14c8c4;letter-spacing:0.06em;font-family:monospace;margin-bottom:3px;">BCD</div>
        <div style="font-size:8px;font-weight:800;color:#1a3a5c;font-family:monospace;line-height:1.7;">A</div>
        <div style="font-size:8px;font-weight:800;color:#1a3a5c;font-family:monospace;line-height:1.7;">B</div>
        <div style="font-size:8px;font-weight:800;color:#1a3a5c;font-family:monospace;line-height:1.7;">C</div>
        <div style="font-size:8px;font-weight:800;color:#1a3a5c;font-family:monospace;line-height:1.7;">D</div>
      `;
      body.appendChild(chipLabel);

      // Right: 7-segment display face (same hexagon-segment SVG as SEVENSEG)
      const bcdSvgWrap = document.createElement('div');
      bcdSvgWrap.style.cssText = 'position:relative;z-index:1;width:34%;height:80%;pointer-events:none;flex-shrink:0;';
      bcdSvgWrap.innerHTML = `<svg viewBox="0 0 32 56" width="100%" height="100%" class="bcdseg-display">
        <polygon class="seg seg-a" points="8,2 24,2 27,5 24,8 8,8 5,5"/>
        <polygon class="seg seg-f" points="3,7 6,10 6,25 3,28 0,25 0,10"/>
        <polygon class="seg seg-b" points="29,7 32,10 32,25 29,28 26,25 26,10"/>
        <polygon class="seg seg-g" points="8,27 24,27 27,30 24,33 8,33 5,30"/>
        <polygon class="seg seg-e" points="3,29 6,32 6,47 3,50 0,47 0,32"/>
        <polygon class="seg seg-c" points="29,29 32,32 32,47 29,50 26,47 26,32"/>
        <polygon class="seg seg-d" points="8,49 24,49 27,52 24,55 8,55 5,52"/>
      </svg>`;
      body.appendChild(bcdSvgWrap);

      // Internal label at bottom of body
      const intLblB = document.createElement('div');
      intLblB.className = 'sevenseg-int-label';
      body.appendChild(intLblB);
    }
    if(component.type === 'SWITCH'){
      // Ensure comp-body has a light style
      body.style.background = 'linear-gradient(160deg,#f8fafc 0%,#edf1f7 100%)';
      body.style.borderColor = '#c0cad8';
      // iOS-style track + sliding thumb
      const track = document.createElement('div');
      track.className = 'sw-track';
      const thumb = document.createElement('div');
      thumb.className = 'sw-thumb';
      // Set explicit px size so translate math works: track height is ~50% of comp h
      const thumbSize = Math.round(component.h * 0.50 * 0.82); // ~82% of track height
      thumb.style.width  = thumbSize + 'px';
      thumb.style.height = thumbSize + 'px';
      thumb.style.fontSize = Math.max(6, Math.round(thumbSize * 0.44)) + 'px';
      track.appendChild(thumb);
      body.appendChild(track);
      // Link badge: shown below track when this switch is linked to another
      const badge = document.createElement('div');
      badge.className = 'sw-link-badge';
      body.appendChild(badge);
    }
    if(component.type === 'VARIABLE'){
      body.classList.add('var-body');
      const varWrap = document.createElement('div');
      varWrap.style.cssText = 'position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:3px;pointer-events:none;';
      const varLetter = document.createElement('div');
      varLetter.className = 'var-letter';
      varLetter.textContent = component.label || '?';
      const varRing = document.createElement('div');
      varRing.className = 'var-state-ring';
      varWrap.appendChild(varLetter);
      varWrap.appendChild(varRing);
      body.appendChild(varWrap);
    }
    // External below-body custom-name label — every type gets one except
    // VARIABLE (shows its letter directly in the body) and SEVENSEG/BCDSEG
    // (already show the custom name inside, under the segments).
    if(component.type !== 'VARIABLE' && component.type !== 'SEVENSEG' && component.type !== 'BCDSEG' && component.type !== 'TEXT'){
      const extLbl = document.createElement('div');
      extLbl.className = 'comp-ext-label';
      node.appendChild(extLbl);
    }

    // Render pins (input pins on local-left edge, output pins on local-right edge)
    // Full Circuit x-ray view (kits): the real pin is pulled in from the raw
    // edge (see CircuitComponent.pinWorldPos, KIT_PIN_INSET) so it lands
    // inside the board instead of straddling its thick decorative border.
    const isKitCircuit = component.viewMode === 'circuit' && KIT_NETLISTS[component.type];
    component.def.inputs.forEach(p=>{
      const pin = document.createElement('div');
      pin.className = 'pin pin-in';
      pin.dataset.pinId = p.id; pin.dataset.side='in';
      pin.style.left = isKitCircuit ? (KIT_PIN_INSET-5)+'px' : '-5px';
      pin.style.top = (p.dy*100)+'%';
      pin.style.transform = 'translateY(-50%)';
      node.appendChild(pin);
    });
    component.def.outputs.forEach(p=>{
      const pin = document.createElement('div');
      pin.className = 'pin pin-out';
      pin.dataset.pinId = p.id; pin.dataset.side='out';
      pin.style.left = isKitCircuit ? `calc(100% - ${KIT_PIN_INSET+5}px)` : 'calc(100% - 5px)';
      pin.style.top = (p.dy*100)+'%';
      pin.style.transform = 'translateY(-50%)';
      node.appendChild(pin);
    });

    // IC-style components (MUX/DEMUX/DECODER/ENCODER/PRIORITYENC, and any
    // future 'ic'-category type) have differently-named pins on the same
    // side — unlike AND/OR's interchangeable a/b — so each pin gets its
    // id printed right beside it, inside the body, to say which is which.
    if(def && def.category === 'ic'){
      component.def.inputs.forEach(p=>{
        const lbl = document.createElement('div');
        lbl.className = 'pin-io-label pin-io-label-in';
        lbl.textContent = p.id.toUpperCase();
        lbl.style.top = (p.dy*100)+'%';
        node.appendChild(lbl);
      });
      component.def.outputs.forEach(p=>{
        const lbl = document.createElement('div');
        lbl.className = 'pin-io-label pin-io-label-out';
        lbl.textContent = p.id.toUpperCase();
        lbl.style.top = (p.dy*100)+'%';
        node.appendChild(lbl);
      });
    }

    world.appendChild(node);
    this.sync(component, node);
    return node;
  },
  /** Syncs a node's position/rotation/selection/value-driven visuals to
   *  match its CircuitComponent's current state. Cheap — call every frame
   *  for components that may have changed (or all, since count is modest). */
  sync(component, node){
    node.style.left = component.x+'px';
    node.style.top = component.y+'px';
    const flipX = component._flipX ? 'scaleX(-1)' : '';
    const flipY = component._flipY ? 'scaleY(-1)' : '';
    node.style.transform = `rotate(${component.rotation}deg) ${flipX} ${flipY}`.trim();
    node.classList.toggle('selected', !!component._selected);
    node.classList.toggle('convert-eligible', !!component._convertEligible);

    // VARIABLE: body width is auto-widened for longer custom names by
    // CircuitComponent.get def() (component.w reads from it). Height never
    // changes. Just push the current value onto the node here.
    if(component.type === 'VARIABLE'){
      node.style.width = component.w + 'px';
    }

    // Kit "Full Circuit" view: resize the node to the enlarged def (see
    // CircuitComponent.def), show the internal-schematic overlay in place
    // of the plain type-name label, and lazily build its SVG on first show.
    if(KIT_NETLISTS[component.type]){
      node.style.width = component.w + 'px';
      node.style.height = component.h + 'px';
      const isCircuit = component.viewMode === 'circuit';
      node.classList.toggle('kit-circuit-view', isCircuit);
      const wrap = node.querySelector('.kit-internal-wrap');
      const nameOverlay = node.querySelector('.gate-name-text');
      if(wrap){
        wrap.style.display = isCircuit ? 'block' : 'none';
        if(isCircuit && !wrap.dataset.built){
          wrap.innerHTML = _kitInternalSVG(component.type, GateLibrary[component.type]);
          wrap.dataset.built = '1';
        }
      }
      if(nameOverlay) nameOverlay.style.display = isCircuit ? 'none' : '';
    }

    // TEXT: box auto-fits the current text + font size (see `def` getter).
    // Push the live text/fontSize onto the node here so editing in the
    // Properties panel (or finishing an in-place edit) reflows immediately.
    if(component.type === 'TEXT'){
      node.style.width = component.w + 'px';
      node.style.height = component.h + 'px';
      const txt = node.querySelector('.text-el-content');
      if(txt && !txt.isContentEditable){
        const fontSize = (component.state && component.state.fontSize) || 18;
        txt.style.fontSize = fontSize + 'px';
        txt.textContent = (component.state && component.state.text) || 'Text';
      }
    }

    // In-body custom-name overlay is retired in favor of the below-body
    // .comp-ext-label (see create() and the block right after this one) —
    // this element now only ever shows the default gate type name (AND,
    // OR, ...), which is set once at creation and never changes, so it's
    // left empty here unconditionally.
    const userLbl = node.querySelector('.gate-user-label');
    if(userLbl){
      userLbl.textContent = '';
      userLbl.classList.remove('has-label');
    }
    // External below-body name label — every type except VARIABLE (shows
    // its letter directly) and SEVENSEG/BCDSEG (name already shown inside,
    // under the segments).
    if(component.type !== 'VARIABLE' && component.type !== 'SEVENSEG' && component.type !== 'BCDSEG'){
      const extLbl = node.querySelector('.comp-ext-label');
      if(extLbl){
        const defaultLabel = GateLibrary[component.type] ? GateLibrary[component.type].label : component.type;
        const custom = (component.label && component.label !== defaultLabel) ? component.label.trim() : '';
        extLbl.textContent = custom;
        extLbl.classList.toggle('has-label', custom.length > 0);
      }
    }
    // External label for SEVENSEG / BCDSEG — sits below the body, never overlaps segments
    if(component.type === 'SEVENSEG' || component.type === 'BCDSEG'){
      const extLbl = node.querySelector('.sevenseg-int-label');
      if(extLbl){
        const defaultLabel = GateLibrary[component.type] ? GateLibrary[component.type].label : component.type;
        const custom = (component.label && component.label !== defaultLabel) ? component.label.trim() : '';
        extLbl.textContent = custom;
        extLbl.classList.toggle('has-label', custom.length > 0);
      }
    }

    // Pin visual state (HIGH/LOW/floating) based on resolved values
    component.def.inputs.forEach((p,idx)=>{
      const el = node.querySelector(`.pin-in[data-pin-id="${p.id}"]`);
      if(el) this._applyPinClass(el, component.inputValues ? component.inputValues[idx] : null);
    });
    component.def.outputs.forEach((p,idx)=>{
      const el = node.querySelector(`.pin-out[data-pin-id="${p.id}"]`);
      if(el) this._applyPinClass(el, component.outputValues ? component.outputValues[idx] : null);
    });

    if(component.type==='LED'){
      const bulb = node.querySelector('.led-bulb');
      const v = component.inputValues && component.inputValues[0];
      if(bulb){
        if(v===1){
          bulb.style.background = 'radial-gradient(circle at 36% 30%,#80ffb0 0%,#1fae5c 50%,#0d7a3a 100%)';
          bulb.style.boxShadow = '0 0 18px 6px rgba(31,174,92,0.55),0 0 6px 2px rgba(31,174,92,0.85),inset 0 2px 5px rgba(255,255,255,0.6),inset 0 -2px 4px rgba(0,0,0,0.12)';
        } else {
          bulb.style.background = 'radial-gradient(circle at 36% 30%,#ffaabd 0%,#e0364a 50%,#9e1a2a 100%)';
          bulb.style.boxShadow = '0 0 14px 5px rgba(224,54,74,0.48),0 0 5px 2px rgba(224,54,74,0.75),inset 0 2px 5px rgba(255,255,255,0.5),inset 0 -2px 4px rgba(0,0,0,0.18)';
        }
      }
    }
    if(component.type==='PROBE'){
      const pv = node.querySelector('.probe-value');
      const v = component.inputValues && component.inputValues[0];
      if(pv) pv.textContent = v===1?'1':v===0?'0':'X';
    }
    if(component.type==='NODE'){
      const v = component.inputValues && component.inputValues[0];
      const color = v===1 ? '#1fae5c' : v===0 ? '#e0364a' : '#0f2a4a';
      const glow = v===1 ? 'rgba(31,174,92,0.55)' : v===0 ? 'rgba(224,54,74,0.55)' : 'rgba(15,42,74,0.35)';
      const dot = node.querySelector('.node-dot');
      if(dot) dot.setAttribute('fill', color);
      const svg = node.querySelector('svg');
      if(svg) svg.style.filter = `drop-shadow(0 0 3px ${glow})`;
    }
    if(component.type==='SEVENSEG'){
      const svg = node.querySelector('.sevenseg-svg');
      if(svg){
        const colorMap = {
          green:  { lit:'#00ff6a', unlit:'#d4ead9' },
          red:    { lit:'#ff2020', unlit:'#ead4d4' },
          blue:   { lit:'#3a8fff', unlit:'#d4dcea' },
          yellow: { lit:'#ffe600', unlit:'#eae9d4' },
          orange: { lit:'#ff8c00', unlit:'#eaddd4' },
          white:  { lit:'#ffffff', unlit:'#e8eaed' },
        };
        const col = colorMap[(component.state&&component.state.segColor)||'green'];
        ['a','b','c','d','e','f','g'].forEach((seg,idx)=>{
          const v = component.inputValues ? component.inputValues[idx] : null;
          const el = svg.querySelector('.seg-'+seg);
          if(el){
            el.classList.toggle('lit', v===1);
            el.style.fill = v===1 ? col.lit : col.unlit;
          }
        });
      }
    }
    if(component.type==='BCDSEG'){
      // Drive the 7-seg face from the component's computed output values (a-g)
      const svg = node.querySelector('.bcdseg-display');
      if(svg){
        const colorMap = {
          green:  { lit:'#00ff6a', unlit:'#d4ead9' },
          red:    { lit:'#ff2020', unlit:'#ead4d4' },
          blue:   { lit:'#3a8fff', unlit:'#d4dcea' },
          yellow: { lit:'#ffe600', unlit:'#eae9d4' },
          orange: { lit:'#ff8c00', unlit:'#eaddd4' },
          white:  { lit:'#ffffff', unlit:'#e8eaed' },
        };
        const col = colorMap[(component.state&&component.state.segColor)||'green'];
        ['a','b','c','d','e','f','g'].forEach((seg,idx)=>{
          const v = component.outputValues ? component.outputValues[idx] : null;
          const el = svg.querySelector('.seg-'+seg);
          if(el){
            el.classList.toggle('lit', v===1);
            el.style.fill = v===1 ? col.lit : col.unlit;
          }
        });
      }
    }
    if(component.type==='SWITCH'){
      const track  = node.querySelector('.sw-track');
      const thumb  = node.querySelector('.sw-thumb');
      const body2  = node.querySelector('.comp-body');
      const swVal  = component.state ? component.state.value : null;
      const isNeutral = swVal === null;
      const isOn   = swVal === true;
      if(track){
        track.style.background = isNeutral
          ? 'linear-gradient(90deg,#9aa3b0 0%,#c4cbd4 100%)'
          : isOn
            ? 'linear-gradient(90deg,#16a556 0%,#22d468 100%)'
            : 'linear-gradient(90deg,#c41f35 0%,#e0364a 100%)';
        track.style.boxShadow = isNeutral
          ? 'inset 0 2px 4px rgba(30,40,60,0.15),inset 0 -1px 2px rgba(255,255,255,0.2)'
          : isOn
            ? 'inset 0 2px 4px rgba(0,60,20,0.22),inset 0 -1px 2px rgba(255,255,255,0.2)'
            : 'inset 0 2px 4px rgba(70,0,10,0.22),inset 0 -1px 2px rgba(255,255,255,0.2)';
      }
      if(thumb){
        const thumbEl = thumb;
        const thumbPx = parseInt(thumbEl.style.width) || 18;
        if(isNeutral){
          // Center position for neutral
          const trackW = Math.round(component.w * 0.80);
          const travel = Math.round((trackW - thumbPx - 6) / 2);
          thumbEl.style.transform = `translateX(${travel}px)`;
          thumbEl.style.color = '#6b7789';
          thumbEl.textContent = '?';
        } else if(isOn){
          const trackW = Math.round(component.w * 0.80);
          const travel = trackW - thumbPx - 6;
          thumbEl.style.transform = `translateX(${travel}px)`;
          thumbEl.style.color = '#1fae5c';
          thumbEl.textContent = '1';
        } else {
          thumbEl.style.transform = 'translateX(0)';
          thumbEl.style.color = '#c4243a';
          thumbEl.textContent = '0';
        }
      }
      // Link badge: show ↔ <sourceName> when this switch has a linkGroup
      const badge = node.querySelector('.sw-link-badge');
      if(badge){
        const linkedName = component.linkGroup ? (component.linkedSourceName || null) : null;
        if(linkedName){
          badge.textContent = '↔ ' + linkedName;
          badge.classList.add('visible');
        } else if(component.linkGroup){
          // Has a link group but no source name stored — show a chain icon only
          badge.textContent = '↔';
          badge.classList.add('visible');
        } else {
          badge.textContent = '';
          badge.classList.remove('visible');
        }
      }
    }
    if(component.type==='HIGH'){
      const bodyH = node.querySelector('.comp-body');
      const nameH = node.querySelector('.gate-type-name');
      if(bodyH){
        bodyH.style.borderColor = '#14893f';
        bodyH.style.background = 'linear-gradient(160deg,#d9f7e4 0%,#9fe8bb 100%)';
      }
      if(nameH) nameH.style.color = '#0d6b30';
    }
    if(component.type==='LOW'){
      const bodyL = node.querySelector('.comp-body');
      const nameL = node.querySelector('.gate-type-name');
      if(bodyL){
        bodyL.style.borderColor = '#c8273c';
        bodyL.style.background = 'linear-gradient(160deg,#ffe2e6 0%,#ffb9c2 100%)';
      }
      if(nameL) nameL.style.color = '#9e1a2a';
    }
    if(component.type==='VARIABLE'){
      const varLetter = node.querySelector('.var-letter');
      const varRing   = node.querySelector('.var-state-ring');
      const body3     = node.querySelector('.comp-body');
      // Always show the current label (auto-name or user-edited)
      if(varLetter) varLetter.textContent = (component.label || '?').toUpperCase();
      const varVal    = component.state ? component.state.value : null;
      const isNeutral = varVal === null;
      const isOn      = varVal === true;
      if(body3){
        body3.classList.remove('var-on','var-off','var-neutral');
      }
      if(varRing){
        varRing.style.background = isNeutral ? '#9aa3b0'
          : isOn ? '#1fae5c' : '#e0364a';
        varRing.style.boxShadow  = isNeutral ? '0 0 4px 1px rgba(100,110,130,0.4)'
          : isOn ? '0 0 6px 2px rgba(31,174,92,0.5)' : '0 0 6px 2px rgba(224,54,74,0.5)';
      }
    }
  },
  _applyPinClass(el, value){
    el.classList.remove('pin-high','pin-low','pin-float');
    el.classList.add(value===1?'pin-high':value===0?'pin-low':'pin-float');
  },
  remove(node){ node.remove(); }
};

