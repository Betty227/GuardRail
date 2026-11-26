# GuardRail v1 receipt bytes

inputHash is SHA-256 of the original input bytes, including BOM, line endings and trailing newline if present. CSV and XML projections of one order have distinct input hashes.

outputHash uses SHA-256 of ASCII bytes produced by Python json.dumps(report, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False). Arrays keep their original order. Report property names are fixed ASCII schema keys. Producers must emit unique keys, Unicode scalar strings and integer number tokens in the JavaScript safe range. Fractions, exponent notation and negative zero are outside this profile. Preserve the original JSON separately.

The local evidence verifier checks commitments and the bundled signer. The trusted verifier address must be obtained separately from the deployed vault. Chain inclusion requires an independent node or explorer check.
