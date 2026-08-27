"use client";

import { SITE } from "@/content/site";
import { useSite } from "./providers";
import { ICONS, Github, Windows, Plus, type IconName } from "./icons";
import PlayerMockup from "./PlayerMockup";

/* ------------------------------------------------------------------ Hero */

export function Hero() {
  const { t } = useSite();

  return (
    <section id="top" className="aura grid-veil relative overflow-hidden">
      <div className="relative z-10 mx-auto max-w-6xl px-4 pb-14 pt-14 sm:px-6 sm:pb-20 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface/60 px-3.5 py-1.5 text-[12px] font-medium text-muted backdrop-blur">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {t.hero.badge}
          </p>

          <h1 className="h-display mt-6">
            <span className="block">{t.hero.titleA}</span>
            <span
              className="block bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  "linear-gradient(160deg, var(--text) 18%, color-mix(in srgb, var(--accent) 72%, var(--text)) 96%)",
              }}
            >
              {t.hero.titleB}
            </span>
          </h1>

          <p className="lede mx-auto mt-6 max-w-2xl">{t.hero.lede}</p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={SITE.download}
              className="group flex w-full items-center justify-center gap-3 rounded-xl bg-solid px-6 py-3.5 text-solid-ink shadow-lg transition-transform hover:-translate-y-0.5 sm:w-auto"
            >
              <Windows className="h-[18px] w-[18px] shrink-0 opacity-90" />
              <span className="text-left">
                <span className="block text-[15px] font-semibold leading-tight">
                  {t.hero.primary}
                </span>
                <span className="block text-[11.5px] leading-tight opacity-65">
                  {t.hero.primarySub}
                </span>
              </span>
            </a>

            <a
              href={SITE.repo}
              target="_blank"
              rel="noreferrer noopener"
              className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-line-strong px-6 py-3.5 text-[14.5px] font-medium text-ink transition-colors hover:bg-surface sm:w-auto"
            >
              <Github className="h-[17px] w-[17px]" />
              {t.hero.secondary}
            </a>
          </div>

          <p className="mt-5 text-[12.5px] text-faint">{t.hero.meta}</p>
        </div>

        <div className="reveal mt-14 sm:mt-20">
          <PlayerMockup />
        </div>
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- Stats */

export function Stats() {
  const { t } = useSite();

  return (
    <section className="border-y border-line bg-bg2">
      <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px overflow-hidden px-4 sm:px-6 lg:grid-cols-4">
        {t.stats.map((s, i) => (
          <div
            key={s.label}
            className={`px-2 py-8 text-center sm:py-10 ${
              i % 2 === 1 ? "border-l border-line" : ""
            } ${i >= 2 ? "border-t border-line lg:border-t-0" : ""} ${
              i === 2 ? "lg:border-l" : ""
            } ${i === 3 ? "lg:border-l" : ""}`}
          >
            <p className="break-normal-latin text-[2rem] font-semibold leading-none tracking-tight text-accent sm:text-[2.6rem]">
              {s.value}
            </p>
            <p className="mt-2.5 text-[12.5px] leading-snug text-muted">
              {s.label}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- Manifesto */

export function Manifesto() {
  const { t } = useSite();
  const m = t.manifesto;

  return (
    <section id="why" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:px-6 lg:grid-cols-12 lg:gap-14">
        <div className="reveal lg:col-span-5">
          <p className="kicker">{m.kicker}</p>
          <h2 className="h-section mt-4">
            <span className="block text-muted">{m.titleA}</span>
            <span className="block">{m.titleB}</span>
          </h2>
        </div>

        <div className="reveal lg:col-span-7">
          <div className="space-y-5">
            {m.body.map((p) => (
              <p key={p.slice(0, 18)} className="text-[15px] leading-[1.85] text-muted">
                {p}
              </p>
            ))}
          </div>

          <blockquote className="mt-8 border-l-2 border-accent pl-5 text-[16.5px] font-medium leading-relaxed tracking-[-0.012em] text-ink">
            {m.quote}
          </blockquote>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- Features */

export function Features() {
  const { t } = useSite();

  return (
    <section id="features" className="scroll-mt-20 border-t border-line bg-bg2 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="reveal max-w-2xl">
          <p className="kicker">{t.features.kicker}</p>
          <h2 className="h-section mt-4">{t.features.title}</h2>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {t.features.items.map((f, i) => {
            const Icon = ICONS[f.icon as IconName];
            return (
              <article
                key={f.title}
                className="reveal panel group p-6 transition-colors hover:border-line-strong"
                style={{ transitionDelay: `${(i % 3) * 60}ms` }}
              >
                <span className="grid h-10 w-10 place-items-center rounded-[11px] border border-line bg-accent-soft text-accent">
                  <Icon className="h-[19px] w-[19px]" />
                </span>
                <h3 className="h-card mt-5">{f.title}</h3>
                <p className="mt-2.5 text-[13.5px] leading-[1.75] text-muted">
                  {f.body}
                </p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- Shortcuts */

export function Shortcuts() {
  const { t } = useSite();

  return (
    <section id="shortcuts" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="reveal max-w-2xl">
          <p className="kicker">{t.keys.kicker}</p>
          <h2 className="h-section mt-4">{t.keys.title}</h2>
          <p className="lede mt-4">{t.keys.lede}</p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {t.keys.groups.map((g) => (
            <div key={g.name} className="reveal panel overflow-hidden">
              <p className="border-b border-line px-5 py-3 text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
                {g.name}
              </p>
              <ul className="divide-y divide-[var(--border)]">
                {g.items.map((it) => (
                  <li
                    key={it.d}
                    className="flex items-center justify-between gap-3 px-5 py-3"
                  >
                    <span className="text-[13px] leading-snug text-muted">
                      {it.d}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {it.k.map((key) => (
                        <kbd
                          key={key}
                          className="break-normal-latin inline-grid h-[22px] min-w-[22px] place-items-center rounded-[6px] border border-line-strong bg-surface2 px-1.5 font-mono text-[11px] font-medium text-ink"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- FAQ */

export function Faq() {
  const { t } = useSite();

  return (
    <section
      id="faq"
      className="scroll-mt-20 border-t border-line bg-bg2 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-3xl px-4 sm:px-6">
        <div className="reveal">
          <p className="kicker">{t.faq.kicker}</p>
          <h2 className="h-section mt-4">{t.faq.title}</h2>
        </div>

        <div className="reveal mt-10 border-t border-line">
          {t.faq.items.map((item) => (
            <details key={item.q} className="group border-b border-line">
              <summary className="flex items-start justify-between gap-5 py-5 text-left">
                <h3 className="text-[15px] font-medium leading-snug tracking-[-0.012em] text-ink">
                  {item.q}
                </h3>
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border border-line text-muted">
                  <Plus className="faq-chevron h-3.5 w-3.5" />
                </span>
              </summary>
              <p className="pb-6 pr-10 text-[14px] leading-[1.85] text-muted">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------- CTA */

export function Cta() {
  const { t } = useSite();

  return (
    <section className="aura relative overflow-hidden border-t border-line">
      <div className="relative z-10 mx-auto max-w-3xl px-4 py-24 text-center sm:px-6 sm:py-32">
        <h2 className="reveal h-section">{t.cta.title}</h2>
        <p className="reveal lede mx-auto mt-5 max-w-xl">{t.cta.body}</p>

        <div className="reveal mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a
            href={SITE.download}
            className="flex w-full items-center justify-center gap-2.5 rounded-xl bg-solid px-7 py-3.5 text-[15px] font-semibold text-solid-ink transition-transform hover:-translate-y-0.5 sm:w-auto"
          >
            <Windows className="h-[18px] w-[18px] opacity-90" />
            {t.cta.primary}
          </a>
          <a
            href={SITE.repo}
            target="_blank"
            rel="noreferrer noopener"
            className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-line-strong px-7 py-3.5 text-[14.5px] font-medium text-ink transition-colors hover:bg-surface sm:w-auto"
          >
            <Github className="h-[17px] w-[17px]" />
            {t.cta.secondary}
          </a>
        </div>

        <p className="reveal mt-5 text-[12.5px] text-faint">{t.cta.note}</p>
      </div>
    </section>
  );
}
