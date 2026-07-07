const ExportPreview = {
  _model: null,
  _filename: 'circuit',
  _activeFormat: 'png',

  open(model, filename, fmt='png'){
    this._model = model;
    this._filename = filename;
    this._activeFormat = fmt;
    document.getElementById('export-dialog-title').textContent = `Export Circuit`;
    document.querySelectorAll('.exp-dl-btn').forEach(b=>{
      b.style.background = b.dataset.fmt === fmt ? '#0f2a4a' : '#1e5fcc';
    });
    document.getElementById('export-overlay').style.display = 'flex';
    this._refreshPreview();
  },

  _getOpts(){
    return {
      showLabels:  document.getElementById('exp-show-labels').checked,
      showPins:    document.getElementById('exp-show-pins').checked,
      showGrid:    document.getElementById('exp-show-grid').checked,
      wireColor:   document.getElementById('exp-show-wire-color').checked,
      switchMode:  document.querySelector('input[name="exp-switch-mode"]:checked')?.value || 'state',
      transparent: document.querySelector('input[name="exp-bg"]:checked')?.value === 'transparent',
    };
  },

  async _refreshPreview(){
    const status = document.getElementById('exp-preview-status');
    status.textContent = 'Rendering…';
    try{
      const opts = this._getOpts();
      const cvs = await ExportEngine._buildCanvas(this._model, 1.5, opts);
      const previewCanvas = document.getElementById('export-preview-canvas');
      previewCanvas.width  = cvs.width;
      previewCanvas.height = cvs.height;
      previewCanvas.getContext('2d').drawImage(cvs, 0, 0);
      const {w, h} = {w: Math.round(cvs.width/1.5), h: Math.round(cvs.height/1.5)};
      status.textContent = `Preview · ${w} × ${h} px (at 1× — export at 2×)`;
    }catch(err){
      status.textContent = 'Preview error — ' + err.message;
    }
  },

  async _download(fmt){
    const opts = this._getOpts();
    const fn = this._filename;
    document.querySelectorAll('.exp-dl-btn').forEach(b=> b.disabled = true);
    try{
      if(fmt==='png')      await ExportEngine.exportPNG(this._model, fn, opts);
      else if(fmt==='jpg') await ExportEngine.exportJPG(this._model, fn, opts);
      else if(fmt==='svg')       ExportEngine.exportSVG(this._model, fn, opts);
      else if(fmt==='pdf') await ExportEngine.exportPDF(this._model, fn, opts);
    }finally{
      document.querySelectorAll('.exp-dl-btn').forEach(b=> b.disabled = false);
    }
  },

  _bind(){
    document.getElementById('export-close-btn').onclick = ()=>{
      document.getElementById('export-overlay').style.display = 'none';
    };
    document.getElementById('export-overlay').addEventListener('click', (e)=>{
      if(e.target === document.getElementById('export-overlay'))
        document.getElementById('export-overlay').style.display = 'none';
    });
    document.getElementById('exp-refresh-btn').onclick = ()=> this._refreshPreview();
    ['exp-show-labels','exp-show-pins','exp-show-grid','exp-show-wire-color'].forEach(id=>{
      document.getElementById(id).addEventListener('change', ()=> this._refreshPreview());
    });
    document.querySelectorAll('input[name="exp-switch-mode"]').forEach(r=>{
      r.addEventListener('change', ()=> this._refreshPreview());
    });
    document.querySelectorAll('input[name="exp-bg"]').forEach(r=>{
      r.addEventListener('change', ()=> this._refreshPreview());
    });
    document.querySelectorAll('.exp-dl-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        document.querySelectorAll('.exp-dl-btn').forEach(b=>{ b.style.background = '#1e5fcc'; });
        btn.style.background = '#0f2a4a';
        this._download(btn.dataset.fmt);
      });
    });
  }
};

