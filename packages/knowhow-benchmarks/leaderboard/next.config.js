/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    return [
      // Canonical URL redirects
      {
        source: '/tbench',
        destination: '/harbor/terminal-bench/terminal-bench-2-1',
        permanent: false,
      },
      {
        source: '/tbench/run',
        destination: '/harbor/terminal-bench/terminal-bench-2-1/run',
        permanent: false,
      },
      {
        source: '/aider',
        destination: '/internal/aider/aider-polyglot',
        permanent: false,
      },
      {
        source: '/harbor/aider/aider-polyglot',
        destination: '/internal/aider/aider-polyglot',
        permanent: false,
      },
      {
        source: '/harbor/aider/aider-polyglot/run',
        destination: '/internal/aider/aider-polyglot/run',
        permanent: false,
      },
      // Old harbor?dataset= query param → canonical path
      // (handled client-side in /harbor/page.tsx, this covers the static case)
    ];
  },
};

module.exports = nextConfig;
