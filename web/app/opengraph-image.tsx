import { ImageResponse } from "next/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "RLPlayer — the video player that leaves you alone";
export const dynamic = "force-static";

/*
 * Rendered at build time by Satori. Satori only has a Latin font bundled,
 * so this card deliberately uses Latin copy: Korean glyphs would render as
 * empty boxes unless a Korean TTF were vendored into the repo.
 */
export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background:
            "linear-gradient(140deg, #08090c 0%, #0f121a 52%, #1a1409 100%)",
          padding: "68px 76px",
          fontFamily: "sans-serif",
          position: "relative",
        }}
      >
        {/* warm glow */}
        <div
          style={{
            position: "absolute",
            top: -180,
            right: -120,
            width: 620,
            height: 620,
            borderRadius: 620,
            background:
              "radial-gradient(circle, rgba(255,180,84,0.24) 0%, rgba(255,180,84,0) 68%)",
            display: "flex",
          }}
        />

        {/* brand row */}
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div
            style={{
              width: 62,
              height: 62,
              borderRadius: 16,
              background: "#141821",
              border: "1px solid #2c313d",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {/* Satori has no border-triangle support, so draw the mark as SVG. */}
            <svg width="34" height="34" viewBox="0 0 32 32">
              <path d="M13.2 9.8 22.6 16l-9.4 6.2Z" fill="#ffb454" />
              <rect
                x="8.2"
                y="9.6"
                width="2.6"
                height="12.8"
                rx="1.3"
                fill="#ffb454"
              />
            </svg>
          </div>
          <div
            style={{
              fontSize: 40,
              fontWeight: 700,
              color: "#f1f2f5",
              letterSpacing: -1,
              display: "flex",
            }}
          >
            RLPlayer
          </div>
        </div>

        {/* headline */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              fontSize: 74,
              fontWeight: 700,
              lineHeight: 1.08,
              letterSpacing: -2.6,
              color: "#f1f2f5",
              maxWidth: 900,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <span>The video player</span>
            <span style={{ color: "#ffb454" }}>that leaves you alone.</span>
          </div>
          <div
            style={{
              fontSize: 27,
              color: "#9aa1ae",
              letterSpacing: -0.4,
              display: "flex",
            }}
          >
            No update prompts · No ads · No bundles · No telemetry
          </div>
        </div>

        {/* footer row: fake seek bar + meta */}
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div
            style={{
              width: "100%",
              height: 5,
              borderRadius: 4,
              background: "#22262f",
              display: "flex",
            }}
          >
            <div
              style={{
                width: "41%",
                height: 5,
                borderRadius: 4,
                background: "#ffb454",
                display: "flex",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 23,
              color: "#787f8c",
            }}
          >
            <div style={{ display: "flex" }}>
              Free &amp; open source (MIT) · Windows 10 &amp; 11
            </div>
            <div style={{ display: "flex" }}>rlplayer.vercel.app</div>
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
