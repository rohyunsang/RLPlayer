"use client";

import Nav from "@/components/Nav";
import Footer from "@/components/Footer";
import Comparison from "@/components/Comparison";
import { useReveal } from "@/components/providers";
import {
  Hero,
  Stats,
  Manifesto,
  Features,
  Shortcuts,
  Faq,
  Cta,
} from "@/components/sections";

export default function Home() {
  useReveal();

  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Stats />
        <Manifesto />
        <Comparison />
        <Features />
        <Shortcuts />
        <Faq />
        <Cta />
      </main>
      <Footer />
    </>
  );
}
