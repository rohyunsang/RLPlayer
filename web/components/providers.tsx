"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { DICTS, type Dict, type Lang } from "@/content/site";

type Theme = "dark" | "light";

type Ctx = {
  lang: Lang;
  t: Dict;
  setLang: (l: Lang) => void;
  toggleLang: () => void;
  theme: Theme | null;
  toggleTheme: () => void;
};

const SiteCtx = createContext<Ctx | null>(null);

const LANG_KEY = "rlplayer.lang";
const THEME_KEY = "rlplayer.theme";

export function SiteProvider({ children }: { children: ReactNode }) {
  // Korean is the server-rendered default; a stored choice is applied on mount.
  const [lang, setLangState] = useState<Lang>("ko");
  const [theme, setThemeState] = useState<Theme | null>(null);

  useEffect(() => {
    try {
      const storedLang = window.localStorage.getItem(LANG_KEY);
      if (storedLang === "en" || storedLang === "ko") {
        setLangState(storedLang);
      } else if (!navigator.language.toLowerCase().startsWith("ko")) {
        setLangState("en");
      }
    } catch {
      /* storage unavailable — keep the default */
    }

    try {
      const storedTheme = window.localStorage.getItem(THEME_KEY);
      if (storedTheme === "dark" || storedTheme === "light") {
        setThemeState(storedTheme);
      } else {
        setThemeState(
          window.matchMedia("(prefers-color-scheme: light)").matches
            ? "light"
            : "dark",
        );
      }
    } catch {
      setThemeState("dark");
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleLang = useCallback(() => {
    setLangState((prev) => {
      const next: Lang = prev === "ko" ? "en" : "ko";
      try {
        window.localStorage.setItem(LANG_KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === "light" ? "dark" : "light";
      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch {
        /* ignore */
      }
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }, []);

  return (
    <SiteCtx.Provider
      value={{ lang, t: DICTS[lang], setLang, toggleLang, theme, toggleTheme }}
    >
      {children}
    </SiteCtx.Provider>
  );
}

export function useSite(): Ctx {
  const ctx = useContext(SiteCtx);
  if (!ctx) throw new Error("useSite must be used inside <SiteProvider>");
  return ctx;
}

/** Adds `is-in` to `.reveal` elements as they scroll into view. */
export function useReveal() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".reveal"));
    if (nodes.length === 0) return;

    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      nodes.forEach((n) => n.classList.add("is-in"));
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );

    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
}
