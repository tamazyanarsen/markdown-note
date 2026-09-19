import type { NextConfig } from "next";

// Сервис лежит в открытом интернете и рендерит чужой markdown,
// поэтому базовые заголовки ставим сразу, а не «потом».
//
// CSP здесь нет намеренно: её nonce обязан быть своим на каждый ответ,
// а заголовки в этом файле статичны. Политика живёт в src/lib/csp.ts,
// а ставит её src/proxy.ts.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  // Нужно для тонкого runtime-образа в Dockerfile (этап 8).
  output: "standalone",

  // pg — нативный модуль, его нельзя бандлить в серверные компоненты.
  serverExternalPackages: ["pg"],

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
