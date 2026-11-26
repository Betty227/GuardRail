const fs = require("node:fs");
const path = require("node:path");
const {execFileSync} = require("node:child_process");
const {ethers} = require("hardhat");
const {root,manifest,load,save,live} = require("./runtime");
async function main() {
  if (!live || (await ethers.provider.getNetwork()).chainId !== 44005n) throw Error("Requires Aevum");
  const d = load(manifest);
  const vault = await ethers.getContractAt("GuardRailVault",d.vault);
  const verifier = await vault.verifier();
  const explorer = "https://explorer-test.qday.info";
  const response = await fetch(explorer+"/api/v2/smart-contracts/"+d.vault);
  if (!response.ok || (await response.json()).is_verified !== true) throw Error("Blockscout verification pending");
  const purchases = [];
  for (const intent of process.argv.slice(2)) {
    const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address","bytes32"],[d.vault,ethers.id(intent)]));
    const dir = path.join(root,id);
    execFileSync(process.execPath,["scripts/verify.js",dir]);
    const b = load(path.join(dir,"receipt.json"));
    const p = await vault.payment(id);
    const tx = await ethers.provider.getTransactionReceipt(b.transactions.capture);
    if (!tx || tx.status !== 1 || p.state !== 2n || b.receipt.paymentId !== id ||
        b.domain.verifyingContract !== d.vault || String(b.domain.chainId)!=="44005" || b.verifier !== verifier ||
        !tx.logs.some(l=>l.address.toLowerCase()===d.vault.toLowerCase() && l.topics[0]===vault.interface.getEvent("Captured").topicHash && l.topics[1]===id && vault.interface.parseLog(l).args.outputHash===b.receipt.outputHash))
      throw Error("Unconfirmed settlement");
    const reservation = await ethers.provider.getTransactionReceipt(b.transactions.reserve);
    if (!reservation || reservation.status !== 1 || !reservation.logs.some(log =>
      log.address.toLowerCase() === d.vault.toLowerCase() &&
      log.topics[0] === vault.interface.getEvent("Reserved").topicHash && log.topics[1] === id)) {
      throw Error("Unconfirmed reservation");
    }
    const [reservedBlock, capturedBlock] = await Promise.all([reservation.getBlock(), tx.getBlock()]);
    purchases.push({
      intent, paymentId:id, settlement:explorer+"/tx/"+tx.hash, retryLookup:tx.hash,
      chain: {
        budgetDay: Number(p.budgetDay),
        authorizedAt: new Date(reservedBlock.timestamp * 1000).toISOString(),
        closedAt: new Date(capturedBlock.timestamp * 1000).toISOString(),
      },
    });
  }
  if (new Set(purchases.map(p=>p.paymentId)).size < 2) throw Error("Supply two distinct settled intents");
  const out = path.join("evidence","aevum",d.vault);
  fs.mkdirSync(out,{recursive:true});
  for (const p of purchases) {
    const dest = path.join(out,p.paymentId);
    fs.mkdirSync(dest,{recursive:true});
    for (const name of ["order.csv","report.json","receipt.json"]) fs.copyFileSync(path.join(root,p.paymentId,name),path.join(dest,name));
  }
  const indexPath = path.join(out, "index.json");
  const rejected = fs.existsSync(indexPath) ? load(indexPath).purchases.filter(entry => entry.status === "rejected") : [];
  save(indexPath, {chainId:44005, vault:d.vault, verifiedSource:explorer+"/address/"+d.vault+"?tab=contract",
    purchases: [...purchases, ...rejected]});
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
