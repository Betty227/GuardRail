# Persistent GuardRail demo

Run commands from the GuardRail directory. Use Node 22 LTS, npm ci, and a Python 3 environment with jsonschema installed. Start a persistent local chain with npx hardhat node. In a second shell use:

    npx hardhat run scripts/deploy.js --network localhost
    GUARDRAIL_INTENT=order-001 npx hardhat run scripts/purchase.js --network localhost
    GUARDRAIL_INTENT=order-001 npx hardhat run scripts/purchase.js --network localhost
    GUARDRAIL_INTENT=order-002 npx hardhat run scripts/purchase.js --network localhost

These CLI commands exercise a fixed synthetic CSV purchase. Keep the chain and runtime directory across invocations. Each command starts its own application process. Use a fresh GUARDRAIL_STATE_DIR when starting a completely new local chain.

## Single-process sandbox

After deployment run `HARDHAT_NETWORK=localhost node scripts/sandbox.js`. Send an empty POST to `http://127.0.0.1:3030/purchases/order-001`. Choose a new reference for a new purchase. Responses contain the payment ID and settlement hash. Use exactly one writing process per agent address, including CLI jobs. The queue allows eight distinct pending intents, shares the promise for an identical pending reference and waits for confirmation before processing the next intent. The direct socket peer has twelve requests per minute. Behind a reverse proxy enforce per-client limits at the proxy as well; the app treats proxied connections as coming from the proxy. Set GUARDRAIL_ALLOWED_ORIGIN to the exact browser origin when serving a frontend. For a fresh localhost deployment run `HARDHAT_NETWORK=localhost node scripts/check-sandbox.js` to exercise simultaneous HTTP requests.

After explorer verification and two successful live purchases, run `HARDHAT_NETWORK=aevum node scripts/export-replay.js order-001 order-002` with the actual references. This exports public replay bundles into evidence/aevum. A recovered lookup points to the original settlement transaction.

## Aevum testnet

For deployment set GUARDRAIL_OWNER_KEY in the local process environment and set GUARDRAIL_AGENT, GUARDRAIL_VERIFIER and GUARDRAIL_MERCHANT to three independent public addresses. All four roles must differ. Fund owner and agent with test gas and owner with at least 0.20 tUSD8. Replace localhost with aevum in the commands above. The deployment command checks the token decimals, signer configuration and funding, then deposits exactly 0.20 tUSD8 for the two purchases. Its public manifest is reused on the next invocation. Keep a backup of the deployment manifest and protect local signing keys separately.

For purchases use GUARDRAIL_AGENT_KEY and GUARDRAIL_VERIFIER_KEY in the purchase process. This synthetic CLI co-locates those two signers. A public service should isolate the verifier from the web handler and give the handler only the agent role. The purchase command does not use the owner key. Variables are read from the process environment.

For a live early rejection, the owner or verifier can submit `voidPayment`. If the verifier submits it, provision tQDAY for that signer based on the estimated transaction fee and expected number of releases. Off-chain signing does not consume gas. The AGENT can submit a release only after the deadline unless it also holds an authorized role. See [payment controls](README.md#payment-controls).

For Blockscout select Solidity standard JSON input and use runtime/aevum/standard-input.json, Solidity v0.8.24+commit.e11b9ed9 and contracts/GuardRailVault.sol:GuardRailVault. Constructor ABI types are address,address,address in manifest order asset, owner, verifier. Check verified status at the actual deployed address.

For a locally captured bundle run node scripts/verify.js runtime/<network>/<paymentId>. Use the deployed vault to determine the trusted signer independently. Public evidence should include the deployment address, settlement hash, synthetic input/report and signed receipt.

## Procurement workbench

Run `npm run workbench` and open `http://127.0.0.1:3030`. Use Node 22 and Python 3 with `jsonschema`.
The workbench loads the checked-in Aevum evidence as read-only replay. It starts an isolated
Hardhat chain (31337) for interactive orders. Local transaction history resets with the workbench
process. Download evidence to retain a record. The workbench requires no wallet or Aevum credentials.

CSV routes to the lower-priced merchant. XML routes to the merchant that supports both formats.
Both simulated merchant adapters expose JSON POST endpoints at `/api/merchants/a` and
`/api/merchants/b`. They take the same synthetic order parameters as `/api/purchases`:
`intent`, `format`, `quantity`, and `fault`. The purchase API reserves the quoted fee before
running buyer-side acceptance. On rejection the verifier releases the reservation immediately.

Use **Retry same intent** to recover the prior result. **Run purchase** creates a new intent.
For an evidence download, extract the ZIP and run `node scripts/verify.js <directory>`. A rejected
download contains the decision and void transaction reference. The verifier can independently
reproduce the failed rules from the original files without a settlement signature.

### Aevum rejection evidence

`scripts/aevum-rejection.js` exports the fixed synthetic XML rejection as a separate order.
Run it with `HARDHAT_NETWORK=aevum` and the local deployment and purchase environments.
It can write testnet transactions. The agent reserves 0.10 tUSD8 and the owner releases the
reservation. The script tops up any vault shortfall, temporarily raises the configured daily
cap when needed, and restores the baseline cap. Run the writer serially. The evidence records
the available balance, reservation, original day usage and merchant balance before, during
and after the release. Re-running the same intent can re-export its evidence.
