const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const live = network.name === "aevum";
if (!live && network.name !== "localhost") throw Error("Select --network localhost or aevum");
const root = path.resolve(process.env.GUARDRAIL_STATE_DIR || "runtime", network.name);
fs.mkdirSync(root, {recursive:true});
const manifest = path.join(root, "deployment.json");
function save(file, data) {
  const temp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data,null,2), {flag:"wx"});
  fs.renameSync(temp,file);
}
const load = file => JSON.parse(fs.readFileSync(file));
async function signer(role, index) {
  if (!live) return (await ethers.getSigners())[index];
  const key = process.env["GUARDRAIL_" + role + "_KEY"];
  if (!key) throw Error("Missing dedicated " + role + " signer");
  return new ethers.Wallet(key,ethers.provider);
}
module.exports = { live, root, manifest, save, load, signer };
