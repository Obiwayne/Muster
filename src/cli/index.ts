// Entry point for the `muster` CLI (bin/muster.js imports dist/cli/index.js).
import { main } from './program.js';

main(process.argv).then((code) => {
  process.exitCode = code;
});
