// Integration check against a fresh funded local deployment.
const assert = require("node:assert/strict");
const {ethers,network} = require("hardhat");
const {sandbox} = require("./sandbox");
const {purchase} = require("./purchase");
const {load,manifest} = require("./runtime");
async function main() {
  assert.equal(network.name,"localhost");
  const d = load(manifest);
  const token = await ethers.getContractAt("IERC20",d.asset);
  const before = await token.balanceOf(d.merchant);
  let calls = 0;
  const server = sandbox(intent => {calls++; return purchase(intent);},{perMinute:5});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const url = "http://127.0.0.1:" + server.address().port + "/purchases/";
  const post = intent => fetch(url+intent,{method:"POST"});
  try {
    const replies = await Promise.all(["first","first","second"].map(post));
    assert(replies.every(r=>r.ok));
    const [a,b,c] = await Promise.all(replies.map(r=>r.json()));
    assert.equal(a.transactionHash,b.transactionHash);
    assert.notEqual(a.transactionHash,c.transactionHash);
    assert.equal(calls,2);
    const retry = await (await post("first")).json();
    assert.equal(retry.status,"recovered");
    assert.equal(retry.transactionHash,a.transactionHash);
    const refused = await post("third");
    assert.equal(refused.status,502);
    assert.equal((await post("first")).status,429);
    assert.equal(await token.balanceOf(d.merchant)-before,200000n);
    console.log("PASS: concurrent duplicate coalesced, two credits, recovered receipt, budget refusal, IP limit");
  } finally { await new Promise(resolve=>server.close(resolve)); }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
