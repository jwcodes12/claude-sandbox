const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const tests = [
    { name: 'Unit Tests - Card Verification', script: 'test-unit-cards.js' },
    { name: 'Comprehensive Game Test', script: 'test-comprehensive.js' },
    { name: 'Full Game Simulation', script: 'test-full-game.js' }
];

const results = {
    timestamp: new Date().toISOString(),
    tests: [],
    summary: {
        total: tests.length,
        passed: 0,
        failed: 0
    }
};

function runTest(testConfig) {
    return new Promise((resolve, reject) => {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`Running: ${testConfig.name}`);
        console.log(`${'='.repeat(70)}\n`);

        const startTime = Date.now();
        const child = spawn('node', [testConfig.script], {
            cwd: __dirname,
            stdio: 'inherit'
        });

        child.on('exit', (code) => {
            const duration = Date.now() - startTime;
            const result = {
                name: testConfig.name,
                script: testConfig.script,
                exitCode: code,
                duration,
                success: code === 0
            };

            results.tests.push(result);

            if (code === 0) {
                results.summary.passed++;
                console.log(`\n✓ ${testConfig.name} PASSED (${(duration / 1000).toFixed(2)}s)\n`);
                resolve(result);
            } else {
                results.summary.failed++;
                console.log(`\n✗ ${testConfig.name} FAILED (${(duration / 1000).toFixed(2)}s)\n`);
                resolve(result); // Don't reject, continue with other tests
            }
        });

        child.on('error', (error) => {
            results.summary.failed++;
            console.error(`\n✗ ${testConfig.name} ERROR: ${error.message}\n`);
            resolve({ name: testConfig.name, error: error.message, success: false });
        });
    });
}

async function runAllTests() {
    console.log('\n' + '='.repeat(70));
    console.log('LORD LANDLORD - COMPREHENSIVE TEST SUITE');
    console.log('='.repeat(70));

    for (const test of tests) {
        await runTest(test);
        // Wait a bit between tests to ensure ports are freed
        await new Promise(r => setTimeout(r, 2000));
    }

    // Generate final report
    console.log('\n' + '='.repeat(70));
    console.log('FINAL TEST REPORT');
    console.log('='.repeat(70));
    console.log(`\nTimestamp: ${results.timestamp}`);
    console.log(`Total Tests: ${results.summary.total}`);
    console.log(`✓ Passed: ${results.summary.passed}`);
    console.log(`✗ Failed: ${results.summary.failed}`);
    console.log(`Success Rate: ${((results.summary.passed / results.summary.total) * 100).toFixed(1)}%\n`);

    console.log('Individual Test Results:');
    results.tests.forEach((test, idx) => {
        const status = test.success ? '✓ PASS' : '✗ FAIL';
        const duration = test.duration ? `(${(test.duration / 1000).toFixed(2)}s)` : '';
        console.log(`  ${idx + 1}. ${status} - ${test.name} ${duration}`);
    });

    // Save results
    fs.writeFileSync('test-report-full.json', JSON.stringify(results, null, 2));
    console.log(`\nFull report saved to: test-report-full.json`);

    // Check for artifacts
    console.log('\nGenerated Artifacts:');
    const artifacts = [
        'test-unit-results.json',
        'test-results.json',
        'test-full-game.png',
        'screenshots/'
    ];

    artifacts.forEach(artifact => {
        const artifactPath = path.join(__dirname, artifact);
        if (fs.existsSync(artifactPath)) {
            const stats = fs.statSync(artifactPath);
            if (stats.isDirectory()) {
                const files = fs.readdirSync(artifactPath);
                console.log(`  ✓ ${artifact} (${files.length} files)`);
            } else {
                console.log(`  ✓ ${artifact} (${(stats.size / 1024).toFixed(2)} KB)`);
            }
        } else {
            console.log(`  - ${artifact} (not found)`);
        }
    });

    console.log('\n' + '='.repeat(70));

    return results.summary.failed === 0;
}

runAllTests().then(success => {
    process.exit(success ? 0 : 1);
}).catch(error => {
    console.error('Test runner error:', error);
    process.exit(1);
});
