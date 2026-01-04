#!/usr/bin/env node

// Entry point for the CLI
import { main } from '../dist/cli/index.js';

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
