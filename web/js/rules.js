// The Crow's rules. This file mirrors firmware/crow/config.h.
// If you change a number here, change it there too (tools/test.mjs checks they match).

export const FW_VERSION = '1.0.0';
export const APP_VERSION = '1.0.0';

export const RULES = Object.freeze({
  escalateS: [0, 30, 90, 180],   // ring seconds at which level 0/1/2/3 starts
  graceS: 300,                   // after silencing: quiet time before the wake check
  checkS: 120,                   // wake check: time to prove you're up
  pairWindowS: 90,               // pairing stays open this long after the perch hold
  perchPairHoldMs: 3000,         // hold the perch this long to open pairing
  pinholeHoldMs: 8000,           // hold the SOS pin this long (while ringing) to start SOS
  pinholeResetHoldMs: 20000,     // hold the SOS pin this long (while idle) to factory reset
  orphanS: 24 * 3600,            // no check-in from the app for this long = "you deleted me"
  sosRounds: 5,
  sosMinBeeps: 3,
  sosMaxBeeps: 6,
  sosLeadMs: 1200,
  sosBeepGapMs: 650,
  sosInputTimeoutMs: 15000,
  sosSettleMs: 2500,
  missBumpCooldownS: 3,
  penaltyExtraPuzzles: 2,
  mercyMinMin: 5,
  mercyMaxMin: 120,
  defaultMercyMin: 45,
  mercyOptions: [15, 30, 45, 60, 90, 120],
  maxAlarms: 4,
  heartbeatS: 60,
});
