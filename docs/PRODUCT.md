# Crow: product spec

**One line:** an alarm clock that only goes quiet when its app proves you solved a puzzle, and keeps
ringing if you delete the app.

**Principle:** the clock is the boss, the phone is the key. Phones are easy to silence, so the phone
never makes the noise. It only holds the one thing the clock wants.

## The pieces

- **The clock.** A round-shouldered black box with a crow's face on a small OLED, a brass "perch" button
  on top, orange feet, a red rage light, and a hidden SOS pin on the side. Battery inside. Alarms are
  stored on the clock and it rings on its own.
- **The app.** Pairs once, holds a 128-bit key, sets alarms, and at 7 a.m. gives you puzzles. When you
  finish them it hands the clock a proof for that morning's challenge.

## A normal morning

1. 7:00, the clock rings at level 1 (two soft chirps every 4 s). The phone gets a notification.
2. Open the app. "CAW!" Tap *Solve to silence*.
3. Two puzzles (default). Each wrong answer makes the clock one level louder.
4. Done: the app sends the proof, the clock goes quiet and squints: "WATCHING YOU".
5. 7:05ish, a wake check. The clock chirps; the app asks you to tap a moving crow three times within 2 min.
6. Pass: "GOOD MORNING", streak +1. Miss it: it rings again at level 3 with new puzzles.

## The rules

| Rule | Value | Notes |
|------|-------|-------|
| Escalation | level 1 → 2 → 3 → 4 at 0, 30, 90, 180 s | Level 3+ flashes the screen. |
| Snooze | none | The perch says "NO SNOOZE". |
| Puzzles per alarm | 2 (1–4) | Picked at random from the ones you enable. |
| Wrong answer | +1 level | 3 s cooldown. |
| Unplugged while ringing | straight to level 4 | "NICE TRY". During a wake check it restarts the ring. |
| Wake check | 5 min after silencing, 2 min to answer | Can be turned off. |
| Orphan | no app check-in for 24 h | Next ring starts at level 3 with a penalty round. |
| Penalty round | +2 puzzles | Orphan rings and mid-ring re-pairs. |
| Betrayal | +1 per re-pair | Kept on the clock forever. Shown in the app's stats. |
| No-weasel window | 8 h (off/4/8/12) | Turning off or delaying the next alarm inside it costs a Spicy puzzle. App-side. |
| Mercy limit | 45 min (15–120), never off | Then it stops, logs a shame and shows "YOU SLEPT THROUGH THE CROW". |
| SOS pin | hold 8 s while ringing | 5 rounds: count 3–6 beeps, press the perch that many times. One miss = level 4. |
| Factory reset | hold the SOS pin 20 s while idle | Only when idle, so it's not an escape. |

## Deleting the app (the point of the whole thing)

- The key lives only in the app's storage. Deleting the app (or its data) deletes the key.
- The alarms do not live in the app, so they keep firing.
- With no key, nothing can produce the proof, so it rings until: you reinstall and re-pair (perch hold,
  penalty round, betrayal logged), you pass the SOS count-off, or the mercy limit runs out (shame logged).
- If the app stays gone for a day, the clock notices (orphan) and the face turns sad: "WHERE'S MY APP?"

## Puzzles

All six are short and need a working brain, not a pen and paper.

| Puzzle | Chill | Normal | Spicy |
|--------|-------|--------|-------|
| Quick Math | 2 sums like 34 + 7 | 3 like 58 − 23, 7 × 8 | 4 like 14 × 7, 6 × 9 + 13 |
| Crow's Memory | 3-step pattern | 4 | 6 |
| Number Hunt | tap 1–9 | 1–16 | 1–25 |
| Color Clash | 4 rounds, swatches | 6 rounds, names only | 8, sometimes "tap the word" |
| Unscramble | 4–5 letters, first one given | 6–7 letters | 8–10 letters |
| Odd One Out | O among Q, 4 × 4 | b among d, 5 × 5 | m among rn, 6 × 6 |

Words were picked so none has a common anagram (no EARLY/LAYER arguments at 7 a.m.).
Color Clash is hard with color blindness, so it can be switched off like any other puzzle.

## Edge cases

| Situation | What happens |
|-----------|--------------|
| Phone dead, lost, or Bluetooth off | Rings anyway. SOS pin is the way out. |
| Power cut overnight | The LiPo runs it for about a day; the DS3231 keeps time even if that runs out too. |
| Clock time never set | Shows "--:--" and doesn't fire alarms until the app syncs it. |
| Daylight saving | The app re-sends time and timezone on every connection. |
| Two alarms in the same minute | One ring. |
| New phone | Pair it (perch hold). The clock counts it as a betrayal; it doesn't know you upgraded. |
| Neighbors | Mercy limit. You can lower it, you can't turn it off. |

## Safety, privacy, accessibility

- Not a medical or safety device. Don't rely on it to wake you for anything dangerous to miss.
- Peak volume is a 12 mm buzzer, about as loud as a normal alarm clock. The escalation is about
  persistence, not hearing damage.
- No account, no cloud, no analytics. The key never leaves the phone and the clock.
- Hearing: the screen flashes and the rage light blinks at level 3+; a bed-shaker on a spare GPIO is
  on the roadmap. Vision: puzzles use large type and the app works with screen zoom.

## Roadmap

- **1.1** Real crow caws: I²S amp + small speaker, samples on flash.
- **1.1** Light sleep between checks, for a week on battery.
- **2.0** Native iOS/Android apps with background Bluetooth, so the phone checks in without being open.
- **2.0** Proof of wake: the clock generates the puzzles from the challenge and checks the answers itself,
  so even a modified app can't skip them.
- **2.0** "A murder of crows": several clocks in one house, each person their own key.
- Bed-shaker accessory for deaf and hard-of-hearing sleepers.
