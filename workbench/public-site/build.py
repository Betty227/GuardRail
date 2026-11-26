"""Build the public, browser-only GuardRail demo from the local workbench."""
import json
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
DIST = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else PROJECT / "public-demo/dist"
PUBLIC = PROJECT / "workbench/public"
VAULT = "0xA38A8D54406d417EcFcd884BBA12E18079f74418"
EVIDENCE = PROJECT / "evidence/aevum" / VAULT
sys.path.insert(0, str(PROJECT / "spec/v1"))
from acceptance import failures, parse_order

RULES = {
    "ORDER": "Order reference", "LINES": "Line completeness",
    "CURRENCY": "Currency", "SOURCE_FIELDS": "Source field match",
    "ARITHMETIC": "Arithmetic in HKD cents",
}

def build():
    DIST.mkdir(exist_ok=True)
    (DIST / "evidence").mkdir(exist_ok=True)
    for name in ("styles.css", "sandbox.js"):
        source = PUBLIC / name if name == "styles.css" else HERE / name
        (DIST / name).write_bytes(source.read_bytes())
    html = (PUBLIC / "index.html").read_text().replace(
        '<script defer src="/app.js"></script>',
        '<script defer src="/sandbox.js"></script>\n  <script defer src="/app.js"></script>',
    ).replace("Local Sandbox", "Browser Sandbox").replace(
        "<h2>Run a synthetic order</h2>",
        "<h2>Run a synthetic order</h2><p>Simulated payments. Orders stay in this browser.</p>",
    ).replace("NO WALLET REQUIRED", "NO SIGN-IN · NO WALLET")
    app = (PUBLIC / "app.js").read_text().replace(
        'fetch("/api/records")', 'GuardRailDemo.load()'
    ).replace('fetch("/api/purchases", {\n      method: "POST",\n      headers: { "content-type": "application/json" },\n      body: JSON.stringify(request),\n    })', "GuardRailDemo.purchase(request)")
    assert "/api/" not in app, "Workbench transport changed. Review the public adapter."
    app = app.replace("Local Sandbox", "Browser Sandbox").replace("local test chain", "browser sandbox")
    app = app.replace(
        '  node.href = href;', '  node.href = href;\n  if (href.startsWith("blob:")) node.download = "guardrail-sandbox-evidence.zip";'
    )
    (DIST / "index.html").write_text(html)
    (DIST / "app.js").write_text(app)
    index = json.loads((EVIDENCE / "index.json").read_text())
    records = []
    for purchase in index["purchases"]:
        payment_id = purchase["paymentId"]
        folder = EVIDENCE / payment_id
        archive = "evidence/" + payment_id + ".zip"
        if purchase.get("status") == "rejected":
            decision = json.loads((folder / "decision.json").read_text())
            assert decision["format"] in ("csv", "xml") and decision["paymentId"] == payment_id
            assert decision["vault"] == VAULT and purchase["release"].endswith(decision["transactions"]["void"])
            order_file = "order." + decision["format"]
            source = (folder / order_file).read_text()
            report = json.loads((folder / "report.json").read_text())
            failed = failures(parse_order(source, decision["format"]), report)
            assert failed == {"ARITHMETIC"}
            assert {rule["id"] for rule in decision["checks"] if rule["status"] == "fail"} == failed
            with ZipFile(DIST / archive, "w", ZIP_DEFLATED) as zip_file:
                for name in (order_file, "report.json", "decision.json"):
                    zip_file.write(folder / name, name)
            records.append({**decision, "input": source, "report": report,
                            "release": purchase["release"], "evidence": "/" + archive})
            continue
        source = (folder / "order.csv").read_text()
        report = json.loads((folder / "report.json").read_text())
        bundle = json.loads((folder / "receipt.json").read_text())
        assert bundle["receipt"]["paymentId"] == payment_id and bundle["domain"]["verifyingContract"] == VAULT
        assert purchase["settlement"].endswith(bundle["transactions"]["capture"])
        warnings = failures(parse_order(source, "csv"), report)
        assert not warnings
        with ZipFile(DIST / archive, "w", ZIP_DEFLATED) as zip_file:
            for name in ("order.csv", "report.json", "receipt.json"):
                zip_file.write(folder / name, name)
        records.append({
            "mode": "aevum", "chainId": index["chainId"], "vault": VAULT,
            "reference": purchase["intent"], "paymentId": payment_id, "status": "settled",
            "merchant": bundle["receipt"]["merchant"], "format": "csv", "input": source,
            "report": report, "fee": "0.10", "paid": "0.10", "transactions": bundle["transactions"],
            "checks": [{"id": key, "label": label, "status": "pass"} for key, label in RULES.items()],
            "settlement": purchase["settlement"], "evidence": "/" + archive, **purchase["chain"],
        })
    (DIST / "replay.json").write_text(json.dumps(records, ensure_ascii=False))

if __name__ == "__main__":
    build()
