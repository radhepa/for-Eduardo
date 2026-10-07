# Crow: the pitch

*For the larp. Numbers are estimates from hobby part prices, not quotes.*

## One line

**Crow is the alarm clock you can't snooze, unplug, or uninstall your way out of.**

## The problem

Every alarm has an off switch, and at 7 a.m. you are an expert at finding it. Snooze buttons, phone
alarms you swipe away half asleep, puzzle-alarm apps you force-quit or delete. If the thing making the
noise is something you can silence with your thumb, you will.

## The idea

Split the alarm in two.

- **The noise lives in a clock.** It sits across the room, holds the alarms, has a battery, and has no
  off switch.
- **The off switch lives in an app.** Not a button: a cryptographic key the clock trusts, released only
  after you solve a couple of quick puzzles.

Delete the app and you didn't escape the alarm. You threw away the only key to it.

## Why it works

| Trick | Crow's answer |
|-------|---------------|
| Snooze | Doesn't exist. The perch button says "NO SNOOZE". |
| Unplug it | Battery inside, and unplugging jumps it to full volume. |
| Mute the phone | The phone isn't the noise. |
| Delete the app | Key's gone, alarms aren't. Reinstall, re-pair, extra puzzles, betrayal on record. |
| Fall back asleep | Wake check 5 minutes later. Miss it and it starts over, louder. |
| Lose your phone | SOS pin: five rounds of counting beeps. Easy awake, impossible asleep. |

## Who it's for

- Heavy sleepers who have beaten every alarm app.
- Students with 8 a.m. classes.
- Anyone who wants their phone out of the bedroom but still needs it to wake them up.

## How it's different

- **Puzzle alarm apps** (Alarmy and others) make you do a task first, but they live on your phone, so the
  phone is still the off switch.
- **Runaway clocks** (Clocky) make you get up and chase them, then you press the button.
- **Crow** keeps the noise and the off switch on different devices, and makes the off switch a key the
  clock can verify.

## The product

- Crow clock: ESP32, OLED crow face, battery-backed RTC, buzzer, brass perch button, SOS pin.
  96 × 70 × 78 mm, printed in PETG.
- Crow app: installable web app over Bluetooth today (Android, desktop Chrome, Bluefy on iPhone),
  native apps on the roadmap.
- No account, no cloud, no subscription.

## Rough numbers

| | |
|-|-|
| Parts at hobby prices | ≈ $29 |
| Print time | ≈ 6 h |
| Plausible kit price | $49 (parts + printed shell + instructions) |
| Plausible assembled price | $79 |

At volume the board, screen and RTC would collapse onto one custom PCB, which is where the margin comes from.

## Launch plan

1. **Open hardware first.** Publish the files: firmware, app, STL, wiring. Let makers build their own.
2. **The demo is the ad.** The simulator lets anyone delete the app and watch the clock keep screaming.
   That 15-second clip is the pitch.
3. **Kits** for people who want one without sourcing parts.
4. **Assembled units + native apps** once the design settles.

## Voice

The crow is smug, loyal and loud. It doesn't hate you, it just doesn't believe you. It keeps receipts
(betrayals, shames, SOS escapes) and it never forgets.

Taglines to test:
- "Outsmart the crow."
- "Snooze is not an option. Literally."
- "Delete the app. See what happens."

## Risks

| Risk | Mitigation |
|------|------------|
| Annoys neighbors | Mercy limit (never off), sensible buzzer volume. |
| Someone relies on it for something critical | Clear "not a safety device" language. |
| iPhone Web Bluetooth | Bluefy browser now, native app later. |
| Determined people with screwdrivers | If you're awake enough to unscrew it, it worked. |
