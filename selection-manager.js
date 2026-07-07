// =========================================================================
// 10. SELECTION MANAGER
// =========================================================================
class SelectionManager{
  constructor(){ this.selectedComponents = new Set(); this.selectedWires = new Set(); this.selectedTruthTables = new Set(); this.selectedKMaps = new Set(); }
  clear(){ this.selectedComponents.clear(); this.selectedWires.clear(); this.selectedTruthTables.clear(); this.selectedKMaps.clear(); }
  selectOnly(compIds=[], wireIds=[], ttIds=[], kmIds=[]){ this.clear(); compIds.forEach(id=>this.selectedComponents.add(id)); wireIds.forEach(id=>this.selectedWires.add(id)); ttIds.forEach(id=>this.selectedTruthTables.add(id)); kmIds.forEach(id=>this.selectedKMaps.add(id)); }
  toggle(id, isWire){ const set = isWire?this.selectedWires:this.selectedComponents; set.has(id)?set.delete(id):set.add(id); }
  add(id, isWire){ (isWire?this.selectedWires:this.selectedComponents).add(id); }
  isEmpty(){ return this.selectedComponents.size===0 && this.selectedWires.size===0 && this.selectedTruthTables.size===0 && this.selectedKMaps.size===0; }
  count(){ return this.selectedComponents.size + this.selectedWires.size + this.selectedTruthTables.size + this.selectedKMaps.size; }
}

