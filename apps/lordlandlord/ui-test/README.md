# Lord Landlord - Test Suite

Comprehensive automated testing for the Lord Landlord card game.

## Overview

This test suite provides complete coverage of:
- Card deck composition and validation
- Game mechanics and rules
- Full game simulation from start to finish
- Visual regression testing with screenshots
- All card effects and interactions

## Prerequisites

```bash
npm install
```

Dependencies:
- `express` - Web server for hosting game
- `puppeteer` - Headless browser automation

## Running Tests

### Run All Tests
```bash
npm test
```

This runs the complete test suite including:
1. Unit tests (card verification)
2. Comprehensive game simulation
3. Full game playthrough

### Run Individual Test Suites

#### Unit Tests Only
```bash
npm run test:unit
```
Tests all card types, counts, and basic game mechanics.
- **Duration:** ~30 seconds
- **Output:** `test-unit-results.json`

#### Comprehensive Test
```bash
npm run test:comprehensive
```
Full game simulation with detailed state tracking and screenshots.
- **Duration:** ~2 minutes
- **Output:** `test-results.json`, `screenshots/`

#### Quick Full Game
```bash
npm run test:full-game
```
Runs a quick 3-player auto-duel game.
- **Duration:** ~30 seconds
- **Output:** `test-full-game.png`

## Test Structure

```
ui-test/
├── test-unit-cards.js       # Unit tests for all card types
├── test-comprehensive.js    # Full game simulation with screenshots
├── test-full-game.js        # Quick game test
├── run-all-tests.js         # Master test runner
├── screenshots/             # Generated game screenshots
├── test-unit-results.json   # Unit test results
├── test-results.json        # Comprehensive test results
└── test-report-full.json    # Master test report
```

## Test Coverage

### Card Type Tests (44 tests)
- ✅ Money cards (6 tests)
- ✅ Property cards (11 tests)
- ✅ Wild/Joker cards (3 tests)
- ✅ Rent cards (3 tests)
- ✅ Action cards (9 tests)
- ✅ Building cards (3 tests)
- ✅ Total deck verification (2 tests)
- ✅ Game mechanics (4 tests)
- ✅ Rent calculation (2 tests)

### Game Simulation Tests
- ✅ Full game playthrough
- ✅ Win condition detection
- ✅ Turn progression
- ✅ Card effect execution
- ✅ Property set completion
- ✅ Bank value tracking
- ✅ Visual state capture

## Understanding Test Results

### Unit Test Output
```
==================================================
TEST SUMMARY
==================================================
Total Tests: 44
✓ Passed: 44
✗ Failed: 0
Success Rate: 100.0%
==================================================
```

### Comprehensive Test Output
```
=== TEST SUMMARY ===
Total turns: 180
Winner: Player 0
Screenshots taken: 13
Card effects tested: 9
Cards observed: 11
```

## Screenshot Output

Screenshots are saved to `screenshots/` directory with timestamps:

- `00-splash-screen-*.png` - Initial menu
- `lobby-*.png` - Lobby screen
- `01-initial-state-*.png` - Game start
- `turn-XX-*.png` - Game state at turn XX
- `final-winner-*.png` - Victory screen

## Test Artifacts

After running tests, the following files are generated:

1. **test-unit-results.json** - Detailed unit test results
   - Card counts and types
   - Test pass/fail status
   - Individual test assertions

2. **test-results.json** - Comprehensive test data
   - Turn-by-turn game state
   - Player statistics
   - Card distribution
   - Screenshot references

3. **test-report-full.json** - Master report
   - All test suite results
   - Execution times
   - Success rates

4. **Screenshots/** - Visual verification
   - Game state captures
   - Progress throughout game
   - Final victory screen

## Continuous Integration

These tests can be integrated into CI/CD pipelines:

```yaml
# Example GitHub Actions
- name: Run Tests
  run: |
    cd ui-test
    npm install
    npm test
```

## Debugging Tests

To run tests in non-headless mode (see the browser):

Edit test file and change:
```javascript
const browser = await puppeteer.launch({ headless: "new" });
```
to:
```javascript
const browser = await puppeteer.launch({ headless: false });
```

## Test Development

### Adding New Tests

1. Create new test file in `ui-test/`
2. Add npm script to `package.json`
3. Include in `run-all-tests.js`

Example test template:
```javascript
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3002; // Use unique port
app.use(express.static(path.join(__dirname, '..')));

const server = app.listen(PORT, async () => {
    const browser = await puppeteer.launch({ headless: "new" });
    const page = await browser.newPage();

    try {
        await page.goto(`http://localhost:${PORT}/src/index.html`);
        // Your test logic here
        await browser.close();
    } catch (error) {
        console.error(error);
        await browser.close();
        process.exit(1);
    } finally {
        server.close();
        process.exit(0);
    }
});
```

## Known Issues

- Port conflicts: Tests use ports 3000, 3001, 3002
- Screenshot timing: May vary based on system performance
- Browser dependencies: Requires Chrome/Chromium

## Performance Benchmarks

- **Unit Tests:** ~30 seconds
- **Comprehensive Test:** ~2 minutes
- **Full Game Test:** ~30 seconds
- **Total Suite:** ~3 minutes

## Contributing

When adding new features to the game:
1. Add corresponding tests
2. Update test documentation
3. Verify all tests pass
4. Add screenshots if visual changes

## Support

For issues with tests:
1. Check console output for errors
2. Verify all dependencies installed
3. Ensure no port conflicts
4. Check browser compatibility

## License

Same as parent project.
