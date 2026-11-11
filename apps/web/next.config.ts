import type { NextConfig } from "next";

// Statischer Export – wird vom API-Service unter / ausgeliefert (gleicher Origin, keine Cookies über Domains)
const config: NextConfig = {
  output: "export",
  trailingSlash: false,
  images: { unoptimized: true },
  // Entwicklung: API-Aufrufe an den lokalen API-Server weiterleiten
  ...(process.env.NODE_ENV === "development"
    ? { rewrites: async () => [{ source: "/api/:path*", destination: "http://localhost:8080/api/:path*" }] }
    : {}),
};
export default config;
