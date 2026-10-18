# GRILL — dashboard-token-fragment

chain: GREEN (verified by pharn/floor/check-plan-spec-agree.mjs) · lessons: GREEN (verified by pharn/floor/check-plan-lessons.mjs)

mode: floor-only (/pharn-grill --floor-only)

interrogation NOT performed — skipped by mode (floor-only). The plan was not interrogated, no model-driven
griller ran, and no model finding was sought, so none is reported — this is not a "no findings" result, it is
"no interrogation happened at all".

## Deterministic plan scans (`--floor-only`, `pharn/floor/grill-scan.mjs`)

Advisory: each finding below gates nothing. The scanners detect a pattern's presence on a line; the grillers'
judgment and the plan interrogation did not run.

```yaml
- type: FINDING
  rule_id: "P7"
  severity: important
  file: "pharn/features/dashboard-token-fragment/PLAN.md:89"
  problem: "a hardcoded user-facing string appears in the plan (scan-plan-i18n, i18n griller's deterministic half)"
  evidence: "scan-plan-i18n matched kind jsx-text-literal on line 89"
- type: FINDING
  rule_id: "P7"
  severity: important
  file: "pharn/features/dashboard-token-fragment/PLAN.md:91"
  problem: "a hardcoded user-facing string appears in the plan (scan-plan-i18n, i18n griller's deterministic half)"
  evidence: "scan-plan-i18n matched kind jsx-text-literal on line 91"
```

- `scan-plan-migrations`: mentions false. Not a finding: whether the plan needs or adequately declares this is the migrations griller's judgment, which did not run.
- `scan-plan-observability`: mentions true — lines 2 (dashboard), 9 (dashboard), 10 (dashboard), 13 (dashboard), 17 (dashboard), 20 (dashboard), 21 (dashboard), 22 (dashboard), 26 (dashboard), 57 (dashboard), 62 (dashboard), 64 (dashboard), 86 (logging), 87 (dashboard), 92 (dashboard), 107 (dashboard), 112 (dashboard), 117 (dashboard), 126 (dashboard), 127 (dashboard), 129 (dashboard), 130 (dashboard), 134 (dashboard), 149 (dashboard), 150 (dashboard), 151 (dashboard), 152 (dashboard), 153 (dashboard), 154 (dashboard), 155 (dashboard), 156 (dashboard), 159 (dashboard), 173 (dashboard), 174 (dashboard), 175 (dashboard), 201 (dashboard), 202 (dashboard). Not a finding: whether the plan needs or adequately declares this is the observability griller's judgment, which did not run.

The two floor results above are this run's only grill claims; `/pharn-grill dashboard-token-fragment` without
`--quick` or `--floor-only` interrogates the plan.
