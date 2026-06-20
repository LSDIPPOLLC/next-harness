# Documentation site

This folder is a [Jekyll](https://jekyllrb.com/) site using the
[just-the-docs](https://just-the-docs.com/) theme, served via GitHub Pages.
It is **not** part of the harness runtime.

## Deploy to GitHub Pages (no Action required)

GitHub Pages can build this folder natively — the `jekyll-remote-theme` plugin
that pulls in just-the-docs is on the Pages allow-list, so you don't need a
custom workflow.

1. Push the repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: _Deploy from a branch_.**
3. Set **Branch: `main`** and **Folder: `/docs`**, then **Save**.
4. Wait for the build; your site appears at
   `https://<user>.github.io/<repo>/`.

### One config edit for project sites

A project site is served under a subpath (`/<repo>/`). Set that in
[`_config.yml`](_config.yml) so links and assets resolve:

```yaml
baseurl: "/next-harness"   # match your repo name; leave "" for a user/org site
```

## Local preview

```bash
cd docs
bundle install
bundle exec jekyll serve   # → http://127.0.0.1:4000
```

(Requires Ruby + Bundler. The `Gemfile` here pins `github-pages` so local builds
match what GitHub Pages produces.)

## Pages

| File | Page |
|------|------|
| `index.md` | Home |
| `getting-started.md` | Onboarding into Claude Code |
| `concepts.md` | Loops, threads, state, guards, primitives |
| `cli-reference.md` | Every command + flag |
| `recipes.md` | End-to-end walkthroughs |
| `architecture.md` | Module map + extension points |
| `spec-gaps.md` | Spec mapping & gap analysis |
| `original-spec.md` | The verbatim source spec |
