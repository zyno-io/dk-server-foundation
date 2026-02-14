# Contributing to Documentation

Thank you for contributing to the dk-server-foundation documentation!

## Quick Start

1. **Install dependencies**:
   ```bash
   yarn install
   ```

2. **Start the development server**:
   ```bash
   yarn docs:dev
   ```
   
   This will start a local server with hot reload.

3. **Make your changes** to the Markdown files in the `docs/` directory.

4. **Preview your changes** in the browser - they'll update automatically.

5. **Build to verify** (optional):
   ```bash
   yarn docs:build
   ```

## Adding a New Page

1. Create a new Markdown file in the `docs/` directory (e.g., `docs/my-feature.md`)

2. Add frontmatter if needed:
   ```markdown
   ---
   title: My Feature
   description: Description for SEO
   ---
   
   # My Feature
   
   Content here...
   ```

3. Update the sidebar in `docs/.vitepress/config.mts`:
   ```typescript
   sidebar: [
     {
       text: 'My Section',
       items: [
         { text: 'My Feature', link: '/my-feature' }
       ]
     }
   ]
   ```

## Adding Images

1. Place images in `docs/public/images/` (organize in subdirectories as needed)

2. Reference them in Markdown with an absolute path:
   ```markdown
   ![Alt text](/images/subfolder/image.png)
   ```

## Markdown Features

VitePress supports standard Markdown plus these enhancements:

### Code Blocks with Syntax Highlighting

\```typescript
const app = createApp({
  config: AppConfig
});
\```

### Custom Containers

```markdown
::: tip
This is a tip
:::

::: warning
This is a warning
:::

::: danger
This is a dangerous warning
:::

::: info
This is an info box
:::
```

### Links

- Internal links: `[Getting Started](/getting-started)`
- External links: `[Deepkit](https://deepkit.io)`

### Tables

```markdown
| Feature | Description |
| ------- | ----------- |
| Fast    | Built on Vite |
| Simple  | Just Markdown |
```

## Deployment

Documentation is automatically deployed to GitHub Pages when changes are merged to the `main` branch. The deployment workflow is in `.github/workflows/deploy-docs.yml`.

## Testing Before Commit

1. Build the docs: `yarn docs:build`
2. Preview the build: `yarn docs:preview`
3. Check for:
   - Broken links
   - Missing images
   - Formatting issues
   - Spelling/grammar

## Style Guide

- Use clear, concise language
- Include code examples where helpful
- Add links to related documentation
- Use proper Markdown headings (# for h1, ## for h2, etc.)
- Keep line length reasonable for readability
- Use fenced code blocks with language specifiers

## Questions?

- Check the [VitePress documentation](https://vitepress.dev/)
- Look at existing pages for examples
- Open an issue on GitHub for questions

Thank you for improving our documentation! 🎉
