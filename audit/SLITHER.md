# Static analysis

Slither 0.11.4 completed analysis with 4 low-impact, medium-confidence findings. See `slither.json` for the detector output.

- `missing-zero-check` on `setPolicy`. The zero agent address is the owner-controlled revocation sentinel. The regression test checks that agent reservations fail afterward and an existing valid receipt can still settle.
- Three `timestamp` findings cover reservation, capture and void. These operations use the chain timestamp for the quote deadline and Hong Kong calendar day. The chain timestamp determines boundary behavior. Releasing a reservation restores consumption to its original budget day.

To reproduce after compiling, run `slither . --hardhat-ignore-compile --filter-paths 'node_modules|contracts/test' --json audit/slither-local.json`.
