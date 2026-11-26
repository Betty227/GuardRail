"""Shared buyer-side acceptance rules for synthetic procurement reports."""
import csv
import io
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

from jsonschema import Draft202012Validator

schema = Draft202012Validator(json.loads(Path(__file__).with_name("report.schema.json").read_text()))


def failures(rows, result):
    if not schema.is_valid(result):
        return {"SCHEMA"}
    issues = set()
    source = {row["line_id"]: row for row in rows}
    delivered = {line["line_id"]: line for line in result["lines"]}
    if any(row["order_id"] != result["order_id"] for row in rows):
        issues.add("ORDER")
    if len(source) != len(rows) or len(delivered) != len(result["lines"]) or source.keys() != delivered.keys():
        issues.add("LINES")
    if any(row["currency"] != result["currency"] for row in rows):
        issues.add("CURRENCY")
    for key in source.keys() & delivered.keys():
        row, line = source[key], delivered[key]
        if line["sku"] != row["sku"] or any(line[k] != int(row[k]) for k in ("qty", "unit_minor", "declared_minor")):
            issues.add("SOURCE_FIELDS")
        expected_delta = int(row["declared_minor"]) - int(row["qty"]) * int(row["unit_minor"])
        if line["delta_minor"] != expected_delta:
            issues.add("ARITHMETIC")
    return issues


def parse_order(raw, file_format):
    if file_format == "csv":
        return list(csv.DictReader(io.StringIO(raw, newline="")))
    if file_format == "xml":
        order = ET.fromstring(raw)
        return [dict(order.attrib, **line.attrib) for line in order.findall("line")]
    raise ValueError("Unsupported order format")


if __name__ == "__main__":
    request = json.load(sys.stdin)
    rows = parse_order(request["input"], request["format"])
    print(json.dumps({"failures": sorted(failures(rows, request["report"]))}))
