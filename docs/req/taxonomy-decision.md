# D1 taxonomy decision — proposed v0.3

Status: **proposed; M5/registrar decision required. Not final.** Date: 2026-11-25.
Owner: M5 coordination with M6. Related: [`requirements.yaml`](requirements.yaml),
[`../architecture/invariants.md`](../architecture/invariants.md),
[`../architecture/trace-matrix.md`](../architecture/trace-matrix.md).

## Decision requested

Replace the three-way `functional / non-functional / invariant` classification with the course D1
type categories and an NFR subtype:

- `functional`
- `invariant` — only the zero-tolerance authority/safety rules: INV-01, INV-02, INV-03, INV-12
- `security`
- `governance`
- `performance`
- `cost`
- `quality`

The former storage/evaluation invariants (INV-04…11, INV-13…17) are reclassified as quality,
governance or security NFRs under their stable legacy IDs. NFR-04, NFR-05 and INV-17 are split into
NFR-04 + COST-01, NFR-05 + SEC-01, and INV-17 + GOV-01.

## Basis

- Course D1 type catalogue: functional, invariant, security, governance, performance, cost, quality
  (and unclear when no verifiable criterion exists).
- Invariant litmus: a single violation is catastrophic, with no acceptable slack and deterministic
  enforcement. The four remaining invariants are authority/safety rules.
- Stable IDs: existing IDs are retained; the `INV-` prefix records the original allocation, not the
  current category. New type-prefixed IDs are used only for the split entries.
- The registry, invariant register, trace matrix and gates are internally consistent at v0.3.

## Reservation, not approval

`COST-01`, `SEC-01`, `GOV-01` and ADR-010 are reserved in
[#25 comment 7159011745](https://github.com/inscripoem/isla/issues/25#issuecomment-7159011745).
A reservation prevents a collision; it does not approve the taxonomy, the split or the ADR.

## Consequence if approved

- `docs/req/requirements.yaml` v0.3 becomes the accepted D1 taxonomy.
- The invariant register stays at four current rows; the former IDs remain a separate historical
  table only for old AI-use references.
- NFR-03 remains a pending quality metric; NFR-04/COST-01 and NFR-05/SEC-01/GOV-01 have separate
  owners and evidence.
- The readiness test enforces a subtype for every non-functional requirement; the JSON schema leaves
  `subtype` optional and the test is the conditional rule.

## Consequence if rejected

Revert to the previous classification and migrate the registry, invariant register, trace rows and
cases together; do not leave a mixed scheme. The rejection is a recorded decision, not a silent edit.

## What this record does not do

- It does not accept the taxonomy, the split, the ADR or the permission model.
- It does not allocate a new ID; the #25 reservation is the only allocation evidence.
- It does not change any runtime behaviour, test threshold or quality result.
