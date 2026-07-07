// =========================================================================
// 6. HISTORY MANAGER (Undo / Redo)
// -------------------------------------------------------------------------
// Simple snapshot-based undo/redo. Given the modest component counts this
// app targets (hundreds, not tens of thousands), snapshotting serialized
// JSON is simple, robust, and fast enough, and avoids an entire class of
// command-pattern bugs. Snapshots are pushed on every "settled" user
// action (drag end, delete, paste, property edit, wire create/delete...).
// =========================================================================
class HistoryManager{
  constructor(getState, applyState, limit=100){
    this.getState = getState;     // () => serializable snapshot
    this.applyState = applyState; // (snapshot) => void, restores it
    this.undoStack = [];
    this.redoStack = [];
    this.limit = limit;
    this.suspended = false;
  }
  /** Call after any committed change to push a new undo checkpoint. */
  commit(){
    if(this.suspended) return;
    this.undoStack.push(this.getState());
    if(this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0; // new action invalidates redo history
  }
  undo(){
    if(this.undoStack.length < 2) return false; // need a prior state to revert to
    this.redoStack.push(this.undoStack.pop());
    this.applyState(Utils.clone(this.undoStack[this.undoStack.length-1]));
    return true;
  }
  redo(){
    if(this.redoStack.length===0) return false;
    const state = this.redoStack.pop();
    this.undoStack.push(state);
    this.applyState(Utils.clone(state));
    return true;
  }
  canUndo(){ return this.undoStack.length >= 2; }
  canRedo(){ return this.redoStack.length > 0; }
}

