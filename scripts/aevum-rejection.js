const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");
const { live, manifest, load, save, signer } = require("./runtime");
const { hash, canonical } = require("../spec/v1/hashes");
const { orderFor, deliver, accept } = require("../workbench/procurement");

async function main() {
  if (!live || (await ethers.provider.getNetwork()).chainId !== 44005n) throw Error("Aevum required");
  const d = load(manifest);
  const owner = await signer("OWNER", 0);
  const agent = await signer("AGENT", 1);
  const vault = await ethers.getContractAt("GuardRailVault", d.vault, owner);
  const asset = await ethers.getContractAt("IERC20", d.asset, owner);
  if (!d.ready || owner.address !== d.owner || agent.address !== d.agent ||
      await vault.owner() !== d.owner || await vault.agent() !== d.agent ||
      await vault.verifier() !== d.verifier || await vault.token() !== d.asset ||
      !await vault.merchants(d.merchant)) throw Error("Unexpected Aevum deployment or roles");

  const reference = "order-rejected-001";
  const request = { intent: reference, format: "xml", quantity: 21, fault: true };
  const { input } = orderFor(request);
  const report = deliver("b", request);
  const checks = await accept(input, request.format, report);
  const failed = checks.filter(check => check.status === "fail").map(check => check.id);
  if (failed.join() !== "ARITHMETIC") throw Error("Synthetic fault did not reproduce");
  const inputHash = hash(Buffer.from(input));
  const outputHash = hash(canonical(report));
  const intent = ethers.id(reference);
  const paymentId = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "bytes32"], [d.vault, intent]));
  const amount = 100000n;
  const perPaymentCap = 100000n;
  const baseline = 200000n;
  const budget = await vault.dailyCap();
  if (await vault.perPaymentCap() !== perPaymentCap || ![baseline, baseline + amount].includes(budget)) {
    throw Error("Unexpected spending limits. Inspect the vault before continuing.");
  }

  let payment = await vault.payment(paymentId);
  if (payment.state === 2n || (payment.state !== 0n &&
      (payment.quote.inputHash !== inputHash || payment.quote.amount !== amount ||
       payment.quote.merchant !== d.merchant))) throw Error("Unexpected payment state");
  async function send(label, method, ...args) {
    const estimated = await method.estimateGas(...args);
    const { gasPrice } = await ethers.provider.getFeeData();
    console.log(label, "estimated fee", ethers.formatEther(estimated * gasPrice), "tQDAY");
    const tx = await method(...args);
    console.log(label, tx.hash);
    return tx.wait();
  }

  try {
    if (payment.state === 0n) {
      const free = (await asset.balanceOf(d.vault)) - await vault.reserved();
      const shortfall = amount - free;
      if (shortfall > 0n) {
        if (await asset.balanceOf(d.owner) < shortfall) throw Error("Owner has insufficient tUSD8");
        if (await asset.allowance(d.owner, d.vault) !== shortfall) await send("Approve", asset.approve, d.vault, shortfall);
        await send("Deposit", vault.deposit, shortfall);
      }
      const { timestamp } = await ethers.provider.getBlock("latest");
      const day = Math.floor((timestamp + 28800) / 86400);
      const required = (await vault.dayUsed(day)) + amount;
      if (required > baseline + amount) throw Error("Required budget exceeds approved demo amount");
      if (required > budget) await send("Raise daily limit", vault.setPolicy, d.agent, perPaymentCap, required);
      const quote = {
        merchant: d.merchant, amount, inputHash,
        serviceVersion: ethers.id("merchant-b-v1"), rulesVersion: ethers.id("buyer-v1"),
        deadline: timestamp + 3600,
      };
      await send("Reserve", vault.connect(agent).reserve, intent, quote);
      payment = await vault.payment(paymentId);
    }
    if (payment.state === 1n) await send("Release", vault.voidPayment, paymentId);
  } finally {
    if (await vault.dailyCap() !== baseline) {
      await send("Restore daily limit", vault.setPolicy, d.agent, perPaymentCap, baseline);
    }
  }

  const search = async filter => {
    const end = await ethers.provider.getBlockNumber();
    const matches = [];
    for (let start = d.block; start <= end; start += 1000) {
      matches.push(...await vault.queryFilter(filter, start, Math.min(end, start + 999)));
    }
    if (matches.length !== 1) throw Error("Expected exactly one matching event");
    return matches[0];
  };
  const reserve = await search(vault.filters.Reserved(paymentId));
  const release = await search(vault.filters.Voided(paymentId));
  payment = await vault.payment(paymentId);
  const start = await reserve.getBlock();
  const end = await release.getBlock();
  const day = payment.budgetDay;
  const snapshot = async blockTag => {
    const [balance, reserved, used, merchant] = await Promise.all([
      asset.balanceOf(d.vault, { blockTag }), vault.reserved({ blockTag }),
      vault.dayUsed(day, { blockTag }), asset.balanceOf(d.merchant, { blockTag }),
    ]);
    return { available: balance - reserved, reserved, used, merchant };
  };
  const [before, held, after] = await Promise.all([
    snapshot(start.number - 1), snapshot(start.number), snapshot(end.number),
  ]);
  if (payment.state !== 3n || end.timestamp > payment.quote.deadline ||
      before.available - held.available !== amount || held.reserved - before.reserved !== amount ||
      held.used - before.used !== amount ||
      !Object.keys(before).every(key => before[key] === after[key])) throw Error("Rejection accounting did not reconcile");

  const explorer = "https://explorer-test.qday.info/tx/";
  const chain = {
    budgetDay: Number(day),
    authorizedAt: new Date(start.timestamp * 1000).toISOString(),
    closedAt: new Date(end.timestamp * 1000).toISOString(),
  };
  const decision = {
    reference, mode: "aevum", chainId: 44005, vault: d.vault, paymentId,
    format: request.format, merchant: d.merchant, status: "rejected",
    fee: ethers.formatUnits(amount, 6), paid: "0.00", checks, inputHash, outputHash, ...chain,
    transactions: { reserve: reserve.transactionHash, void: release.transactionHash },
    submittedBy: d.owner, deadline: Number(payment.quote.deadline),
    accounting: Object.fromEntries(Object.entries({ before, held, after }).map(([label, state]) => [
      label, Object.fromEntries(Object.entries(state).map(([key, value]) => [key, value.toString()])),
    ])),
  };
  const root = path.join("evidence", "aevum", d.vault);
  const indexPath = path.join(root, "index.json");
  const index = load(indexPath);
  const directory = path.join(root, paymentId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "order.xml"), input);
  save(path.join(directory, "report.json"), report);
  save(path.join(directory, "decision.json"), decision);
  index.purchases = index.purchases.filter(entry => entry.paymentId !== paymentId);
  index.purchases.push({ intent: reference, paymentId, status: "rejected", release: explorer + release.transactionHash, chain });
  save(indexPath, index);
  console.log(JSON.stringify({ paymentId, reserve: explorer + reserve.transactionHash, release: explorer + release.transactionHash, ...decision.accounting }, null, 2));
}

main().catch(error => {
  console.error(error.shortMessage || error.message);
  process.exitCode = 1;
});
