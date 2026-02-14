import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  srcDir: 'content',
  title: "@signal24/dk-server-foundation",
  description: "TypeScript foundation library built on Deepkit for building server applications",
  base: '/dk-server-foundation/',
  
  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Getting Started', link: '/getting-started' },
      { text: 'Guide', link: '/guide/' }
    ],

    sidebar: [
      {
        text: 'Introduction',
        items: [
          { text: 'Getting Started', link: '/getting-started' },
          { text: 'Configuration', link: '/configuration' }
        ]
      },
      {
        text: 'Core',
        items: [
          { text: 'Database', link: '/database' },
          { text: 'HTTP', link: '/http' },
          { text: 'Authentication', link: '/authentication' },
          { text: 'Logging', link: '/logging' },
          { text: 'Health Checks', link: '/health' },
          { text: 'Types', link: '/types' }
        ]
      },
      {
        text: 'Services',
        items: [
          { text: 'Workers', link: '/worker' },
          { text: 'SRPC', link: '/srpc' },
          { text: 'Leader Service', link: '/leader-service' },
          { text: 'Mesh Service', link: '/mesh-service' },
          { text: 'Mail', link: '/mail' }
        ]
      },
      {
        text: 'Utilities',
        items: [
          { text: 'Redis', link: '/redis' },
          { text: 'Helpers', link: '/helpers' },
          { text: 'Telemetry', link: '/telemetry' },
          { text: 'Testing', link: '/testing' },
          { text: 'DevConsole', link: '/devconsole' },
          { text: 'CLI Tools', link: '/cli' }
        ]
      },
      {
        text: 'Guides',
        items: [
          { text: 'Test Migration Guide', link: '/guides/test-migration-guide' }
        ]
      }
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/signal24/dk-server-foundation' }
    ],

    search: {
      provider: 'local'
    },

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present Signal 24'
    }
  }
})
