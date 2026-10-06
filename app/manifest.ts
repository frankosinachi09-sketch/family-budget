import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Household Ledger",
    short_name: "Ledger",
    description: "A clear view of your household bills and due dates.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f3f0e7",
    theme_color: "#244dcc",
    icons: [
      {
        src: "/ledger-icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/ledger-icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/ledger-icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}