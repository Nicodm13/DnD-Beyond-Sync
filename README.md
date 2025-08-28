# D&D Beyond Sync

Keeps spectators in sync with the DM’s map view on D&D Beyond by mirroring pan and zoom between tabs in the same game.

- **Leader (DM):** Broadcasts pointer drag (pan), wheel (zoom), and HUD zoom button clicks.
- **Spectator (viewer):** Blocks local pan/zoom, hides toolbar, listens to the leader, and replays events.


## Installation

1. **Download the source files**  
   Clone this repo or download the files (`manifest.json` and `content.js`) into a single folder.

2. **Open Chrome Extensions**  
   In Chrome, go to: chrome://extensions/


3. **Enable Developer Mode**  
Toggle **Developer mode** in the top-right corner.

4. **Load the extension**  
Click **Load unpacked** and select the folder containing the files.

5. The extension should now appear in your Chrome extensions list.


## Usage

- **Leader (DM):**  
  Open a D&D Beyond game as the DM. A **blue badge** labeled **“Leader”** will appear in the bottom-left corner of the screen.  

- **Spectator:**  
  In the same game, click the **Spectator View** button in the D&D Beyond toolbar.
  The spectator window will display a **green badge** labeled **“Spectator”** in the bottom-left corner.  

- **Sync in Action:**  
  As the Leader pans or zooms the map, all Spectators automatically follow along in real time — with no local control required.


## Notes

- Works only on pages matching `https://www.dndbeyond.com/games/*`.
- Requires Chrome or a Chromium-based browser with support for `BroadcastChannel` (most modern versions).


## Reporting Issues

If you find a bug or have a feature request, please [open an issue](../../issues) on this repository.  

When reporting an issue, please include:
- A short description of the problem  
- Steps to reproduce it  
- Any error messages from the browser console (press `F12` → Console tab)  

This will help me debug and improve the extension quickly.

## Credits

Created by **Nicolai D. Madsen (@nicodm13), 2025**.
