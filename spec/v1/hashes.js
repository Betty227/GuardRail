const { createHash } = require("node:crypto");
const hash = bytes => "0x" + createHash("sha256").update(bytes).digest("hex");

// v1 report keys are fixed ASCII schema properties. Preserve array order.
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map(k => canonical(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw Error("Expected safe integer");
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
module.exports = { hash, canonical };
