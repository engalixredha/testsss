// =========================================================================
// 2b. GATE SHAPES — standard IEC/ANSI schematic symbols
// -------------------------------------------------------------------------
// Each entry is an inline-SVG markup string drawn in a 100 x 100 viewBox
// with `preserveAspectRatio="none"`, so it stretches to fill whatever w/h
// GateLibrary assigns the component — input pins always meet the shape at
// the left edge, the output pin always leaves from the right edge,
// matching the existing rotation-aware pin math in CircuitComponent
// (pinWorldPos) exactly, so wiring/rotation logic needed zero changes.
//
// Shape vocabulary (matches the universal textbook / Logisim conventions):
//   AND   - flat back, rounded (D-shaped) front
//   OR    - concave back, pointed curved front ("shield")
//   NOT   - triangle + small output bubble
//   BUFFER- plain triangle, no bubble
//   NAND  - AND body + output bubble
//   NOR   - OR body + output bubble
//   XOR   - OR body + an extra curved line just behind the back (double-curve)
//   XNOR  - XOR body + output bubble
//
// [EXTENSION POINT] Future component types (MUX, decoders, flip-flops...)
// can add their own entries here following the same 100x100 viewBox
// convention; ComponentView falls back to the plain rounded-box look for
// any type without a GateShapes entry, so this is purely additive.
// =========================================================================
// =========================================================================
// 2a-3. BOOLEAN EXPRESSION → CIRCUIT
// -------------------------------------------------------------------------
// Parses a textual boolean expression into an AST, then flattens that AST
// into the same abstract { nodes, outRef } shape UniversalConverter.build
// produces — a flat list of synthetic gates whose inputs are refs of one
// of three shapes:
//   { var: i }   -> the i-th distinct variable encountered (by first use)
//   { const: v } -> a literal 0 or 1
//   { node: j }  -> the output of a previously-built synthetic gate j
// App._buildCircuitFromBoolExpr turns this into real CircuitComponents,
// VARIABLE inputs, and an LED output, laid out left-to-right by depth —
// the same column-layout approach _replaceGateWithUniversal already uses.
//
// Supported syntax (case-insensitive keywords):
//   AND:  . * & × AND (or plain juxtaposition, e.g. "A B" or "A(B+C)")
//   OR:   + | OR
//   XOR:  ^ ⊕ XOR      XNOR: ⊕' XNOR
//   NAND: ×'  NAND        NOR: +'  NOR
//   NOT:  prefix ! ~ NOT, or postfix '  (e.g. !A, ~A, NOT A, A')
//   Parentheses, and literals 0 / 1
//   Variable names: any letter/underscore run not matching a keyword above
// =========================================================================
const BoolExprParser = {
  KEYWORDS: new Set(['AND','OR','NOT','XOR','XNOR','NAND','NOR']),
  /** `knownVars`, when provided, is the exact list of variable names in
   *  play for this parse (e.g. a circuit's existing input labels). Instead
   *  of greedily reading every run of letters as one identifier, the
   *  tokenizer then does a longest-match lookup against that list at each
   *  position — so a mathematically-juxtaposed term like "AC'D" splits
   *  back into the three known variables A, C, D (matching whichever
   *  produced it) rather than being read as one long identifier "AC" (or
   *  similar). Any letter that doesn't match a known name falls back to
   *  being its own single-character variable, which is the standard
   *  juxtaposition convention (each letter its own variable) and is what
   *  a fresh, unrecognized letter typed into an existing circuit's
   *  expression should mean. Without `knownVars` (the normal case when
   *  typing a brand new expression from scratch), tokenizing is unchanged
   *  from before — a run of letters is one identifier, so multi-letter
   *  names like "Sel" still work when there's nothing to disambiguate
   *  against yet. */
  tokenize(src, knownVars){
    const toks = [];
    let i = 0;
    const knownSorted = (knownVars && knownVars.length) ? [...knownVars].sort((a,b)=> b.length - a.length) : null;
    while(i < src.length){
      const ch = src[i];
      if(/\s/.test(ch)){ i++; continue; }
      if(ch === '('){ toks.push({t:'(' }); i++; continue; }
      if(ch === ')'){ toks.push({t:')' }); i++; continue; }
      if(ch === "'"){ toks.push({t:"'"}); i++; continue; }
      // '×' is AND; immediately followed by ' it reads as the NAND key (×')
      if(ch === '×'){
        if(src[i+1] === "'"){ toks.push({t:'NAND'}); i+=2; continue; }
        toks.push({t:'AND'}); i++; continue;
      }
      // '+' is OR; immediately followed by ' it reads as the NOR key (+')
      if(ch === '+' || ch === '|'){
        if(ch === '+' && src[i+1] === "'"){ toks.push({t:'NOR'}); i+=2; continue; }
        toks.push({t:'OR'}); i++; continue;
      }
      if(ch === '.' || ch === '*' || ch === '&'){ toks.push({t:'AND'}); i++; continue; }
      // '⊕' is XOR; immediately followed by ' it reads as the XNOR key (⊕')
      if(ch === '⊕'){
        if(src[i+1] === "'"){ toks.push({t:'XNOR'}); i+=2; continue; }
        toks.push({t:'XOR'}); i++; continue;
      }
      if(ch === '^'){ toks.push({t:'XOR'}); i++; continue; }
      if(ch === '!' || ch === '~'){ toks.push({t:'NOT'}); i++; continue; }
      if(ch === '0' || ch === '1'){ toks.push({t:'CONST', value: ch==='1'?1:0}); i++; continue; }
      if(/[A-Za-z_]/.test(ch)){
        if(knownSorted){
          const found = knownSorted.find(name => src.slice(i, i+name.length).toUpperCase() === name.toUpperCase());
          if(found){ toks.push({t:'IDENT', name: found}); i += found.length; continue; }
          toks.push({t:'IDENT', name: ch});
          i++; continue;
        }
        let j = i+1;
        while(j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
        const word = src.slice(i, j);
        const upper = word.toUpperCase();
        if(this.KEYWORDS.has(upper)) toks.push({t: upper});
        else toks.push({t:'IDENT', name: word});
        i = j;
        continue;
      }
      throw new Error(`Unrecognized character "${ch}" in expression.`);
    }
    return toks;
  },
  // Tokens that can legally start a new factor — used to detect implicit
  // (juxtaposed) AND at the AND-precedence level, e.g. "A B" or "A(B)".
  _startsFactor(tok){
    return !!tok && (tok.t==='IDENT' || tok.t==='CONST' || tok.t==='(' || tok.t==='NOT');
  },
  parse(src, knownVars){
    const toks = this.tokenize(src, knownVars);
    let pos = 0;
    const peek = () => toks[pos];
    const next = () => toks[pos++];
    const expect = (t) => { const tok = next(); if(!tok || tok.t!==t) throw new Error(`Expected "${t}" in expression.`); return tok; };

    function parseOr(){
      let left = parseXor();
      while(peek() && (peek().t==='OR' || peek().t==='NOR')){
        const op = next().t;
        const right = parseXor();
        left = { op: op==='OR' ? 'OR' : 'NOR', a:left, b:right };
      }
      return left;
    }
    function parseXor(){
      let left = parseAnd();
      while(peek() && (peek().t==='XOR' || peek().t==='XNOR')){
        const op = next().t;
        const right = parseAnd();
        left = { op, a:left, b:right };
      }
      return left;
    }
    function parseAnd(){
      let left = parseNot();
      while(true){
        const tok = peek();
        if(tok && (tok.t==='AND' || tok.t==='NAND')){
          const op = next().t;
          const right = parseNot();
          left = { op: op==='AND' ? 'AND' : 'NAND', a:left, b:right };
        } else if(BoolExprParser._startsFactor(tok)){
          // Implicit AND via juxtaposition (no operator token between factors)
          const right = parseNot();
          left = { op:'AND', a:left, b:right };
        } else break;
      }
      return left;
    }
    function parseNot(){
      if(peek() && peek().t==='NOT'){
        next();
        return { op:'NOT', a: parseNot() };
      }
      return parsePostfix();
    }
    function parsePostfix(){
      let node = parsePrimary();
      while(peek() && peek().t==="'"){
        next();
        node = { op:'NOT', a: node };
      }
      return node;
    }
    function parsePrimary(){
      const tok = peek();
      if(!tok) throw new Error('Expression ended unexpectedly — check for a missing operand.');
      if(tok.t==='('){
        next();
        const inner = parseOr();
        expect(')');
        return inner;
      }
      if(tok.t==='IDENT'){ next(); return { op:'VAR', name: tok.name }; }
      if(tok.t==='CONST'){ next(); return { op:'CONST', value: tok.value }; }
      throw new Error(`Unexpected "${tok.t.toLowerCase()}" in expression.`);
    }

    if(toks.length===0) throw new Error('Enter a boolean expression first.');
    const ast = parseOr();
    if(pos < toks.length) throw new Error(`Unexpected extra input near "${toks[pos].name || toks[pos].t}".`);
    return ast;
  },
  /** Flattens an AST into the { nodes, outRef, varNames } shape described
   *  above — one synthetic 2-input (or 1-input, for NOT) gate per AST
   *  operator node, in post-order (each node's dependencies always appear
   *  earlier in the array, exactly like UniversalConverter.build's output). */
  toNodes(ast){
    const nodes = [];
    const varNames = [];
    const varIndex = new Map();
    const getVarRef = (name) => {
      if(!varIndex.has(name)){ varIndex.set(name, varNames.length); varNames.push(name); }
      return { var: varIndex.get(name) };
    };
    const walk = (node) => {
      if(node.op==='VAR') return getVarRef(node.name);
      if(node.op==='CONST') return { const: node.value };
      if(node.op==='NOT'){
        const aRef = walk(node.a);
        nodes.push({ type:'NOT', in:[aRef] });
        return { node: nodes.length-1 };
      }
      const aRef = walk(node.a), bRef = walk(node.b);
      nodes.push({ type: node.op, in:[aRef, bRef] });
      return { node: nodes.length-1 };
    };
    const outRef = walk(ast);
    return { nodes, outRef, varNames };
  }
};

const GateShapes = {
  AND: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="gate-outline" d="M 8,6 L 50,6 A 44,44 0 0 1 50,94 L 8,94 Z"/>
    </svg>`,
  OR: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="gate-outline" d="M 8,6 Q 34,6 50,6 C 78,6 96,32 98,50 C 96,68 78,94 50,94 C 34,94 8,94 8,94 Q 22,72 22,50 Q 22,28 8,6 Z"/>
    </svg>`,
  XOR: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="gate-outline" d="M 14,6 Q 40,6 50,6 C 78,6 96,32 98,50 C 96,68 78,94 50,94 C 40,94 14,94 14,94 Q 28,72 28,50 Q 28,28 14,6 Z"/>
      <path class="gate-leadline" fill="none" d="M 6,6 Q 20,28 20,50 Q 20,72 6,94"/>
    </svg>`,
  NOT: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="gate-outline" d="M 10,8 L 10,92 L 82,50 Z"/>
      <circle class="gate-bubble" cx="90" cy="50" r="8"/>
    </svg>`,
  BUFFER: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="gate-outline" d="M 10,8 L 10,92 L 92,50 Z"/>
    </svg>`,
  NAND: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="gate-outline" d="M 8,6 L 42,6 A 44,44 0 0 1 42,94 L 8,94 Z"/>
      <circle class="gate-bubble" cx="89" cy="50" r="8"/>
    </svg>`,
  NOR: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="gate-outline" d="M 8,6 Q 30,6 42,6 C 68,6 86,32 88,50 C 86,68 68,94 42,94 C 30,94 8,94 8,94 Q 22,72 22,50 Q 22,28 8,6 Z"/>
      <circle class="gate-bubble" cx="92" cy="50" r="7"/>
    </svg>`,
  XNOR: `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
      <path class="gate-outline" d="M 14,6 Q 36,6 42,6 C 68,6 86,32 88,50 C 86,68 68,94 42,94 C 36,94 14,94 14,94 Q 28,72 28,50 Q 28,28 14,6 Z"/>
      <path class="gate-leadline" fill="none" d="M 6,6 Q 20,28 20,50 Q 20,72 6,94"/>
      <circle class="gate-bubble" cx="92" cy="50" r="7"/>
    </svg>`
};

