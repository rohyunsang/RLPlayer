"use client";

import { useSite } from "./providers";
import { Check, Minus, Cross } from "./icons";
import type { Row, Verdict } from "@/content/site";

function Mark({ v }: { v: Verdict }) {
  if (v === "good")
    return (
      <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-good-soft text-good">
        <Check className="h-[11px] w-[11px]" />
      </span>
    );
  if (v === "bad")
    return (
      <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full bg-bad-soft text-bad">
        <Cross className="h-[11px] w-[11px]" />
      </span>
    );
  return (
    <span className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border border-line text-faint">
      <Minus className="h-[11px] w-[11px]" />
    </span>
  );
}

function Cell({ pair }: { pair: [Verdict, string] }) {
  const [v, text] = pair;
  return (
    <span className="flex items-start gap-2">
      <Mark v={v} />
      <span
        className={`text-[13px] leading-snug ${
          v === "good" ? "text-ink" : "text-muted"
        }`}
      >
        {text}
      </span>
    </span>
  );
}

export default function Comparison() {
  const { t } = useSite();
  const c = t.compare;
  const rows = c.rows as Row[];

  return (
    <section
      id="compare"
      className="scroll-mt-20 border-t border-line py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="reveal max-w-2xl">
          <p className="kicker">{c.kicker}</p>
          <h2 className="h-section mt-4">{c.title}</h2>
          <p className="lede mt-4">{c.lede}</p>
        </div>

        {/* --- desktop table --- */}
        <div className="reveal mt-12 hidden overflow-x-auto md:block">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr>
                <th className="w-[24%] pb-4 pr-4 align-bottom text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
                  &nbsp;
                </th>
                {c.cols.map((col, i) => (
                  <th
                    key={col}
                    className={`pb-4 pr-4 align-bottom text-[13.5px] font-semibold tracking-[-0.01em] ${
                      i === 0 ? "text-accent" : "text-muted"
                    }`}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-line align-top">
                  <th
                    scope="row"
                    className="py-4 pr-4 text-[13px] font-medium text-ink"
                  >
                    {r.label}
                  </th>
                  <td className="bg-accent-soft/50 py-4 pl-2 pr-4">
                    <Cell pair={r.rl} />
                  </td>
                  <td className="py-4 pr-4">
                    <Cell pair={r.pot} />
                  </td>
                  <td className="py-4 pr-4">
                    <Cell pair={r.vlc} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* --- mobile stacked --- */}
        <div className="reveal mt-10 space-y-3 md:hidden">
          {rows.map((r) => (
            <div key={r.label} className="panel p-4">
              <p className="text-[13px] font-semibold text-ink">{r.label}</p>
              <dl className="mt-3 space-y-2.5">
                {(
                  [
                    [c.cols[0], r.rl, true],
                    [c.cols[1], r.pot, false],
                    [c.cols[2], r.vlc, false],
                  ] as [string, [Verdict, string], boolean][]
                ).map(([name, pair, primary]) => (
                  <div key={name} className="flex items-start gap-3">
                    <dt
                      className={`w-[74px] shrink-0 text-[11.5px] font-medium ${
                        primary ? "text-accent" : "text-faint"
                      }`}
                    >
                      {name}
                    </dt>
                    <dd className="min-w-0 flex-1">
                      <Cell pair={pair} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>

        {/* --- verdicts --- */}
        <div className="mt-12">
          <p className="reveal text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
            {c.verdictTitle}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {c.verdicts.map((v) => (
              <div
                key={v.who}
                className={`reveal rounded-[14px] border p-5 ${
                  v.primary
                    ? "border-accent/45 bg-accent-soft"
                    : "border-line bg-surface"
                }`}
              >
                <p
                  className={`text-[14px] font-semibold tracking-[-0.012em] ${
                    v.primary ? "text-accent" : "text-ink"
                  }`}
                >
                  {v.who}
                </p>
                <p className="mt-2 text-[13px] leading-relaxed text-muted">
                  {v.what}
                </p>
              </div>
            ))}
          </div>
        </div>

        <p className="reveal mt-8 max-w-3xl text-[12px] leading-relaxed text-faint">
          {c.disclaimer}
        </p>
      </div>
    </section>
  );
}
