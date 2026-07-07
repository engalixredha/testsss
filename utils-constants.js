/* =====================================================================================
   JAVASCRIPT ARCHITECTURE
   =====================================================================================
   Modules in this file (in load order):

     1. Utils              - geometry/grid/id helpers
     2. GateLibrary         - registry of all component "types" + their pin layouts and
                               evaluate() functions. [EXTENSION POINT] for future gates.
     3. Data Model           - Component, Wire classes (pure data + light geometry helpers)
     4. CircuitModel          - owns all components/wires, adjacency, serialization
     5. SimulationEngine       - topological evaluation of the whole circuit
     6. HistoryManager          - undo/redo via state snapshots
     7. PersistenceManager       - .ARLC save/open + localStorage autosave
     8. CanvasRenderer            - draws grid, wires, selection overlays
     9. ComponentView              - creates/syncs the DOM node for one component
    10. SelectionManager             - tracks selected components/wires
    11. InputController               - mouse/keyboard/drag/pan/zoom/wiring interactions
    12. UIController                   - toolbar buttons, properties panel, status bar
    13. App                             - boot: wires all modules together
   ===================================================================================== */

// =========================================================================
// 1. UTILS
// Small stateless helpers used throughout. No dependencies on app state.
// =========================================================================
const Utils = {
  /** Generates a short, unique-enough id for components/wires. */
  uid(prefix){
    return prefix + '_' + Math.random().toString(36).slice(2,9) + Date.now().toString(36).slice(-4);
  },
  /** Snaps a coordinate value to the nearest grid line. */
  snap(value, gridSize){
    return Math.round(value / gridSize) * gridSize;
  },
  /** Clamps a number between min and max. */
  clamp(v, min, max){ return Math.max(min, Math.min(max, v)); },
  /** Distance between two points. */
  dist(x1,y1,x2,y2){ return Math.hypot(x2-x1, y2-y1); },
  /** Shortest distance from point (px,py) to the segment a→b (each {x,y}). */
  distToSegment(px, py, a, b){
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx*dx + dy*dy;
    let t = lenSq < 1e-9 ? 0 : ((px - a.x)*dx + (py - a.y)*dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t*dx, cy = a.y + t*dy;
    return Math.hypot(px - cx, py - cy);
  },
  /** Deep clone via JSON (sufficient for our plain-data model). */
  clone(obj){ return JSON.parse(JSON.stringify(obj)); }
};

