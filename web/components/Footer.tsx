"use client";

import { SITE } from "@/content/site";
import { useSite } from "./providers";
import { Logo, Github } from "./icons";

export default function Footer() {
  const { t } = useSite();
  const f = t.footer;

  const product = [
    { href: SITE.download, label: f.download, external: true },
    { href: "#features", label: f.features, external: false },
    { href: "#compare", label: f.compare, external: false },
    { href: "#faq", label: f.faq, external: false },
  ];

  const project = [
    { href: SITE.repo, label: f.source, external: true },
    { href: SITE.issues, label: f.issues, external: true },
    { href: SITE.license, label: f.license, external: true },
    { href: SITE.notice, label: f.notice, external: true },
  ];

  return (
    <footer className="border-t border-line bg-bg2">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <div className="flex items-center gap-2.5">
              <Logo className="h-7 w-7" />
              <span className="text-[15px] font-semibold tracking-[-0.015em]">
                {SITE.name}
              </span>
            </div>
            <p className="mt-4 max-w-xs text-[13.5px] leading-relaxed text-muted">
              {f.tagline}
            </p>
            <a
              href={SITE.repo}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-5 inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[12.5px] text-muted transition-colors hover:border-line-strong hover:text-ink"
            >
              <Github className="h-[14px] w-[14px]" />
              github.com/rohyunsang/RLPlayer
            </a>
          </div>

          <nav className="lg:col-span-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
              {f.productTitle}
            </p>
            <ul className="mt-4 space-y-2.5">
              {product.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    {...(l.external
                      ? { target: "_blank", rel: "noreferrer noopener" }
                      : {})}
                    className="text-[13.5px] text-muted transition-colors hover:text-ink"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <nav className="lg:col-span-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-faint">
              {f.projectTitle}
            </p>
            <ul className="mt-4 space-y-2.5">
              {project.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-[13.5px] text-muted transition-colors hover:text-ink"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-12 space-y-3 border-t border-line pt-8">
          <p className="text-[12px] leading-relaxed text-faint">
            © {new Date().getFullYear()} {SITE.name}. {f.licenseLine}
          </p>
          <p className="max-w-3xl text-[12px] leading-relaxed text-faint">
            {f.thirdParty}
          </p>
          <p className="max-w-3xl text-[12px] leading-relaxed text-faint">
            {f.disclaimer}
          </p>
        </div>
      </div>
    </footer>
  );
}
