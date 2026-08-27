import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function Logo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="1.1"
        y="1.1"
        width="29.8"
        height="29.8"
        rx="8.4"
        fill="var(--surface-2)"
        stroke="var(--border-strong)"
        strokeWidth="1.2"
      />
      <path
        d="M13 10.4 L22 16 L13 21.6 Z"
        fill="var(--accent)"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <rect x="8.4" y="10.2" width="2.3" height="11.6" rx="1.15" fill="var(--accent)" />
    </svg>
  );
}

export const BellOff = (p: P) => (
  <svg {...base} {...p}>
    <path d="M8.7 5.4A5.4 5.4 0 0 1 17.4 10c0 3.2.6 4.9 1.4 5.9H7.5" />
    <path d="M6.6 8.9c-.1.4-.1.8-.1 1.1 0 3.2-.6 4.9-1.4 5.9" />
    <path d="M10 19.2a2.2 2.2 0 0 0 4 0" />
    <path d="M3.6 3.4 20.4 20.6" />
  </svg>
);

export const ShieldCheck = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 2.9 4.8 5.8v5.6c0 4.4 3 8.1 7.2 9.7 4.2-1.6 7.2-5.3 7.2-9.7V5.8Z" />
    <path d="m9.1 12 2.1 2.1 3.9-4" />
  </svg>
);

export const Film = (p: P) => (
  <svg {...base} {...p}>
    <rect x="2.9" y="4.4" width="18.2" height="15.2" rx="2.4" />
    <path d="M7.5 4.4v15.2M16.5 4.4v15.2M2.9 12h18.2M2.9 8.2h4.6M2.9 15.8h4.6M16.5 8.2h4.6M16.5 15.8h4.6" />
  </svg>
);

export const Resume = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3.4 12a8.6 8.6 0 1 0 2.6-6.1" />
    <path d="M3.2 4.6v4h4" />
    <path d="M11.1 8.6v6.8l5.3-3.4Z" />
  </svg>
);

export const Code = (p: P) => (
  <svg {...base} {...p}>
    <path d="m8.4 8.2-4.6 3.8 4.6 3.8" />
    <path d="m15.6 8.2 4.6 3.8-4.6 3.8" />
    <path d="m13.4 4.6-2.8 14.8" />
  </svg>
);

export const Bolt = (p: P) => (
  <svg {...base} {...p}>
    <path d="M13.3 2.6 4.9 13.2h5.7l-.9 8.2 8.4-10.6h-5.7Z" />
  </svg>
);

export const Windows = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M3 5.7 10.2 4.7v6.9H3Zm0 12.6 7.2 1V11.9H3ZM11.1 4.6 21 3.2v8.4h-9.9Zm0 14.8L21 20.8v-8.5h-9.9Z" />
  </svg>
);

export const Github = (p: P) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M12 1.8a10.2 10.2 0 0 0-3.2 19.9c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.4 1.1 3 .8.1-.6.4-1.1.6-1.4-2.2-.2-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.6 5 .4.3.7 1 .7 2v2.9c0 .3.2.6.7.5A10.2 10.2 0 0 0 12 1.8Z" />
  </svg>
);

export const Check = (p: P) => (
  <svg {...base} strokeWidth={2.2} {...p}>
    <path d="m4.8 12.4 4.6 4.6 9.8-10.4" />
  </svg>
);

export const Minus = (p: P) => (
  <svg {...base} strokeWidth={2.2} {...p}>
    <path d="M6 12h12" />
  </svg>
);

export const Cross = (p: P) => (
  <svg {...base} strokeWidth={2.2} {...p}>
    <path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6" />
  </svg>
);

export const Plus = (p: P) => (
  <svg {...base} strokeWidth={1.8} {...p}>
    <path d="M12 5.6v12.8M5.6 12h12.8" />
  </svg>
);

export const Sun = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="4.1" />
    <path d="M12 2.6v2.1M12 19.3v2.1M4.3 4.3l1.5 1.5M18.2 18.2l1.5 1.5M2.6 12h2.1M19.3 12h2.1M4.3 19.7l1.5-1.5M18.2 5.8l1.5-1.5" />
  </svg>
);

export const Moon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.6 8.6 0 1 0 10.6 10.6Z" />
  </svg>
);

export const Download = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3.4v11.4" />
    <path d="m7.4 10.6 4.6 4.6 4.6-4.6" />
    <path d="M4.4 19.4h15.2" />
  </svg>
);

export const ICONS = {
  bell: BellOff,
  shield: ShieldCheck,
  film: Film,
  resume: Resume,
  code: Code,
  bolt: Bolt,
} as const;

export type IconName = keyof typeof ICONS;
