# Mobile Layout Work Status

## Date: 2026-05-12

## Problem
The card game "Lord Landlord" has severe layout issues on mobile devices with overlapping cards and cluttered UI.

## Changes Made

### Files Modified
1. **src/js/ui.js** - Main UI rendering file with extensive mobile layout changes
2. **src/css/styles.css** - Medieval theme with mobile responsive styles

### Key Changes in ui.js

#### Mobile Detection & Layout (lines 193-220)
- Mobile detected when `canvas width < 768px`
- Portrait mode: `canvas height > width`
- **Mobile layout structure:**
  - Opponents: Compact horizontal rows at top (each ~55px tall)
  - Player: Large zones at bottom for your cards
  - Deck/discard: Center of screen

#### Opponent Card Display (lines 79-83)
- Opponent bank/board cards: **55% size** (was 45%, increased for visibility)
- Located in `getCardDisplaySize()` function
- Only affects `bank` and `board` zones, NOT hand

#### Opponent Hand Cards - HIDDEN (lines 350-354)
- Filtered out completely in `draw()` function
- Never rendered on screen (to reduce clutter)
- Hand count shown in text label instead

#### Zone Positioning (lines 194-220)
```javascript
// Opponents get compact rows
oppCardHeight = cardHeight * 0.6
oppRowHeight = oppCardHeight + 28  // ~55px per opponent

// Each opponent:
bank: { x: 10, y: oppY, w: cardWidth * 0.7, h: oppCardHeight }
board: { x: 10 + cardWidth * 0.8, y: oppY, w: fullWidth, h: oppCardHeight }

// Local player at bottom:
myY = canvas.height - cardHeight * 2.2
bank: { x: 10, y: myY, w: cardWidth * 1.6, h: cardHeight * 0.9 }
board: { x: 10 + cardWidth * 1.8, y: myY, w: fullWidth, h: cardHeight * 1.2 }
```

#### Card Spacing (lines 286-305)
- **Bank cards:** Opponent spacing = `max(cardWidth * 0.3, 6px)`
- **Board cards:** Column spacing = `max(cardWidth * 1.1, 15px)` for opponents
- **Stack spacing:** `max(cardHeight * 0.25, 8px)` for opponents

#### Zone Drawing (lines 587-632)
- Opponent zones draw normally (rectangles + labels)
- Shows: "Lord X: Hand Y Kingdom" labels
- Shows opponent bank/board cards inside zones

### Test Files Created
- `ui-test/test-mobile.js` - Tests 5 mobile devices
- `ui-test/test-overlap-debug.js` - Visual overlap detection
- `ui-test/test-multiplayer-mobile.js` - 4-player test

## Current Issues

### CRITICAL: Opponent cards not visible
- Zones are drawn (dashed rectangles visible)
- Labels show correct data ("Lord 0: Hand 4 Kingdom")
- **BUT cards themselves aren't rendering in opponent zones**

### Possible Causes
1. Cards positioned at (0,0) or off-screen?
2. Cards too small to see (now 55% should be visible)
3. Cards not being created for opponent bank/board?
4. Z-index or rendering order issue?

### Debug Steps Needed
1. Log opponent card positions in `recalculatePositions()`
2. Check if opponent bank/board arrays have cards
3. Verify cards have valid x,y coordinates
4. Check if cards are being filtered incorrectly

## Working Features
✅ Mobile layout adapts for 2, 3, 4+ players
✅ Opponent hands completely hidden (filtered from render)
✅ Touch events working for drag-and-drop
✅ Local player cards large and readable
✅ Medieval theme looks good
✅ 4/5 mobile devices passing tests

## Next Steps
1. **DEBUG WHY OPPONENT CARDS AREN'T VISIBLE**
2. Add console logging to track opponent card positions
3. Verify entities array contains opponent bank/board cards
4. Check if getCardDisplaySize returns valid dimensions
5. Test with fresh game start

## Key Code Locations
- Mobile layout setup: `ui.js` lines 193-220
- Card size calculation: `ui.js` lines 69-86
- Draw filtering: `ui.js` lines 350-354
- Card positioning: `ui.js` lines 286-305
- Zone rendering: `ui.js` lines 587-632

## Model Used
Sonnet 4.5 (claude-sonnet-4-5-20250929)
