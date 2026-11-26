"""Run the buyer's rules against both fixture formats."""
import json
from copy import deepcopy
from pathlib import Path

from acceptance import failures, parse_order

ROOT = Path(__file__).resolve().parent
report = json.loads((ROOT / "report.json").read_text())
csv_rows = parse_order((ROOT / "order.csv").read_text(), "csv")
xml_rows = parse_order((ROOT / "order.xml").read_text(), "xml")
assert xml_rows == csv_rows
for rows in (csv_rows, xml_rows):
    assert not failures(rows, report)
    for expected in ("ORDER", "LINES", "CURRENCY", "SOURCE_FIELDS", "ARITHMETIC"):
        candidate, inputs = deepcopy(report), deepcopy(rows)
        if expected == "ORDER":
            candidate["order_id"] = "OTHER"
        elif expected == "LINES":
            candidate["lines"][1] = candidate["lines"][0]
        elif expected == "CURRENCY":
            inputs[0]["currency"] = "USD"
        elif expected == "SOURCE_FIELDS":
            candidate["lines"][0]["sku"] = "OTHER"
        else:
            candidate["lines"][0]["delta_minor"] = 0
        assert failures(inputs, candidate) == {expected}, expected
print("CSV and XML each passed 1 acceptance and 5 rejection cases.")
