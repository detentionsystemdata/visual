# Detention System — Data Views

Interactive views of the U.S. immigration detention system, built from public data
releases: county and state maps, field-office coverage, immigration-court locations,
and derived measures of scale and concentration. Facts only — every panel cites its
source and date.

Two self-contained pages (`index.html`, `directory.html`): no external requests, no
analytics. Each page's data is a single embedded JSON constant, regenerated from a
detention-system release with `node scripts/build-data.mjs <releaseDir> --apply`; the
page markup, styling, and logic are otherwise untouched by that step.

## Sources

- Detention statistics, facility roster, field offices — ICE (public domain) and
  UWCHR ICE-detain (FOIA-derived, attributed).
- Immigration courts — EOIR (public domain).
- County boundaries and population — U.S. Census (public domain), simplified.

Derived measures (co-location hints, source-agreement signal, facility tiers) are
labeled as derivations, not asserted as source facts.

## License

Site code: MIT (see `LICENSE`). Underlying data belongs to its cited sources.
