# Void Crusade (Isometric Diablo-style Prototype)

A browser-based isometric action demo inspired by Diablo-style room crawling, featuring a **Space Marine** with:

- **Bolt Gun** for ranged destruction.
- **Power Fist** for heavy melee impact.

## Features

- Isometric room rendering on HTML5 canvas.
- Procedural room generation keyed by room coordinates.
- Door-based room transitions (N/S/E/W).
- Destructible walls and room objects with armor/strength tiers.
- Weapon-dependent destruction speed:
  - Bolt gun: fast ranged chip damage.
  - Power fist: heavy close-range burst damage.
- Room memory policy:
  - Keeps only the two most recent rooms in memory.
  - Older rooms are disposed when moving beyond two rooms.
- Visual effects:
  - Muzzle flashes, impact particles, break bursts.
  - Camera shake and screen vignette.
  - Dynamic floor shimmer/glow.
- Basic synthesized SFX using WebAudio:
  - Gun fire, impact, and destruction tones.

## Controls

- `WASD`: Move
- `Mouse`: Aim
- `Click`: Fire / Punch
- `1`: Equip Bolt Gun
- `2`: Equip Power Fist

## Run

Open `index.html` in any modern browser.
