import { defineConfig } from 'vitepress';
import typedocSidebar from '../api/typedoc-sidebar.json';

export default defineConfig({
  title: 'covenix',
  description:
    'Zod-powered decorators for Express APIs — typed routes, runtime validation, and accurate OpenAPI from a single source of truth.',
  // Project Pages serve from https://joeferner.github.io/covenix/
  base: '/covenix/',
  themeConfig: {
    logo: '/logo.png',
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
            { text: 'Route Handlers', link: '/guide/route-handlers' },
            { text: 'Validation & Errors', link: '/guide/validation' },
            { text: 'Authentication', link: '/guide/authentication' },
            { text: 'OpenAPI / Swagger', link: '/guide/swagger' },
            { text: 'Typed Client', link: '/guide/typed-client' },
            { text: 'File Downloads', link: '/guide/file-downloads' },
            { text: 'File Uploads', link: '/guide/file-uploads' },
            { text: 'Server-Sent Events', link: '/guide/server-sent-events' },
            { text: 'Grouping & Versioning', link: '/guide/versioning' },
            { text: 'API Reference', link: '/api/' },
          ],
        },
        {
          text: 'Migrating',
          items: [
            { text: 'From tsoa', link: '/guide/migrating-from-tsoa' },
            { text: 'From NestJS', link: '/guide/migrating-from-nestjs' },
            { text: 'From routing-controllers', link: '/guide/migrating-from-routing-controllers' },
            { text: 'From express-zod-api', link: '/guide/migrating-from-express-zod-api' },
            { text: 'From ts-rest', link: '/guide/migrating-from-ts-rest' },
            { text: 'From Hono OpenAPI', link: '/guide/migrating-from-hono' },
            { text: 'From OpenAPI', link: '/guide/migrating-from-openapi' },
          ],
        },
      ],
      '/api/': [{ text: 'Overview', link: '/api/' }, ...typedocSidebar],
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/joeferner/covenix' }],
    search: { provider: 'local' },
  },
});
