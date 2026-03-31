# DeepNet Scripts Suite

A collection of userscripts for [DeepNet](https://deepnet.us) built around a shared window manager. Install with any userscript manager (Tampermonkey, Violentmonkey, etc.).

## Scripts

| Script | Description |
|---|---|
| [**dn-wm**](scripts/dn-wm/) | Window manager framework that all other scripts depend on. Provides panel lifecycle, a shared API layer, drag with anchor snapping, z-stacking, position persistence, and UI scaling. **Install this first.** |
| [**dn-dossier**](scripts/dn-dossier/) | Player dossier viewer with tabbed pages for Profile, Shadow, Social, and World data. |
| [**dn-dealer**](scripts/dn-dealer/) | File management panel for browsing, selecting, and bulk-selling data files. |
| [**dn-tripwire**](scripts/dn-tripwire/) | Tripwire deployment UI with configurable slots, one-click deploy/clear, honeypot toggling, and IP change alerts. |

## Installation

1. Install a userscript manager extension for your browser (e.g. [Tampermonkey](https://www.tampermonkey.net/)).
2. Install **dn-wm** first — it is a required dependency for all other scripts.
3. Install any combination of the remaining scripts.

## License

[The Unlicense](LICENSE.txt) — public domain.
