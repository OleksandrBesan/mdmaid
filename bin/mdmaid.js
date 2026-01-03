#!/usr/bin/env node

// Entry point for the CLI
// This file will be linked when installed globally
const { main } = require('../dist/cli/index.js');

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
