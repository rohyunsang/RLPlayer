"use client";

import { useSite } from "./providers";

const NOISE =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.42'/%3E%3C/svg%3E\")";

const DURATIONS = ["29:31", "18:07", "04:52", "1:12:40"];

function WinButton({
  kind,
  label,
}: {
  kind: "min" | "max" | "close";
  label: string;
}) {
  return (
    <span
      aria-label={label}
      className={`grid h-7 w-9 place-items-center rounded-[5px] text-[#9aa1ae] transition-colors ${
        kind === "close" ? "hover:bg-[#c4372f] hover:text-white" : "hover:bg-white/8"
      }`}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        {kind === "min" && (
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1.1" />
        )}
        {kind === "max" && (
          <rect
            x="1.1"
            y="1.1"
            width="7.8"
            height="7.8"
            rx="1"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.1"
          />
        )}
        {kind === "close" && (
          <path
            d="M1.4 1.4 8.6 8.6M8.6 1.4 1.4 8.6"
            stroke="currentColor"
            strokeWidth="1.1"
          />
        )}
      </svg>
    </span>
  );
}

function CtrlIcon({
  d,
  size = 17,
  fill = false,
}: {
  d: string;
  size?: number;
  fill?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={fill ? 0 : 1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

export default function PlayerMockup() {
  const { t } = useSite();
  const m = t.mockup;
  const progress = 40.8;

  return (
    <figure className="mock relative mx-auto w-full max-w-[1040px]">
      {/* ambient glow behind the window */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-6 -bottom-6 top-10 rounded-[36px] opacity-70 blur-3xl"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 50%, rgba(255,180,84,0.22), rgba(90,120,255,0.14) 55%, transparent 78%)",
        }}
      />

      <div
        className="relative overflow-hidden rounded-[13px] border border-white/10 bg-[var(--m-bg)]"
        style={{ boxShadow: "0 50px 90px -38px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.03)" }}
      >
        {/* ---------- title bar ---------- */}
        <div className="flex items-center gap-3 border-b border-[var(--m-line)] bg-[var(--m-chrome)] px-3 py-2">
          <svg width="15" height="15" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
            <rect x="1" y="1" width="30" height="30" rx="8" fill="#1c202b" />
            <path d="M13 10.4 22 16l-9 5.6Z" fill="#ffb454" />
            <rect x="8.4" y="10.2" width="2.3" height="11.6" rx="1.15" fill="#ffb454" />
          </svg>

          <div className="min-w-0 flex-1">
            <p className="break-normal-latin truncate text-[11.5px] font-medium text-[var(--m-text)]">
              {m.title}
            </p>
          </div>

          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            {m.badges.map((b) => (
              <span
                key={b}
                className="break-normal-latin rounded-[4px] border border-white/10 bg-white/[0.045] px-1.5 py-[3px] text-[9.5px] font-medium tracking-wide text-[var(--m-muted)]"
              >
                {b}
              </span>
            ))}
          </div>

          <div className="ml-1 flex shrink-0 items-center">
            <WinButton kind="min" label="Minimize" />
            <WinButton kind="max" label="Maximize" />
            <WinButton kind="close" label="Close" />
          </div>
        </div>

        {/* ---------- body ---------- */}
        <div className="flex">
          {/* video stage */}
          <div className="relative aspect-[16/10] min-w-0 flex-1 overflow-hidden bg-black sm:aspect-[16/9]">
            {/* the "frame": a dusk seascape built from gradients */}
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(to bottom, #070d1e 0%, #101c3c 26%, #2b2b4d 46%, #6d4550 55%, #8a5348 58.5%, #241d33 63%, #0e1327 82%, #080b16 100%)",
              }}
            />
            {/* moon + its halo */}
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(26% 34% at 71% 32%, rgba(255,222,178,0.42) 0%, rgba(255,192,132,0.10) 46%, transparent 72%)",
              }}
            />
            <div
              aria-hidden="true"
              className="absolute left-[70.2%] top-[28%] h-[6.5%] w-[3.7%] rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 40% 38%, #fff6e4 0%, #ffd9a6 60%, #f0b877 100%)",
                boxShadow: "0 0 26px 8px rgba(255,214,160,0.45)",
              }}
            />
            {/* moonlight glitter path on the water — soft on every edge */}
            <div
              aria-hidden="true"
              className="absolute bottom-0 left-[58%] top-[57.5%] w-[26%] opacity-80 blur-[7px]"
              style={{
                background:
                  "radial-gradient(closest-side ellipse at 50% 0%, rgba(255,214,162,0.55) 0%, rgba(255,196,138,0.2) 38%, transparent 76%)",
              }}
            />
            {/* horizon light band */}
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-[57.5%] h-[1.5px] opacity-60"
              style={{
                background:
                  "linear-gradient(to right, transparent, rgba(255,206,158,0.85) 45%, rgba(255,206,158,0.5) 72%, transparent)",
              }}
            />
            {/* headland silhouette */}
            <svg
              aria-hidden="true"
              className="absolute inset-x-0 top-[41.2%] h-[16.6%] w-full"
              viewBox="0 0 400 60"
              preserveAspectRatio="none"
            >
              {/* far shore: rises on the left, then recedes into the horizon */}
              <path
                d="M0 60V40l22-8 20 5 26-14 30 11 24-4 26 9 22 4 28 5 30 4 34 3 38 2 46 3H400V60Z"
                fill="#0b1020"
                opacity="0.95"
              />
            </svg>
            {/* grain */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-[0.16] mix-blend-overlay"
              style={{ backgroundImage: NOISE }}
            />

            {/* resume toast */}
            <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-white/10 bg-black/55 px-2.5 py-1.5 text-[10.5px] text-white/90 backdrop-blur-md sm:left-4 sm:top-4 sm:text-[11.5px]">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#ffb454" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3.4 12a8.6 8.6 0 1 0 2.6-6.1" />
                <path d="M3.2 4.6v4h4" />
              </svg>
              {m.toast}
            </div>

            {/* subtitle line */}
            <p
              className="absolute inset-x-6 bottom-[27%] text-center text-[11px] font-medium leading-snug text-white sm:bottom-[25%] sm:text-[15px]"
              style={{ textShadow: "0 1px 3px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.6)" }}
            >
              {m.subtitle}
            </p>

            {/* ---------- control overlay ---------- */}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/88 via-black/55 to-transparent px-3 pb-2.5 pt-10 sm:px-4 sm:pb-3">
              {/* seek bar */}
              <div className="group relative mb-2 h-[3px] w-full rounded-full bg-white/18">
                <div className="absolute inset-y-0 left-0 rounded-full bg-white/28" style={{ width: "78%" }} />
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-[var(--m-accent)]"
                  style={{ width: `${progress}%` }}
                />
                {/* chapter ticks */}
                {[18, 33, 57, 74].map((p) => (
                  <span
                    key={p}
                    className="absolute top-1/2 h-[7px] w-[1.5px] -translate-y-1/2 rounded-full bg-black/45"
                    style={{ left: `${p}%` }}
                  />
                ))}
                <span
                  className="absolute top-1/2 h-[11px] w-[11px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
                  style={{ left: `${progress}%` }}
                />
              </div>

              <div className="flex items-center gap-2.5 text-[var(--m-text)] sm:gap-3.5">
                <CtrlIcon d="M18.6 5.4v13.2L9.2 12ZM6.4 5.4v13.2" size={15} fill />
                <span className="grid h-8 w-8 place-items-center rounded-full bg-white text-black sm:h-9 sm:w-9">
                  <CtrlIcon d="M7.6 5.2v13.6l11-6.8Z" size={15} fill />
                </span>
                <CtrlIcon d="M5.4 5.4v13.2L14.8 12ZM17.6 5.4v13.2" size={15} fill />

                <span className="break-normal-latin ml-0.5 font-mono text-[10.5px] tabular-nums text-[var(--m-muted)] sm:text-[11.5px]">
                  <span className="text-[var(--m-text)]">12:04</span> / 29:31
                </span>

                {/* volume */}
                <div className="ml-auto hidden items-center gap-2 sm:flex">
                  <CtrlIcon d="M11 5.4 6.6 9H3.4v6h3.2L11 18.6ZM14.8 9.6a3.4 3.4 0 0 1 0 4.8M17.6 7a7 7 0 0 1 0 10" size={15} />
                  <span className="relative h-[3px] w-16 rounded-full bg-white/18">
                    <span className="absolute inset-y-0 left-0 w-[62%] rounded-full bg-white/80" />
                    <span className="absolute left-[62%] top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
                  </span>
                </div>

                <div className="ml-auto flex items-center gap-2.5 sm:ml-3 sm:gap-3">
                  <span className="break-normal-latin rounded border border-white/15 px-1.5 py-[1px] font-mono text-[9.5px] text-[var(--m-muted)]">
                    1.00x
                  </span>
                  <span className="break-normal-latin rounded border border-[var(--m-accent)]/60 px-1.5 py-[1px] font-mono text-[9.5px] font-semibold text-[var(--m-accent)]">
                    CC
                  </span>
                  <CtrlIcon d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z M19.4 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.8 1.8 0 1 1-2.6 2.6l-.1-.1a1.5 1.5 0 0 0-2.5 1.1v.2a1.8 1.8 0 1 1-3.6 0v-.1a1.5 1.5 0 0 0-2.6-1 1.8 1.8 0 1 1-2.6-2.6l.1-.1a1.5 1.5 0 0 0-1.1-2.5h-.2a1.8 1.8 0 1 1 0-3.6h.1a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.8 1.8 0 1 1 2.6-2.6l.1.1a1.5 1.5 0 0 0 1.7.3h.1a1.5 1.5 0 0 0 .9-1.4v-.2a1.8 1.8 0 1 1 3.6 0v.1a1.5 1.5 0 0 0 2.5 1.1l.1-.1a1.8 1.8 0 1 1 2.6 2.6l-.1.1a1.5 1.5 0 0 0 1.1 2.5h.2a1.8 1.8 0 1 1 0 3.6h-.1a1.5 1.5 0 0 0-1.4.9Z" size={15} />
                  <CtrlIcon d="M8.4 3.6H3.6v4.8M15.6 3.6h4.8v4.8M20.4 15.6v4.8h-4.8M3.6 15.6v4.8h4.8" size={15} />
                </div>
              </div>
            </div>
          </div>

          {/* playlist panel */}
          <aside className="hidden w-[212px] shrink-0 flex-col border-l border-[var(--m-line)] bg-[var(--m-panel)] md:flex lg:w-[236px]">
            <div className="flex items-center justify-between border-b border-[var(--m-line)] px-3 py-2.5">
              <span className="text-[11px] font-semibold tracking-wide text-[var(--m-text)]">
                {m.playlist}
              </span>
              <span className="break-normal-latin font-mono text-[10px] text-[var(--m-muted)]">
                4
              </span>
            </div>

            <ul className="flex-1 p-1.5">
              {m.items.map((item, i) => {
                const active = i === 0;
                return (
                  <li
                    key={item}
                    className={`relative flex items-start gap-2 rounded-[7px] px-2 py-2 ${
                      active ? "bg-white/[0.07]" : ""
                    }`}
                  >
                    {active && (
                      <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-[var(--m-accent)]" />
                    )}
                    <span className="mt-[3px] w-3 shrink-0 text-center">
                      {active ? (
                        <span className="mock-eq flex h-3 items-end justify-center gap-[1.5px]">
                          <span style={{ animationDelay: "0ms" }} />
                          <span style={{ animationDelay: "180ms" }} />
                          <span style={{ animationDelay: "360ms" }} />
                        </span>
                      ) : (
                        <span className="break-normal-latin font-mono text-[9.5px] text-[var(--m-muted)]">
                          {i + 1}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={`break-normal-latin block truncate text-[10.5px] leading-tight ${
                          active
                            ? "font-medium text-[var(--m-text)]"
                            : "text-[var(--m-muted)]"
                        }`}
                      >
                        {item}
                      </span>
                      <span className="break-normal-latin mt-1 block font-mono text-[9px] text-[var(--m-muted)]/70">
                        {DURATIONS[i]}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="flex items-center gap-1.5 border-t border-[var(--m-line)] px-3 py-2">
              <span className="mock-live h-1.5 w-1.5 rounded-full bg-[var(--m-accent)]" />
              <span className="break-normal-latin font-mono text-[9px] text-[var(--m-muted)]">
                hevc · 3840×2160 · 23.976
              </span>
            </div>
          </aside>
        </div>
      </div>

      <figcaption className="mx-auto mt-4 max-w-xl text-center text-[12.5px] leading-relaxed text-[var(--faint)]">
        {m.caption}
      </figcaption>
    </figure>
  );
}
