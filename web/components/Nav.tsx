"use client";

import { useEffect, useState } from "react";
import { SITE } from "@/content/site";
import { useSite } from "./providers";
import { Logo, Moon, Sun, Github } from "./icons";

export default function Nav() {
  const { t, lang, toggleLang, theme, toggleTheme } = useSite();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const links = [
    { href: "#why", label: t.nav.why },
    { href: "#compare", label: t.nav.compare },
    { href: "#features", label: t.nav.features },
    { href: "#shortcuts", label: t.nav.keys },
    { href: "#faq", label: t.nav.faq },
  ];

  return (
    <header
      className={`sticky top-0 z-50 transition-colors duration-300 ${
        stuck
          ? "border-b border-line bg-[color-mix(in_srgb,var(--bg)_82%,transparent)] backdrop-blur-xl"
          : "border-b border-transparent"
      }`}
    >
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:h-16 sm:px-6">
        <a href="#top" className="flex shrink-0 items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-[15px] font-semibold tracking-[-0.015em]">
            {SITE.name}
          </span>
        </a>

        <ul className="ml-4 hidden items-center gap-1 lg:flex">
          {links.map((l) => (
            <li key={l.href}>
              <a
                href={l.href}
                className="rounded-lg px-3 py-2 text-[13.5px] text-muted transition-colors hover:text-ink"
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={toggleLang}
            aria-label={t.nav.langLabel}
            className="break-normal-latin rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {lang === "ko" ? "EN" : "KO"}
          </button>

          <button
            type="button"
            onClick={toggleTheme}
            aria-label={t.nav.themeLabel}
            className="grid h-8 w-8 place-items-center rounded-lg border border-line text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            {theme === "light" ? (
              <Moon className="h-[15px] w-[15px]" />
            ) : (
              <Sun className="h-[15px] w-[15px]" />
            )}
          </button>

          <a
            href={SITE.repo}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="GitHub"
            className="hidden h-8 w-8 place-items-center rounded-lg border border-line text-muted transition-colors hover:border-line-strong hover:text-ink sm:grid"
          >
            <Github className="h-[15px] w-[15px]" />
          </a>

          <a
            href={SITE.download}
            className="ml-1 rounded-lg bg-solid px-3.5 py-2 text-[13px] font-semibold text-solid-ink transition-opacity hover:opacity-88 sm:px-4"
          >
            {t.nav.download}
          </a>
        </div>
      </nav>
    </header>
  );
}
