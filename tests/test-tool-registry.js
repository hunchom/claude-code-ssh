/**
 * Test Suite for Tool Registry
 *
 * Validates that all tools are properly organized into groups
 * and that there are no duplicates or missing tools.
 */

import {
  TOOL_GROUPS,
  TOOL_GROUP_DESCRIPTIONS,
  TOOL_GROUP_COUNTS,
  getAllTools,
  findToolGroup,
  getGroupTools,
  validateToolRegistry,
  getToolStats,
  verifyIntegrity
} from '../src/tool-registry.js';

// Test colors
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`${GREEN}[ok]${NC} ${name}`);
    passedTests++;
  } catch (error) {
    console.log(`${RED}[err]${NC} ${name}`);
    console.log(`  ${RED}Error: ${error.message}${NC}`);
    failedTests++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  Expected: ${expected}\n  Actual: ${actual}`);
  }
}

function assertTrue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

console.log('\n' + YELLOW + 'Running Tool Registry Tests...' + NC + '\n');

test('All 12 v4 tools are defined in groups', () => {
  assertEqual(getAllTools().length, 12, 'Should have exactly 12 tools');
});

test('No duplicate tools across groups', () => {
  const all = getAllTools();
  assertEqual(new Set(all).size, 12, 'All 12 tools should be unique');
});

test('Tool group counts match TOOL_GROUP_COUNTS', () => {
  for (const [groupName, tools] of Object.entries(TOOL_GROUPS)) {
    assertEqual(tools.length, TOOL_GROUP_COUNTS[groupName], `Group ${groupName} count mismatch`);
  }
});

test('All groups have descriptions', () => {
  for (const groupName of Object.keys(TOOL_GROUPS)) {
    assertTrue(groupName in TOOL_GROUP_DESCRIPTIONS, `Group ${groupName} missing description`);
    assertTrue(TOOL_GROUP_DESCRIPTIONS[groupName].length > 0, `Group ${groupName} has empty description`);
  }
});

test('findToolGroup returns correct group', () => {
  assertEqual(findToolGroup('ssh_run'), 'core', 'ssh_run should be in core group');
  assertEqual(findToolGroup('ssh_health'), 'ops', 'ssh_health should be in ops group');
  assertEqual(findToolGroup('ssh_plan'), 'advanced', 'ssh_plan should be in advanced group');
  assertEqual(findToolGroup('nonexistent_tool'), null, 'Should return null for unknown tool');
});

test('getGroupTools returns correct tools', () => {
  assertEqual(getGroupTools('core').length, 3, 'core group should have 3 tools');
  assertTrue(getGroupTools('core').includes('ssh_run'), 'core should include ssh_run');
  assertEqual(getGroupTools('ops').length, 5, 'ops group should have 5 tools');
});

test('core group contains expected tools', () => {
  const core = getGroupTools('core');
  for (const tool of ['ssh_run', 'ssh_file', 'ssh_logs']) {
    assertTrue(core.includes(tool), `core should include ${tool}`);
  }
});

test('verifyIntegrity returns valid', () => {
  const integrity = verifyIntegrity();
  assertTrue(integrity.valid, 'Integrity check should pass');
  assertEqual(integrity.duplicates.length, 0, 'Should have no duplicates');
  assertEqual(integrity.issues.length, 0, 'Should have no issues');
});

test('getToolStats returns correct statistics', () => {
  const stats = getToolStats();
  assertEqual(stats.totalGroups, 3, 'Should have 3 groups');
  assertEqual(stats.totalTools, 12, 'Should have 12 total tools');
  assertEqual(stats.groups.length, 3, 'Should have 3 group entries');
});

test('All tools follow ssh_* naming convention', () => {
  for (const tool of getAllTools()) {
    assertTrue(tool.startsWith('ssh_'), `Tool ${tool} should start with 'ssh_'`);
  }
});

test('validateToolRegistry identifies correct tools', () => {
  const validation = validateToolRegistry(getAllTools());
  assertTrue(validation.valid, 'Validation should pass for all tools');
  assertEqual(validation.missing.length, 0, 'Should have no missing tools');
  assertEqual(validation.unexpected.length, 0, 'Should have no unexpected tools');
  assertEqual(validation.total, 12, 'Should expect 12 tools');
  assertEqual(validation.registered, 12, 'Should register 12 tools');
});

test('validateToolRegistry detects missing tools', () => {
  const validation = validateToolRegistry(['ssh_run', 'ssh_file']);
  assertTrue(!validation.valid, 'Validation should fail for partial list');
  assertEqual(validation.registered, 2, 'Should show 2 registered');
  assertTrue(validation.missing.length > 0, 'Should have missing tools');
});

test('Group sizes match specifications', () => {
  assertEqual(TOOL_GROUPS.core.length, 3, 'core should have 3 tools');
  assertEqual(TOOL_GROUPS.ops.length, 5, 'ops should have 5 tools');
  assertEqual(TOOL_GROUPS.advanced.length, 4, 'advanced should have 4 tools');
});

console.log('\n' + '='.repeat(60));
console.log(`${GREEN}Passed: ${passedTests}${NC}`);
console.log(`${RED}Failed: ${failedTests}${NC}`);
console.log('='.repeat(60) + '\n');

process.exit(failedTests > 0 ? 1 : 0);
