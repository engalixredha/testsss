// =====================================================================
// 5b. KMapEngine — pure Boolean-logic module, independent of the canvas/
//     circuit model. Given a number of input variables and an array of
//     2^n output values (0, 1, or null for don't-care, indexed by the
//     same binary "mask" convention used elsewhere in the app — bit 0 of
//     `inputs` is the MOST significant bit of the mask), it derives:
//       - the canonical sum-of-minterms ("original") expression
//       - a Quine–McCluskey minimization (prime implicants + a minimal
//         essential-PI cover) -> the simplified expression
//       - a Gray-code Karnaugh-map grid layout (rows/cols split across
//         the input variables) with each cell's group memberships, so
//         the UI can render + highlight groups without re-deriving them.
//     Kept modular and dependency-free so future analysis tools (e.g.
//     a Boolean expression parser, POS minimization, etc.) can reuse the
//     same primitives.
// =====================================================================
const KMapEngine = {
  GROUP_COLORS: ['#e74c3c','#1e88e5','#2ecc71','#f39c12','#9b59b6','#16a085','#e84393','#7f8c8d','#d35400','#2c3e50','#27ae60','#c0392b'],

  grayCode(i){ return i ^ (i >> 1); },

  toBits(value, width){
    const bits = [];
    for(let i=width-1;i>=0;i--) bits.push((value>>i)&1);
    return bits;
  },

  bitsToMask(bits){
    let m = 0;
    for(const b of bits) m = (m<<1) | b;
    return m;
  },

  /** Builds literal text for a QM pattern (string of '0'/'1'/'-', length n)
   *  using the given variable labels. e.g. "1-0" with [A,B,C] -> "A×C'" —
   *  literals are joined with '×', the same AND symbol used on the
   *  keypad's AND key, so the term reads as an explicit multiplication
   *  rather than letters just sitting side by side. */
  patternToTerm(pattern, labels){
    const parts = [];
    for(let i=0;i<pattern.length;i++){
      if(pattern[i] === '1') parts.push(labels[i]);
      else if(pattern[i] === '0') parts.push(labels[i] + "'");
    }
    return parts.length ? parts.join('×') : '1';
  },

  /** The Product-of-Sums counterpart to patternToTerm: builds an OR-of-
   *  literals sum term from a QM pattern (string of '0'/'1'/'-', length n).
   *  Since a POS sum term is the complement of the corresponding SOP AND
   *  term, the literal polarity is flipped versus patternToTerm — a '1'
   *  bit (uncomplemented in the AND term) becomes a complemented literal
   *  here, and a '0' bit becomes uncomplemented. e.g. "1-0" with [A,B,C]
   *  -> "A'+C" (the complement of the AND term "A×C'" patternToTerm would
   *  produce for the same pattern). Literals are joined with '+'. */
  patternToSumTerm(pattern, labels){
    const parts = [];
    for(let i=0;i<pattern.length;i++){
      if(pattern[i] === '1') parts.push(labels[i] + "'");
      else if(pattern[i] === '0') parts.push(labels[i]);
    }
    return parts.length ? parts.join('+') : '0';
  },

  /** Term-object renderer: dispatches a term produced by xorReduce (either
   *  a plain AND/OR-style pattern, or an {kind:'xor'} compound) to text. */
  termToText(term, labels){
    return term.kind === 'xor' ? this._xorTermText(term, labels) : this.patternToTerm(term.pattern, labels);
  },

  /** Renders a two-variable XOR/XNOR compound term. `pattern` carries the
   *  literals shared by both source prime implicants (with '-' at the two
   *  combined variable positions p/q); those shared literals get AND'ed
   *  in front, e.g. "A(C⊕D)". If there are no shared literals the compound
   *  stands alone with no wrapping parens, e.g. "C⊕D". Parens are only
   *  needed when there's a shared prefix, since AND binds tighter than
   *  XOR/XNOR in the grammar (juxtaposing "AC⊕D" would otherwise parse as
   *  (A AND C) XOR D instead of A AND (C⊕D)). */
  _xorTermText(term, labels){
    const prefixParts = [];
    for(let k=0;k<term.pattern.length;k++){
      if(k===term.p || k===term.q) continue;
      if(term.pattern[k] === '1') prefixParts.push(labels[k]);
      else if(term.pattern[k] === '0') prefixParts.push(labels[k] + "'");
    }
    const symbol = term.mode === 'xor' ? '⊕' : "⊕'";
    const core = labels[term.p] + symbol + labels[term.q];
    return prefixParts.length ? prefixParts.join('×') + '×(' + core + ')' : core;
  },

  /** Looks for pairs of prime-implicant patterns that differ in exactly two
   *  variable positions, with each pattern's bit at those two positions the
   *  complement of the other's — the textbook signature of two product
   *  terms that collapse into a single XOR (when the two bits disagree
   *  within a pattern, e.g. C=0,D=1) or XNOR (when they agree, e.g. C=0,D=0)
   *  term over those two variables. Everywhere else the two patterns must
   *  match exactly (same literal or same don't-care), since that's the
   *  shared context the combined term keeps. This only catches the
   *  two-variable case pairwise — it doesn't chase 3+ variable XOR chains —
   *  but that covers the common textbook simplifications (e.g. "C'D + CD'"
   *  → "C⊕D"). Returns an array of terms ({kind:'and',pattern} or
   *  {kind:'xor',pattern,p,q,mode}) ready for termToText. */
  xorReduce(n, patterns){
    const used = new Array(patterns.length).fill(false);
    const terms = [];
    for(let i=0;i<patterns.length;i++){
      if(used[i]) continue;
      let combined = false;
      for(let j=i+1;j<patterns.length;j++){
        if(used[j]) continue;
        const a = patterns[i], b = patterns[j];
        const diffs = [];
        let compatible = true;
        for(let k=0;k<n;k++){
          if(a[k]==='-' && b[k]==='-') continue;
          if(a[k]==='-' || b[k]==='-'){ compatible = false; break; }
          if(a[k] !== b[k]) diffs.push(k);
        }
        if(!compatible || diffs.length !== 2) continue;
        const [p, q] = diffs;
        const mode = (a[p] !== a[q]) ? 'xor' : 'xnor';
        terms.push({ kind:'xor', pattern:a, p, q, mode });
        used[i] = true; used[j] = true;
        combined = true;
        break;
      }
      if(!combined){
        terms.push({ kind:'and', pattern: patterns[i] });
        used[i] = true;
      }
    }
    return terms;
  },


  /** Quine–McCluskey: returns { primes:[{pattern,minterms:Set}], essential:[...patterns chosen...] } */
  minimize(n, values){
    const minterms = [];
    const careTerms = []; // minterms + don't-cares, used to FORM prime implicants
    for(let m=0;m<values.length;m++){
      if(values[m] === 1){ minterms.push(m); careTerms.push(m); }
      else if(values[m] === null){ careTerms.push(m); }
    }
    if(minterms.length === 0){
      return { primes: [], essential: [], allOnes:false, allZero:true };
    }
    if(minterms.length + careTerms.filter(m=>values[m]===null).length === values.length &&
       minterms.length === values.length){
      return { primes: [{ pattern: '-'.repeat(n), minterms: new Set(minterms) }], essential: ['-'.repeat(n)], allOnes:true, allZero:false };
    }

    // Initial groups: each care term as an n-bit pattern, tagged with which
    // original minterms it represents (itself) for later coverage tracking.
    let groups = new Map(); // ones-count -> array of {pattern, set:Set(minterms)}
    for(const m of careTerms){
      const bits = this.toBits(m, n).join('');
      const ones = bits.split('').filter(b=>b==='1').length;
      if(!groups.has(ones)) groups.set(ones, []);
      groups.get(ones).push({ pattern: bits, set: new Set([m]) });
    }

    const allPrimesMap = new Map(); // pattern -> {pattern,set}
    let currentGroups = groups;
    while(true){
      const used = new Set();
      const nextGroups = new Map();
      const keys = [...currentGroups.keys()].sort((a,b)=>a-b);
      let combinedAny = false;
      for(let k=0;k<keys.length-1;k++){
        const a = currentGroups.get(keys[k]) || [];
        const b = currentGroups.get(keys[k+1]) || [];
        if(keys[k+1] !== keys[k]+1) continue;
        for(const ta of a){
          for(const tb of b){
            // combine if patterns differ in exactly one bit position (dashes must align)
            let diffPos = -1, ok = true;
            for(let i=0;i<n;i++){
              if(ta.pattern[i] !== tb.pattern[i]){
                if(ta.pattern[i] === '-' || tb.pattern[i] === '-'){ ok = false; break; }
                if(diffPos !== -1){ ok = false; break; }
                diffPos = i;
              }
            }
            if(!ok || diffPos === -1) continue;
            const newPattern = ta.pattern.slice(0,diffPos) + '-' + ta.pattern.slice(diffPos+1);
            used.add(ta.pattern + '|' + [...ta.set].sort().join(','));
            used.add(tb.pattern + '|' + [...tb.set].sort().join(','));
            const newOnes = newPattern.split('').filter(c=>c==='1').length;
            if(!nextGroups.has(newOnes)) nextGroups.set(newOnes, []);
            const mergedSet = new Set([...ta.set, ...tb.set]);
            // de-dup within the next-level group
            const arr = nextGroups.get(newOnes);
            if(!arr.some(t=> t.pattern === newPattern)) arr.push({ pattern: newPattern, set: mergedSet });
            combinedAny = true;
          }
        }
      }
      // anything not used in a combination this round is a prime implicant
      for(const [ones, arr] of currentGroups){
        for(const t of arr){
          const key = t.pattern + '|' + [...t.set].sort().join(',');
          if(!used.has(key) && !allPrimesMap.has(t.pattern)) allPrimesMap.set(t.pattern, t);
        }
      }
      if(!combinedAny) break;
      currentGroups = nextGroups;
    }

    const primes = [...allPrimesMap.values()];

    // Build coverage chart restricted to actual 1-minterms (don't-cares
    // don't need to be covered, but may help form larger groups above).
    const chart = new Map(); // minterm -> [primeIndices]
    minterms.forEach(m=> chart.set(m, []));
    primes.forEach((p, idx)=>{
      for(const m of p.set){ if(chart.has(m)) chart.get(m).push(idx); }
    });

    const chosen = new Set();
    const covered = new Set();
    // 1) essential prime implicants: any minterm covered by exactly 1 prime
    for(const [m, idxs] of chart){
      if(idxs.length === 1){ chosen.add(idxs[0]); }
    }
    chosen.forEach(idx=> primes[idx].set.forEach(m=>{ if(minterms.includes(m)) covered.add(m); }));
    // 2) greedy cover for any remaining uncovered minterms
    let remaining = minterms.filter(m=> !covered.has(m));
    while(remaining.length > 0){
      let bestIdx = -1, bestCount = -1;
      primes.forEach((p, idx)=>{
        if(chosen.has(idx)) return;
        const count = remaining.filter(m=> p.set.has(m)).length;
        if(count > bestCount){ bestCount = count; bestIdx = idx; }
      });
      if(bestIdx === -1) break; // safety
      chosen.add(bestIdx);
      remaining = remaining.filter(m=> !primes[bestIdx].set.has(m));
    }

    return { primes, essential: [...chosen].map(idx=> primes[idx].pattern), allOnes:false, allZero:false, chosenIdx:[...chosen], minterms };
  },

  /** Splits n input variables into row/col groups for a standard
   *  Gray-coded K-map grid, and returns full grid metadata. */
  buildGrid(n, inputLabels, values){
    const rowVarsCount = n===2?1 : n===3?1 : n===4?2 : n===5?2 : 3;
    const colVarsCount = n - rowVarsCount;
    const rows = 1 << rowVarsCount;
    const cols = 1 << colVarsCount;
    const rowLabels = inputLabels.slice(0, rowVarsCount);
    const colLabels = inputLabels.slice(rowVarsCount);
    const cells = [];
    for(let r=0;r<rows;r++){
      const rowBits = this.toBits(this.grayCode(r), rowVarsCount);
      for(let c=0;c<cols;c++){
        const colBits = this.toBits(this.grayCode(c), colVarsCount);
        const bits = [...rowBits, ...colBits];
        const mask = this.bitsToMask(bits);
        cells.push({ r, c, mask, value: values[mask] });
      }
    }
    const rowHeaderLabels = [];
    for(let r=0;r<rows;r++) rowHeaderLabels.push(this.toBits(this.grayCode(r), rowVarsCount).join(''));
    const colHeaderLabels = [];
    for(let c=0;c<cols;c++) colHeaderLabels.push(this.toBits(this.grayCode(c), colVarsCount).join(''));
    return { rows, cols, rowVarsCount, colVarsCount, rowLabels, colLabels, rowHeaderLabels, colHeaderLabels, cells };
  },

  /** Full pipeline: n variables, inputLabels (length n), values (length 2^n
   *  array of 0/1/null). Returns everything the UI needs to render. */
  analyze(n, inputLabels, values){
    if(n < 2 || n > 6){
      return { error: `Karnaugh maps support 2–6 input variables (this output depends on ${n}).` };
    }
    const minimized = this.minimize(n, values);
    const grid = this.buildGrid(n, inputLabels, values);

    // canonical SOP ("original" expression) directly from the truth table
    const onesIdx = [];
    for(let m=0;m<values.length;m++) if(values[m]===1) onesIdx.push(m);
    let original;
    if(onesIdx.length === 0) original = '0';
    else if(onesIdx.length === values.length) original = '1';
    else original = onesIdx.map(m=> this.patternToTerm(this.toBits(m,n).join(''), inputLabels)).join(' + ');

    // simplified expression + group metadata
    let simplified, groups = [];
    if(minimized.allZero) simplified = '0';
    else if(minimized.allOnes) simplified = '1';
    else {
      const terms = minimized.essential;
      simplified = terms.map(p=> this.patternToTerm(p, inputLabels)).join(' + ');
      groups = terms.map((pattern, i)=>{
        const prime = minimized.primes.find(p=> p.pattern === pattern);
        return {
          pattern, term: this.patternToTerm(pattern, inputLabels),
          color: this.GROUP_COLORS[i % this.GROUP_COLORS.length],
          minterms: prime ? prime.set : new Set()
        };
      });
    }

    // attach group membership to each grid cell
    for(const cell of grid.cells){
      cell.groups = groups.filter(g=> g.minterms.has(cell.mask)).map(g=> g.color);
    }

    return { n, inputLabels, values, original, simplified, groups, grid, minimized };
  }
};

