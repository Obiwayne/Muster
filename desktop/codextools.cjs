// Narrow Codex tools backed by the existing project-scoped Muster CLI.
const tools = [
  { type: 'function', name: 'muster_status', description: 'Read Muster project status, tasks or bulletin board.', inputSchema: {
    type: 'object', properties: { section: { type: 'string', enum: ['status', 'tasks', 'board'] } }, required: ['section'], additionalProperties: false } },
  { type: 'function', name: 'muster_message_captain', description: 'Send a message to the project Captain after the user approves the text.', inputSchema: {
    type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
  { type: 'function', name: 'muster_read_crew_chat', description: 'Read the latest messages in the current project crew chat.', inputSchema: {
    type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'muster_message_crew', description: 'Post a message to the current project crew chat (everyone) after the user approves the text.', inputSchema: {
    type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } },
];

tools.push(
  { type: 'function', name: 'muster_message_agent', description: 'Message a team agent in this project after the user approves the text. Read muster_status first to find the agent ID. Messages are sent as you through Muster.', inputSchema: { type: 'object', properties: { to: { type: 'string' }, text: { type: 'string' } }, required: ['to', 'text'], additionalProperties: false } },
  { type: 'function', name: 'muster_read_agent_chat', description: 'Read the latest 50 messages from or to a team agent in this project, including replies. Use its agent ID from muster_status.', inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'], additionalProperties: false } },
  { type: 'function', name: 'muster_reply_note', description: 'Reply to a bulletin-board note after the user approves the text. Read muster_status with section board to find the note ID. Leaves the note open.', inputSchema: { type: 'object', properties: { note: { type: 'string' }, text: { type: 'string' } }, required: ['note', 'text'], additionalProperties: false } },
);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const validText = value => typeof value === 'string' && value.trim() && value.length <= 8000;
function commandForTool(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid Muster tool call.');
  const keys = Object.keys(args);
  if (name === 'muster_message_agent' && keys.length === 2 && validId(args.to) && validText(args.text) && !['all', 'everyone', 'you'].includes(args.to.toLowerCase())) return ['say', args.to, args.text];
  if (name === 'muster_read_agent_chat' && keys.length === 1 && validId(args.agent)) return ['chat', '--agent', args.agent, '--limit', '50'];
  if (name === 'muster_reply_note' && keys.length === 2 && typeof args.note === 'string' && /^N[1-9][0-9]*$/i.test(args.note) && validText(args.text)) return ['reply', args.note.toUpperCase(), args.text];
  if (name === 'muster_status' && keys.length === 1 && ['status', 'tasks', 'board'].includes(args.section)) return [args.section];
  if (name === 'muster_read_crew_chat' && keys.length === 0) return ['chat', '--limit', '50'];
  if (['muster_message_captain', 'muster_message_crew'].includes(name) && keys.length === 1 &&
      typeof args.text === 'string' && args.text.trim() && args.text.length <= 8000) {
    return ['say', name === 'muster_message_crew' ? 'everyone' : 'captain', args.text];
  }
  throw new Error('Invalid Muster tool call.');
}

module.exports = { tools, commandForTool };
