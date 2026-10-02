// Vitest setup: defaults the older tests were written against (numbered crew ids, no evidence gate).
import { DEFAULT_CONFIG } from '../types.js';

DEFAULT_CONFIG.crewNames = 'numbers';
DEFAULT_CONFIG.requireEvidence = false; // flow tests flag tasks without attaching evidence; evidence tests turn it on
