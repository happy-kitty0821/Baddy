import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the API origin to be configured via environment variable.
  // In development: http://localhost:8000
  // In production: set NEXT_PUBLIC_API_URL
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
