const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tools, commandForTool } = require('./codextools.cjs');

test('crew tools are advertised and route through the existing CLI', () => {
  assert.ok(tools.some(t => t.name === 'muster_message_crew'));
  assert.ok(tools.some(t => t.name === 'muster_read_crew_chat'));
  const text = 'M7 handover\nBranch: codex/m7-voice-tracking; $(literal)';
  assert.deepEqual(commandForTool('muster_message_crew', { text }), ['say', 'everyone', text]);
  assert.deepEqual(commandForTool('muster_read_crew_chat', {}), ['chat', '--limit', '50']);
  assert.deepEqual(commandForTool('muster_message_captain', { text }), ['say', 'captain', text]);
  assert.deepEqual(commandForTool('muster_status', { section: 'tasks' }), ['tasks']);
});

test('invalid calls cannot choose another command or recipient', () => {
  for (const args of [null, [], {}, { text: '' }, { text: ' ' }, { text: 3 }, { text: 'x'.repeat(8001) }, { text: 'hi', to: 'other' }]) {
    assert.throws(() => commandForTool('muster_message_crew', args), /Invalid/);
  }
  assert.throws(() => commandForTool('muster_read_crew_chat', { follow: true }), /Invalid/);
  assert.throws(() => commandForTool('unknown', {}), /Invalid/);
});

test('agent conversations and board replies use project CLI with literal arguments', () => {
  const text = 'Review this change; $(literal)';
  assert.deepEqual(commandForTool('muster_message_agent', { to: 'crew-2', text }), ['say', 'crew-2', text]);
  assert.deepEqual(commandForTool('muster_read_agent_chat', { agent: 'design' }), ['chat', '--agent', 'design', '--limit', '50']);
  assert.deepEqual(commandForTool('muster_reply_note', { note: 'n12', text }), ['reply', 'N12', text]);
  for (const to of ['--help', '../other', 'all', 'everyone', 'you', 'a b', '']) assert.throws(() => commandForTool('muster_message_agent', { to, text }), /Invalid/);
  for (const note of ['--close', 'N0', '../N1', '']) assert.throws(() => commandForTool('muster_reply_note', { note, text }), /Invalid/);
  assert.throws(() => commandForTool('muster_read_agent_chat', { agent: '--help' }), /Invalid/);
  assert.throws(() => commandForTool('muster_message_agent', { to: 'crew-2', text, command: 'other' }), /Invalid/);
});
