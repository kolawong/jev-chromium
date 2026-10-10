/**
 * Standalone verification script for TypeSafe Jev API and MiniMax-M3 text helper in Node.js.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const { choose, fieldText } = require('../src/agent/model');

async function main() {
  console.log('1. Testing MiniMax Text Model...');
  const textCtx = {
    goal: 'Find one-way flights from Zurich to London on Sept 20, 2026',
    field: { label: 'Where from?', role: 'combobox', value: '' },
    page: { title: 'Google Flights', text: 'Flights search' },
    recent_actions: [],
  };
  const textResult = await fieldText(textCtx);
  console.log('   Text model output:', textResult.value);
  console.log('   Latency:', textResult.helper.latency_ms, 'ms');

  console.log('\n2. Testing TypeSafe Jev Decision Model...');
  const fakeState = {
    url: 'https://www.google.com/travel/flights?hl=en',
    title: 'Google Flights',
    text: 'Flights search header',
    actions: [
      { id: 'e1', node: 1, kind: 'click', label: 'Change ticket type. Round trip', role: 'combobox' },
      { id: 'e2', node: 2, kind: 'fill', label: 'Where from?', role: 'combobox', value: '' },
      { id: 'e3', node: 3, kind: 'fill', label: 'Where to?', role: 'combobox', value: '' },
    ],
  };
  const decision = await choose(fakeState, textCtx.goal, []);
  console.log('   Jev decision operation:', decision.operation);
  console.log('   Jev choice id:', decision.choice);
  console.log('   Confidence:', Math.round(decision.confidence * 100) + '%');
  console.log('   Latency:', decision.latency_ms, 'ms');

  console.log('\nALL MODEL TESTS PASSED SUCCESSFULLY');
}

main().catch((err) => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});
