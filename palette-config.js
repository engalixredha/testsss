// =========================================================================
// 11 & 12 & 13. INPUT CONTROLLER, UI CONTROLLER, APP
// -------------------------------------------------------------------------
// These are combined into the App object below since they share a large
// amount of mutable state (current drag, current wire-drag, clipboard...).
// Kept as clearly separated *sections* within App for readability and so
// future refactors can lift them into standalone classes easily.
// =========================================================================
// =========================================================================
// ELEMENT PALETTE CONFIG — drives the generic multi-element "palette" chips
// (split-button body + ▾ arrow tab + 2-8 submenu) and the unified "bank"
// panel that results from placing more than one at once. SWITCH was the
// original implementation; LED, PROBE, and VARIABLE reuse the exact same
// mechanism — see _initElementPalette, _placeComponentN, and the bank
// reconstruction logic in _applySnapshotData / pasteClipboard.
// =========================================================================
const PALETTE_CONFIG = {
  SWITCH:   { idPrefix:'switch',   plural:'Switches',  menuHeader:'Multiple Switches'  },
  LED:      { idPrefix:'led',      plural:'LEDs',      menuHeader:'Multiple LEDs'      },
  PROBE:    { idPrefix:'probe',    plural:'Probes',    menuHeader:'Multiple Probes'    },
  VARIABLE: { idPrefix:'variable', plural:'Variables', menuHeader:'Multiple Variables' },
};
const BankableTypes = new Set(Object.keys(PALETTE_CONFIG));

