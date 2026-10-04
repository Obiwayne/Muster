// Vitest setup: defaults the older tests were written against (numbered crew ids, no evidence gate).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../types.js';

DEFAULT_CONFIG.crewNames = 'numbers';
DEFAULT_CONFIG.requireEvidence = false; // flow tests flag tasks without attaching evidence; evidence tests turn it on

// Servers started in tests keep their tokens and the shared research-browser state (visible.json) under the secrets
// base: point it at a temp folder so no test ever touches the real %LOCALAPPDATA%/muster (tests that need their own set it).
process.env.MUSTER_SECRETS_DIR ??= join(tmpdir(), 'muster-test-secrets');
