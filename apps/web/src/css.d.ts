// Plain `import './x.css'` for TypeScript. next-env.d.ts also provides this, but it is git-ignored
// and only exists after `next dev` or `next build`, so a fresh checkout (CI) would fail to typecheck without it.
declare module '*.css'
