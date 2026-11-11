# tnb-tou-check

Check whether a Peninsular Malaysia business electricity account would have paid less on the
**ToU (time-of-use)** tariff than on the **General** tariff, using the account's own 15- or
30-minute interval meter data and the RP4 base tariff (in force from 1 July 2025).

> **Not a TNB tool.** This is an independent estimate for comparing two tariff options. It is not
> a bill, it is not affiliated with Tenaga Nasional Berhad or the Energy Commission (Suruhanjaya
> Tenaga), and it does not replace advice from TNB. Check the current published tariff before acting.

## What it does

For each calendar month (Malaysian time, UTC+08:00) it computes:

- total and peak-period kWh (peak = Monday to Friday, 14:00 to 22:00, except listed public holidays);
- maximum demand (MD) = the highest 30-minute energy × 2, both at any time and within the peak period
  (15-minute data is first summed into 30-minute blocks);
- the base bill under General and under ToU: energy, capacity, network and retail charges, with each
  subtotal rounded to the sen;
- the difference, and a verdict over all complete months: `switch`, `stay`, `borderline` (within 1%
  of the General bill) or `insufficient-data`.

It also prints the break-even indicators that follow from the tariff: the peak kWh share where ToU
energy costs the same as General energy (63.6% for LV and MV, from 2.60 / 4.09 sen), and for MV/HV
the peak-MD / anytime-MD ratio below which ToU demand charges are lower (MV 92.0%, HV 69.6%).

All money arithmetic is exact integer arithmetic (no floating point).

### Not included

The estimate covers the **base tariff only**. It leaves out the Automatic Fuel Adjustment (AFA),
the KWTBB renewable-energy levy, SST, power-factor surcharges, Energy Efficiency incentives, minimum
monthly charges, and any special or contract tariffs. These can change the real bill. Interval data
from your meter may also differ from what TNB bills.

## Install and run

Requires Node.js 20 or later. No runtime dependencies.

```bash
npm ci
npm run build
node dist/cli.js analyze my-meter.csv --class mv
```

Options:

| Option | Meaning |
| --- | --- |
| `--class lv\|mv\|hv` | Voltage class (required). LV is energy-based; MV and HV have MD charges. |
| `--holidays FILE` | JSON list of `{ "date": "YYYY-MM-DD", "name": "..." }` treated as off-peak days. See `examples/holidays-2025-sample.json` (sample entries only: use the official list for your state). |
| `--timestamp start\|end` | Whether each timestamp marks the start (default) or end of its interval. |
| `--value kwh\|kw` | Energy per interval (default) or average kW over the interval. |
| `--ts-col NAME`, `--value-col NAME` | Column names (default `timestamp` and `kwh` / `kw`, case-insensitive). |
| `--tariff FILE` | Use a different tariff JSON (same schema as `data/tariffs/`). |
| `--json` | Machine-readable output (RM amounts as strings). |
| `--out FILE` | Write the report to a file. |

Exit codes: `0` success, `2` bad input (with a message and usage on stderr).

### Input CSV

```csv
timestamp,kwh
2025-09-01 00:00,44.733
2025-09-01 00:30,44.734
```

- Timestamps without an offset are Malaysian time; `Z` and offsets such as `+08:00` are accepted.
- 15- or 30-minute intervals; other lengths, duplicate timestamps and off-grid timestamps are rejected.
- Gaps are allowed. A month with under 95% of its intervals is reported but left out of the verdict.

## Example

`fixtures/` holds synthetic September 2025 months that reproduce published worked examples. For
`fixtures/mv-factory-b.csv` (150,000 kWh, 35% peak, MD 500 kW at night, peak MD 400 kW):

```text
$ node dist/cli.js analyze fixtures/mv-factory-b.csv --class mv
...
Month           kWh  Peak %    MD kW  Peak MD kW  General RM    ToU RM  ToU-Gen RM    Status
2025-09  150000.000   35.0%  500.000     400.000    89580.00  82016.25    -7563.75  complete
...
Verdict: switch. ToU would have been cheaper: consider switching.
```

## Tariff data

`data/tariffs/rp4-peninsular-2025-07.json` holds the RP4 rates for LV, MV and HV General and ToU,
valid 1 July 2025 to 31 December 2027. Every rate cites the Energy Commission's published schedule.
If the tariff changes, add a new file rather than editing the old one, and pass it with `--tariff`.

## Development

```bash
npm run check   # lint, typecheck, tests
npm run build
npm run smoke   # runs the built CLI on the fixtures
node scripts/gen-fixtures.mjs   # regenerate fixtures (CI checks they are unchanged)
```

## License

MIT
