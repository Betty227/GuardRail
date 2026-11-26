const fs = require("node:fs");
const path = require("node:path");
const {ethers, artifacts} = require("hardhat");
const {live,root,manifest,save,load,signer} = require("./runtime");
async function main() {
  const owner = await signer("OWNER",0);
  const locals = live ? [] : await ethers.getSigners();
  const address = (role,i) => ethers.getAddress(live ? process.env["GUARDRAIL_"+role] : locals[i].address);
  const agent = address("AGENT",1), verifier = address("VERIFIER",2), merchant = address("MERCHANT",3);
  if (new Set([owner.address,agent,verifier,merchant]).size !== 4 || [agent,verifier,merchant].includes(ethers.ZeroAddress)) throw Error("Four distinct nonzero addresses required");
  const chainId = (await ethers.provider.getNetwork()).chainId.toString();
  let d;
  if (fs.existsSync(manifest)) {
    d = load(manifest);
    if ([chainId,owner.address,agent,verifier,merchant].join() !== [d.chainId,d.owner,d.agent,d.verifier,d.merchant].join()) throw Error("Deployment configuration differs");
  } else {
    const asset = live ? "0x456569838f1d43009A91ebA4263147Afd7233483" : (await ethers.deployContract("TestAsset",[],owner)).target;
    const token = new ethers.Contract(asset,["function decimals() view returns(uint8)","function balanceOf(address) view returns(uint256)"],owner);
    if (await token.decimals() !== 6n || await token.balanceOf(owner.address) < 200000n) throw Error("Need six-decimal token and 0.20 tokens for two orders");
    if (live && (!await ethers.provider.getBalance(agent) || !await ethers.provider.getBalance(owner.address))) throw Error("Owner and agent both need test gas");
    const vault = await ethers.deployContract("GuardRailVault",[asset,owner.address,verifier],owner);
    const tx = await vault.deploymentTransaction().wait();
    d = {chainId,owner:owner.address,agent,verifier,merchant,asset,vault:vault.target,block:tx.blockNumber,deploymentTx:tx.hash,ready:false};
    save(manifest,d);
  }
  const vault = await ethers.getContractAt("GuardRailVault",d.vault,owner);
  if (await vault.verifier() !== verifier || await vault.token() !== d.asset || await vault.owner() !== owner.address) throw Error("Vault identity mismatch");
  if (!d.ready) {
    const token = await ethers.getContractAt("IERC20",d.asset,owner);
    const shortfall = 200000n - await token.balanceOf(d.vault);
    if (shortfall > 0n) {
      await (await token.approve(d.vault,shortfall)).wait();
      await (await vault.deposit(shortfall)).wait();
    }
    await (await vault.setPolicy(agent,100000,200000)).wait();
    await (await vault.setMerchant(merchant,true)).wait();
    d.ready = true; save(manifest,d);
  }
  const build = await artifacts.getBuildInfo("contracts/GuardRailVault.sol:GuardRailVault");
  save(path.join(root,"standard-input.json"),build.input);
  console.log(d.vault, "ready", manifest);
}
main().catch(e=>{console.error(e.shortMessage || e.message);process.exitCode=1;});
