import { defineConfig } from 'vitepress';
import typedocSidebar from '../api/typedoc-sidebar.json';

export default defineConfig({
  title: 'zodec',
  description:
    'Zod-powered decorators for Express APIs — typed routes, runtime validation, and accurate OpenAPI from a single source of truth.',
  // Project Pages serve from https://joeferner.github.io/zodec/
  base: '/zodec/',
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'API', link: '/api/' },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Validation & Errors', link: '/guide/validation' },
            { text: 'OpenAPI / Swagger', link: '/guide/swagger' },
            { text: 'File Downloads', link: '/guide/file-downloads' },
            { text: 'API Reference', link: '/api/' },
          ],
        },
      ],
      '/api/': [{ text: 'Overview', link: '/api/' }, ...typedocSidebar],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/joeferner/zodec' }],
    search: { provider: 'local' },
  },
});
