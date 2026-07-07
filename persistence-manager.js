// =========================================================================
// 7. PERSISTENCE MANAGER (.ARLC files + LocalStorage autosave)
// -------------------------------------------------------------------------
// .ARLC is JSON-on-disk wrapped with a custom extension. Users only ever
// see ".arlc" files; internal structure is produced by CircuitModel.serialize().
// =========================================================================
const PersistenceManager = {
  AUTOSAVE_KEY: 'arclogic_autosave_v1',

  /** Triggers a browser download of the given snapshot as a .arlc file. */
  saveToFile(snapshot, filename){
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {type:'application/octet-stream'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // Strip any existing extension then append .arlc — never .json
    const base = (filename||'circuit').replace(/\.(arlc|json)(\.|$)/i, '').replace(/\.+$/, '');
    a.href = url; a.download = base + '.arlc';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
  /** Reads a File (from <input type=file>) and resolves with parsed JSON. */
  loadFromFile(file){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=>{
        try{ resolve(JSON.parse(reader.result)); }
        catch(e){ reject(e); }
      };
      reader.onerror = reject;
      reader.readAsText(file);
    });
  },
  autosave(snapshot){
    try{ localStorage.setItem(this.AUTOSAVE_KEY, JSON.stringify(snapshot)); }
    catch(e){ /* storage full or unavailable — fail silently, non-critical */ }
  },
  loadAutosave(){
    try{
      const raw = localStorage.getItem(this.AUTOSAVE_KEY);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  },
  /** Wipes the autosave slot (used by "Delete Design" so a cleared design
   *  doesn't silently reappear next time autosave is loaded). */
  clearAutosave(){
    try{ localStorage.removeItem(this.AUTOSAVE_KEY); }
    catch(e){ /* storage unavailable — non-critical */ }
  }
};

